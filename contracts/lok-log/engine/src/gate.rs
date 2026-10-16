//! In-memory per-character logs the game server drives.
//!
//! Commands are one JSON object. A rejected command does not append.
//! `open` replays a character-log document and stops at the first bad hash.
//! An empty legacy `{"type":"world","entries":[]}` file still opens.

use serde_json::{json, Value};

use crate::chain::{input_to_json, load_world, parse_input, parse_world_log, replay_stop_message};
use crate::engine::EngineError;
use crate::event::Input;
use crate::u256::{parse_b256, U256};
use crate::world::World;

pub struct Gate {
    world: World,
}

impl Gate {
    /// Empty text opens a fresh world. Any other text must be per-character logs.
    /// A bad hash is not applied, and the gate refuses to open.
    pub fn open(text: &str) -> Result<Self, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Self { world: World::new() });
        }
        let doc = parse_world_log(trimmed)?;
        let world = load_world(&doc).map_err(|stop| replay_stop_message(&stop))?;
        Ok(Self { world })
    }

    pub fn len(&self) -> u64 {
        self.world.len()
    }

    /// Character-root tree of the open world. Empty when no character has spawned.
    pub fn character_root_tree_root(&self) -> [u8; 32] {
        self.world.character_root_tree_root()
    }

    pub fn document_json(&self) -> String {
        let characters: Vec<Value> = self.world.to_document().characters.into_iter().map(|character| {
            let entries: Vec<Value> = character.entries.iter().map(entry_json).collect();
            json!({
                "tokenId": character.token_id.to_dec(),
                "startingJob": character.starting_job,
                "entries": entries,
            })
        }).collect();
        serde_json::to_string_pretty(&json!({
            "type": "characters",
            "characters": characters,
        }))
        .unwrap_or_else(|_| "{\"type\":\"characters\",\"characters\":[]}".to_string())
    }

    /// Apply one command. Engine rejection returns `{"ok":false,...}` and does not append.
    pub fn apply_command(&mut self, text: &str) -> String {
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(err) => return fail(&format!("bad json: {err}")),
        };
        let op = match value.get("op").and_then(|v| v.as_str()) {
            Some(op) => op.to_string(),
            None => return fail("missing op"),
        };
        if op == "state" {
            return ok_state(&self.world);
        }
        if op == "checkpoint" {
            return checkpoint_json(&self.world, &value);
        }
        if op == "beginBatch" {
            let batch_id = match value.get("batchId") {
                Some(v) => match v.as_u64() {
                    Some(n) => n,
                    None => match v.as_str().and_then(|s| s.parse::<u64>().ok()) {
                        Some(n) => n,
                        None => return fail("bad batchId"),
                    },
                },
                None => return fail("missing batchId"),
            };
            self.world.begin_batch(batch_id);
            return json!({ "ok": true }).to_string();
        }
        if op == "setRuleset" {
            let raw = value.get("rulesetHash").and_then(|v| v.as_str()).unwrap_or("");
            let hash = match parse_b256(raw) {
                Ok(hash) => hash,
                Err(()) => return fail("bad rulesetHash"),
            };
            self.world.set_ruleset_hash(hash);
            return json!({ "ok": true, "rulesetHash": hex32(&hash) }).to_string();
        }
        if op == "undoWithdraw" || op == "withdrawCount" || op == "depositKek" || op == "withdrawKek" || op == "spendKek" || op == "sendKek" || op == "paidRespecSkills" {
            return fail_engine(&EngineError::KekRetired);
        }
        let value = if op == "fill" || op == "buy" {
            match resolve_buy(&self.world, value, op == "fill") {
                Ok(v) => v,
                Err(err) => return reject(err),
            }
        } else {
            value
        };
        let input = match command_to_input(&value, &op) {
            Ok(input) => input,
            Err(err) => return fail(&err),
        };
        match self.world.apply(input.clone()) {
            Ok(event) => {
                let links: Vec<Value> = event.links.iter().map(|link| json!({
                    "tokenId": link.token_id.to_dec(),
                    "index": link.index,
                    "hash": hex32(&link.entry_hash),
                })).collect();
                let mut body = state_body(&self.world);
                body.insert("ok".into(), json!(true));
                body.insert("seq".into(), json!(event.seq));
                body.insert("links".into(), json!(links));
                body.insert("entry".into(), json!({ "seq": event.seq, "links": links }));
                serde_json::to_string(&Value::Object(body)).unwrap_or_else(|_| fail("encode"))
            }
            Err(err) => fail_engine(&err),
        }
    }
}

