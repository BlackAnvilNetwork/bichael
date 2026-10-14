//! In-memory per-character logs the game server drives.
//!
//! Commands are one JSON object. A rejected command does not append.
//! `open` replays a character-log document and stops at the first bad hash.
//! An empty legacy `{"type":"world","entries":[]}` file still opens.

use serde_json::{json, Value};

use crate::chain::{input_to_json, load_world, parse_input, parse_world_log, replay_stop_message};
use crate::engine::EngineError;
use crate::event::Input;
use crate::u256::U256;
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
        if op == "undoWithdraw" {
            return undo_withdraw(&mut self.world, &value);
        }
        if op == "withdrawCount" {
            return withdraw_count_json(&self.world, &value);
        }
        let value = if op == "fill" || op == "buy" {
            match resolve_buy(&self.world, value, op == "fill") {
                Ok(v) => v,
                Err(err) => return fail(&err),
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
            Err(err) => fail(&engine_error(&err)),
        }
    }
}

fn dec_field(value: &Value, key: &str) -> Result<U256, String> {
    let raw = value.get(key).and_then(|v| v.as_str()).ok_or_else(|| format!("missing {key}"))?;
    U256::parse_dec(raw).map_err(|_| format!("bad {key}"))
}

/// A buy names an item. The engine selects the cheapest ask and sets the price to that ask.
/// A fill may name a maximum. The recorded amount is rewritten to the ask so the buyer cannot overpay.
fn resolve_buy(world: &World, value: Value, capped: bool) -> Result<Value, String> {
    let bidder = dec_field(&value, "bidder")?;
    let item_id = dec_field(&value, "itemId")?;
    let chosen = if capped {
        let amount = dec_field(&value, "amount")?;
        world.choose_ask(bidder, item_id, amount).map_err(|err| err.to_string())?
    } else {
        world.choose_lowest_ask(bidder, item_id).map_err(|err| err.to_string())?
    };
    let mut value = value;
    let obj = value.as_object_mut().ok_or_else(|| "command must be an object".to_string())?;
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
            None => return fail("character is not spawned"),
        },
    };
    let to_index = match world.character_len(&token) {
        Some(n) => n,
        None => return fail("character is not spawned"),
    };
    match world.checkpoint_covering(&token, from_index, to_index) {
        Ok(c) => json!({
            "ok": true,
            "prevRoot": hex32(&c.prev_root),
            "newRoot": hex32(&c.new_root),
            "fromIndex": c.from_index.to_string(),
            "toIndex": c.to_index.to_string(),
            "logHash": hex32(&c.log_hash),
            "summary": c.summary.to_dec(),
            "inboundConsumed": c.inbound_consumed.to_string(),
            "kekOut": c.kek_out.to_dec(),
        }).to_string(),
        Err(err) => fail(&err.to_string()),
    }
}


fn withdraw_count_json(world: &World, value: &Value) -> String {
    let token = match dec_field(value, "tokenId") {
        Ok(v) => v,
        Err(err) => return fail(&err),
    };
    let amount = match dec_field(value, "amount") {
        Ok(v) => v,
        Err(err) => return fail(&err),
    };
    json!({ "ok": true, "count": world.withdraw_count(token, amount) }).to_string()
}

fn undo_withdraw(world: &mut World, value: &Value) -> String {
    let token = match dec_field(value, "tokenId") {
        Ok(v) => v,
        Err(err) => return fail(&err),
    };
    let amount = match dec_field(value, "amount") {
        Ok(v) => v,
        Err(err) => return fail(&err),
    };
    match world.undo_last_withdraw(token, amount) {
        Ok(()) => ok_state(world),
        Err(err) => fail(&err.to_string()),
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
    json!({
        "seq": entry.seq,
        "hash": hex32(&entry.hash),
        "input": input_to_json(&entry.input),
    })
}

fn hex32(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn self_log_len(world: &World, token_id: &U256) -> u64 {
    world.character_len(token_id).unwrap_or(0)
}

fn engine_error(err: &EngineError) -> String {
    err.to_string()
}

fn fail(message: &str) -> String {
    json!({ "ok": false, "error": message }).to_string()
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
            "kek": snap.kek.to_dec(),
            "solvencyKek": snap.solvency_kek.to_dec(),
            "gold": snap.gold.to_dec(),
            "vaultClaim": world.vault_claim(&snap.token_id).unwrap_or(crate::u256::U256::ZERO).to_dec(),
            "sunkKek": world.sunk_kek(&snap.token_id).unwrap_or(crate::u256::U256::ZERO).to_dec(),
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

        assert!(apply(&mut gate, r#"{"op":"depositKek","tokenId":"2","amount":"9","nonce":"1"}"#)["ok"].as_bool().unwrap());
        assert!(apply(&mut gate, r#"{"op":"list","listingId":"1","seller":"1","itemId":"7","amount":"1"}"#)["ok"].as_bool().unwrap());
        let low = apply(&mut gate, r#"{"op":"bid","listingId":"1","bidder":"2","amount":"3"}"#);
        assert_eq!(low["ok"], true);
        let not_higher = apply(&mut gate, r#"{"op":"bid","listingId":"1","bidder":"2","amount":"2"}"#);
        assert_eq!(not_higher["ok"], false);
        assert_eq!(gate.len(), before + 3);
        let higher = apply(&mut gate, r#"{"op":"bid","listingId":"1","bidder":"2","amount":"5"}"#);
        assert_eq!(higher["ok"], true);
        let not_seller = apply(&mut gate, r#"{"op":"cancel","listingId":"1","seller":"2"}"#);
        assert_eq!(not_seller["ok"], false);
        let settled = apply(&mut gate, r#"{"op":"settle","listingId":"1"}"#);
        assert_eq!(settled["ok"], true);

        let doc = gate.document_json();
        let again = Gate::open(&doc).unwrap();
        let state = apply_state(&again);
        let chars = state["state"]["characters"].as_array().unwrap();
        let a = chars.iter().find(|c| c["tokenId"] == "1").unwrap();
        let b = chars.iter().find(|c| c["tokenId"] == "2").unwrap();
        assert_eq!(a["kek"], "5");
        assert_eq!(b["kek"], "4");
        assert!(a["items"].as_array().unwrap().is_empty());
        assert_eq!(b["items"][0]["itemId"], "7");
        assert_eq!(b["items"][0]["amount"], "3");
        assert!(state["state"]["listings"].as_array().unwrap().is_empty());
    }

    fn apply_state(gate: &Gate) -> serde_json::Value {
        let mut cloned = Gate {
            world: gate.world.clone(),
        };
        serde_json::from_str(&cloned.apply_command(r#"{"op":"state"}"#)).unwrap()
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