fn dec_field(value: &Value, key: &str) -> Result<U256, String> {
    let raw = value.get(key).and_then(|v| v.as_str()).ok_or_else(|| format!("missing {key}"))?;
    U256::parse_dec(raw).map_err(|_| format!("bad {key}"))
}

/// A buy names an item. The engine selects the cheapest ask and sets the price to that ask.
/// A fill may name a maximum. The recorded amount is rewritten to the ask so the buyer cannot overpay.
fn resolve_buy(world: &World, value: Value, capped: bool) -> Result<Value, Reject> {
    let bidder = dec_field(&value, "bidder").map_err(Reject::Message)?;
    let item_id = dec_field(&value, "itemId").map_err(Reject::Message)?;
    let chosen = if capped {
        let amount = dec_field(&value, "amount").map_err(Reject::Message)?;
        world.choose_ask(bidder, item_id, amount).map_err(Reject::Engine)?
    } else {
        world.choose_lowest_ask(bidder, item_id).map_err(Reject::Engine)?
    };
    let mut value = value;
    let obj = value.as_object_mut().ok_or_else(|| Reject::Message("command must be an object".to_string()))?;
    obj.insert("listingId".to_string(), Value::String(chosen.id.to_dec()));
    if capped {
        obj.insert("amount".to_string(), Value::String(chosen.min_price.to_dec()));
    }
    Ok(value)
}

fn checkpoint_json(world: &World, value: &Value) -> String {
    let token = match dec_field(value, "tokenId") {
        Ok(v) => v,
        Err(err) => return fail(&err),
    };
    let from_index = match value.get("fromIndex").and_then(|v| v.as_str()).map(|s| s.parse::<u64>()) {
        Some(Ok(n)) => n,
        Some(Err(_)) => return fail("bad fromIndex"),
        None => match world.committed_index(&token) {
            Some(n) => n,
            None => return fail_engine(&EngineError::NotSpawned),
        },
    };
    let to_index = match world.character_len(&token) {
        Some(n) => n,
        None => return fail_engine(&EngineError::NotSpawned),
    };
    match world.checkpoint_covering(&token, from_index, to_index) {
        Ok(c) => {
            let exports: Vec<Value> = c
                .exports
                .iter()
                .map(|export| {
                    json!({
                        "itemId": export.item_id.to_dec(),
                        "amount": export.amount,
                    })
                })
                .collect();
            json!({
                "ok": true,
                "prevRoot": hex32(&c.prev_root),
                "newRoot": hex32(&c.new_root),
                "fromIndex": c.from_index.to_string(),
                "toIndex": c.to_index.to_string(),
                "logHash": hex32(&c.log_hash),
                "rulesetHash": hex32(&c.ruleset_hash),
                "summary": c.summary.to_dec(),
                "inboundConsumed": c.inbound_consumed.to_string(),
                "exports": exports,
            })
            .to_string()
        }
        Err(err) => fail_engine(&err),
    }
}


fn command_to_input(value: &Value, op: &str) -> Result<Input, String> {
    let mut obj = value
        .as_object()
        .cloned()
        .ok_or_else(|| "command must be an object".to_string())?;
    obj.remove("op");
    obj.insert("type".to_string(), Value::String(op.to_string()));
    parse_input(&Value::Object(obj))
}

fn entry_json(entry: &crate::chain::LoggedEntry) -> Value {
    let mut value = json!({
        "seq": entry.seq,
        "hash": hex32(&entry.hash),
        "input": input_to_json(&entry.input),
    });
    if entry.ruleset_hash != [0u8; 32] {
        value["rulesetHash"] = Value::String(hex32(&entry.ruleset_hash));
    }
    value
}

fn hex32(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn self_log_len(world: &World, token_id: &U256) -> u64 {
    world.character_len(token_id).unwrap_or(0)
}

enum Reject {
    Message(String),
    Engine(EngineError),
}

fn reject(err: Reject) -> String {
    match err {
        Reject::Message(message) => fail(&message),
        Reject::Engine(err) => fail_engine(&err),
    }
}

fn fail(message: &str) -> String {
    json!({ "ok": false, "error": message }).to_string()
}

fn fail_engine(err: &EngineError) -> String {
    json!({ "ok": false, "error": err.to_string(), "code": err.code() }).to_string()
}

fn ok_state(world: &World) -> String {
    let mut body = state_body(world);
    body.insert("ok".into(), json!(true));
    serde_json::to_string(&Value::Object(body)).unwrap_or_else(|_| fail("encode"))
}

fn state_body(world: &World) -> serde_json::Map<String, Value> {
    let mut characters = Vec::new();
    for snap in world.snapshots() {
        let items: Vec<Value> = world
            .spendable_items(&snap.token_id)
            .into_iter()
            .map(|(item_id, amount)| {
                json!({
                    "itemId": item_id.to_dec(),
                    "amount": amount.to_dec(),
                })
            })
            .collect();
        let abilities: Vec<Value> = world.abilities_of(&snap.token_id).into_iter().map(Value::String).collect();
        let crafts: Vec<Value> = world
            .crafts_of(&snap.token_id)
            .into_iter()
            .map(|(item_id, amount)| json!({"itemId": item_id.to_dec(), "amount": amount.to_dec()}))
            .collect();
        let drops: Vec<Value> = world
            .drops_of(&snap.token_id)
            .into_iter()
            .map(|(item_id, amount)| json!({"itemId": item_id.to_dec(), "amount": amount.to_dec()}))
            .collect();
        let harvests: Vec<Value> = world
            .harvests_of(&snap.token_id)
            .into_iter()
            .map(|(material_id, amount)| json!({"materialId": material_id, "amount": amount.to_dec()}))
            .collect();
        let craft_skills: Vec<Value> = world
            .craft_skills_of(&snap.token_id)
            .into_iter()
            .map(|(skill_id, level)| json!({"skillId": skill_id, "level": level}))
            .collect();
        characters.push(json!({
            "tokenId": snap.token_id.to_dec(),
            "gold": snap.gold.to_dec(),
            "inboundApplied": world.inbound_applied(&snap.token_id).unwrap_or(0),
            "level": world.level(&snap.token_id).unwrap_or(0),
            "abilities": abilities,
            "crafts": crafts,
            "craftSkills": craft_skills,
            "harvests": harvests,
            "drops": drops,
            "inbox": world.inbox_of(&snap.token_id).into_iter().map(|(item_id, amount)| json!({"itemId": item_id.to_dec(), "amount": amount.to_dec()})).collect::<Vec<_>>(),
            "droppedSkills": world.dropped_skills_of(&snap.token_id),
            "logLen": self_log_len(world, &snap.token_id),
            "logHead": hex32(&world.character_head(&snap.token_id).unwrap_or([0u8; 32])),
            "items": items,
        }));
    }
    let mut listings = Vec::new();
    for listing in world.listings() {
        listings.push(json!({
            "id": listing.id.to_dec(),
            "seller": listing.seller.to_dec(),
            "itemId": listing.item_id.to_dec(),
            "amount": listing.amount.to_dec(),
            "highBidder": listing.high_bidder.map(|id| id.to_dec()),
            "highBid": listing.high_bid.to_dec(),
            "minPrice": listing.min_price.to_dec(),
            "listedAt": listing.listed_at,
            "book": listing.book,
        }));
    }
    let mut pvp_bounties = Vec::new();
    for (token_id, bounty) in world.pvp_bounties() {
        pvp_bounties.push(json!({
            "tokenId": token_id.to_dec(),
            "amountWei": bounty.amount_wei.to_dec(),
            "areaId": bounty.area_id,
        }));
    }
    let mut map = serde_json::Map::new();
    map.insert("len".to_string(), json!(world.len()));
    map.insert("head".to_string(), json!(hex32(&world.head())));
    map.insert(
        "state".to_string(),
        json!({
            "characters": characters,
            "listings": listings,
            "pvpBounties": pvp_bounties,
        }),
    );
    map
}

#[cfg(test)]
mod tests {
    use super::Gate;
    use crate::engine::EngineError;

    fn apply(gate: &mut Gate, cmd: &str) -> serde_json::Value {
        serde_json::from_str(&gate.apply_command(cmd)).expect("json")
    }

    #[test]
    fn transfer_and_settle_round_trip() {
        let mut gate = Gate::open("").unwrap();
        assert!(apply(&mut gate, r#"{"op":"spawn","tokenId":"1","startingJob":0}"#)["ok"].as_bool().unwrap());
        assert!(apply(&mut gate, r#"{"op":"spawn","tokenId":"2","startingJob":1}"#)["ok"].as_bool().unwrap());
        assert!(apply(&mut gate, r#"{"op":"importItem","tokenId":"1","itemId":"7","amount":"3","nonce":"1"}"#)["ok"].as_bool().unwrap());
        let sent = apply(&mut gate, r#"{"op":"sendItem","from":"1","to":"2","itemId":"7","amount":"2"}"#);
        assert_eq!(sent["ok"], true);
        let before = gate.len();
        let rejected = apply(&mut gate, r#"{"op":"sendItem","from":"1","to":"1","itemId":"7","amount":"1"}"#);
        assert_eq!(rejected["ok"], false);
        assert!(rejected["error"].as_str().unwrap().contains("self"));
        assert_eq!(gate.len(), before);
        let short = apply(&mut gate, r#"{"op":"sendItem","from":"1","to":"2","itemId":"7","amount":"5"}"#);
        assert_eq!(short["ok"], false);
        assert_eq!(gate.len(), before);

        let retired = apply(&mut gate, r#"{"op":"depositKek","tokenId":"2","amount":"9","nonce":"1"}"#);
        assert_eq!(retired["ok"], false);
        assert!(apply(&mut gate, r#"{"op":"list","listingId":"1","seller":"1","itemId":"7","amount":"1"}"#)["ok"].as_bool().unwrap());
        let bid = apply(&mut gate, r#"{"op":"bid","listingId":"1","bidder":"2","amount":"3"}"#);
        assert_eq!(bid["ok"], false);
        let not_seller = apply(&mut gate, r#"{"op":"cancel","listingId":"1","seller":"2"}"#);
        assert_eq!(not_seller["ok"], false);
        assert!(apply(&mut gate, r#"{"op":"cancel","listingId":"1","seller":"1"}"#)["ok"].as_bool().unwrap());

        let doc = gate.document_json();
        let again = Gate::open(&doc).unwrap();
        let state = apply_state(&again);
        let chars = state["state"]["characters"].as_array().unwrap();
        let a = chars.iter().find(|c| c["tokenId"] == "1").unwrap();
        let b = chars.iter().find(|c| c["tokenId"] == "2").unwrap();
        assert!(a.get("kek").is_none());
        assert_eq!(a["items"][0]["itemId"], "7");
        assert_eq!(a["items"][0]["amount"], "1");
        assert_eq!(b["items"][0]["itemId"], "7");
        assert_eq!(b["items"][0]["amount"], "2");
        assert!(state["state"]["listings"].as_array().unwrap().is_empty());
    }

    fn apply_state(gate: &Gate) -> serde_json::Value {
        let mut cloned = Gate {
            world: gate.world.clone(),
        };
        serde_json::from_str(&cloned.apply_command(r#"{"op":"state"}"#)).unwrap()
    }

    #[test]
    fn checkpoint_stamps_the_ruleset_and_lists_exports() {
        let mut gate = Gate::open("").unwrap();
        assert!(apply(&mut gate, r#"{"op":"spawn","tokenId":"1","startingJob":3}"#)["ok"].as_bool().unwrap());
        let bare = apply(&mut gate, r#"{"op":"checkpoint","tokenId":"1","fromIndex":"0"}"#);
        assert_eq!(bare["ok"], true);
        assert_eq!(
            bare["rulesetHash"],
            "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
        assert!(bare["exports"].as_array().unwrap().is_empty());

        let hash = "0x1111111111111111111111111111111111111111111111111111111111111111";
        let bad = apply(&mut gate, r#"{"op":"setRuleset","rulesetHash":"0x1234"}"#);
        assert_eq!(bad["ok"], false);
        assert!(apply(&mut gate, &format!(r#"{{"op":"setRuleset","rulesetHash":"{hash}"}}"#))["ok"].as_bool().unwrap());
        assert!(apply(&mut gate, r#"{"op":"importItem","tokenId":"1","itemId":"7","amount":"2","nonce":"1"}"#)["ok"].as_bool().unwrap());
        assert!(apply(&mut gate, r#"{"op":"exportItem","tokenId":"1","itemId":"7","amount":"2"}"#)["ok"].as_bool().unwrap());
        let stamped = apply(&mut gate, r#"{"op":"checkpoint","tokenId":"1","fromIndex":"0"}"#);
        assert_eq!(stamped["rulesetHash"], hash);
        assert_eq!(stamped["exports"][0]["itemId"], "7");
        assert_eq!(stamped["exports"][0]["amount"], 2);

        let mut again = Gate::open(&gate.document_json()).unwrap();
        let reopened = apply(&mut again, r#"{"op":"checkpoint","tokenId":"1","fromIndex":"0"}"#);
        assert_eq!(
            reopened["rulesetHash"],
            "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
        assert_eq!(reopened["exports"][0]["itemId"], "7");
    }

    #[test]
    fn rejected_apply_keeps_the_message_and_a_stable_code() {
        assert_eq!(EngineError::ZeroAmount.code(), 5);
        assert_eq!(EngineError::ClosedMint.code(), 35);
        assert_ne!(EngineError::ZeroAmount.code(), EngineError::ClosedMint.code());

        let mut gate = Gate::open("").unwrap();
        assert!(apply(&mut gate, r#"{"op":"spawn","tokenId":"1","startingJob":0}"#)["ok"].as_bool().unwrap());
        assert!(apply(&mut gate, r#"{"op":"spawn","tokenId":"2","startingJob":0}"#)["ok"].as_bool().unwrap());
        let before = gate.len();

        let zero = apply(&mut gate, r#"{"op":"sendItem","from":"1","to":"2","itemId":"7","amount":"0"}"#);
        assert_eq!(zero["ok"], false);
        assert_eq!(zero["error"], "amount must be greater than zero");
        assert_eq!(zero["code"], serde_json::json!(EngineError::ZeroAmount.code()));

        let closed = apply(&mut gate, r#"{"op":"itemDrop","tokenId":"1","itemId":"7","amount":"1"}"#);
        assert_eq!(closed["ok"], false);
        assert_eq!(closed["error"], "item drop cannot mint");
        assert_eq!(closed["code"], serde_json::json!(EngineError::ClosedMint.code()));
        assert_eq!(gate.len(), before);
    }

    #[test]
    fn bad_hash_refuses_to_open() {
        let mut gate = Gate::open("").unwrap();
        apply(&mut gate, r#"{"op":"spawn","tokenId":"1","startingJob":0}"#);
        let mut doc: serde_json::Value = serde_json::from_str(&gate.document_json()).unwrap();
        doc["characters"][0]["entries"][0]["hash"] = serde_json::json!("0x0000000000000000000000000000000000000000000000000000000000000000");
        match Gate::open(&doc.to_string()) {
            Err(err) => assert!(err.contains("bad hash"), "{err}"),
            Ok(_) => panic!("bad hash was applied"),
        }
    }
}