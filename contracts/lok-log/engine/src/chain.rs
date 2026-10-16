//! Hash-chained log and the replay that stops at the first bad link.

use crate::engine::{Engine, EngineError};
use crate::event::{entry_hash, Input};
use crate::u256::{parse_b256, U256};
use crate::world::{CharacterSnapshot, World};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub index: u64,
    pub prev_hash: [u8; 32],
    pub hash: [u8; 32],
    pub input: Input,
    /// Ruleset word that was inside this link. Not rewritten when the live ruleset changes.
    pub ruleset_hash: [u8; 32],
}

#[derive(Clone, Debug)]
pub struct Chain {
    head: [u8; 32],
    entries: Vec<Entry>,
}

impl Chain {
    pub fn new(genesis: [u8; 32]) -> Self {
        Self {
            head: genesis,
            entries: Vec::new(),
        }
    }

    pub fn head(&self) -> [u8; 32] {
        self.head
    }

    pub fn len(&self) -> u64 {
        self.entries.len() as u64
    }

    pub fn push(&mut self, input: Input, hash: [u8; 32], ruleset_hash: [u8; 32]) {
        let index = self.len();
        let prev_hash = self.head;
        self.entries.push(Entry {
            index,
            prev_hash,
            hash,
            input,
            ruleset_hash,
        });
        self.head = hash;
    }

    /// Drop the last link and restore the previous head. Used to undo a withdraw that never queued.
    pub fn pop(&mut self) -> Option<[u8; 32]> {
        let entry = self.entries.pop()?;
        self.head = entry.prev_hash;
        Some(entry.hash)
    }

    pub(crate) fn entries(&self) -> &[Entry] {
        &self.entries
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogDocument {
    pub token_id: U256,
    pub starting_job: u8,
    pub entries: Vec<LoggedEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoggedEntry {
    pub hash: [u8; 32],
    pub input: Input,
    /// Global order shared by every character log that carries this payload. Not part of the hash.
    pub seq: u64,
    /// Ruleset word inside `hash`. Absent JSON means 32 zero bytes, which is still in the preimage.
    pub ruleset_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayReport {
    pub entries: u64,
    pub head: [u8; 32],
    pub state_root: [u8; 32],
    pub summary: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayStop {
    BadHash {
        index: u64,
        expected: [u8; 32],
        computed: [u8; 32],
    },
    Rejected {
        index: u64,
        reason: EngineError,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterLogDocument {
    pub token_id: U256,
    pub starting_job: u8,
    pub entries: Vec<LoggedEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldDocument {
    pub characters: Vec<CharacterLogDocument>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldReplayReport {
    pub entries: u64,
    pub head: [u8; 32],
    pub characters: Vec<CharacterSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AnyLog {
    Character(LogDocument),
    World(WorldDocument),
}

/// Replay `doc` from the genesis anchor. On a hash mismatch, return immediately:
/// that event is not applied, and later events are not inspected.
pub fn replay(doc: &LogDocument) -> Result<ReplayReport, ReplayStop> {
    let mut engine = Engine::open(doc.token_id, doc.starting_job);
    for (i, entry) in doc.entries.iter().enumerate() {
        let index = i as u64;
        engine.set_ruleset_hash(entry.ruleset_hash);
        let computed = entry_hash(&engine.head(), index, &entry.input, &engine.ruleset_hash());
        if computed != entry.hash {
            return Err(ReplayStop::BadHash {
                index,
                expected: entry.hash,
                computed,
            });
        }
        engine
            .replay_logged(entry.input.clone(), entry.seq)
            .map_err(|reason| ReplayStop::Rejected { index, reason })?;
    }
    Ok(ReplayReport {
        entries: engine.len(),
        head: engine.head(),
        state_root: engine.state().root(),
        summary: engine.state().summary(),
    })
}

/// Replay per-character logs. A bad hash is not applied, and later events are not inspected.
pub fn load_world(doc: &WorldDocument) -> Result<World, ReplayStop> {
    World::load(doc)
}

/// Replay per-character logs. A bad hash is not applied, and later events are not inspected.
pub fn replay_world(doc: &WorldDocument) -> Result<WorldReplayReport, ReplayStop> {
    let world = load_world(doc)?;
    Ok(WorldReplayReport {
        entries: world.len(),
        head: world.head(),
        characters: world.snapshots(),
    })
}

pub(crate) fn replay_stop_message(stop: &ReplayStop) -> String {
    match stop {
        ReplayStop::BadHash { index, expected, computed } => format!(
            "bad hash at {index}: log has 0x{} computed 0x{}",
            hex::encode(expected),
            hex::encode(computed)
        ),
        ReplayStop::Rejected { index, reason } => format!("rejected at {index}: {reason}"),
    }
}

pub fn parse_log(text: &str) -> Result<LogDocument, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let token_id = value
        .get("tokenId")
        .ok_or_else(|| "missing tokenId".to_string())
        .and_then(parse_u256_json)?;
    let starting_job = value
        .get("startingJob")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "missing startingJob".to_string())?;
    if starting_job > u64::from(u8::MAX) {
        return Err("startingJob out of range".to_string());
    }
    let entries = parse_entries(&value, false)?;
    Ok(LogDocument {
        token_id,
        starting_job: starting_job as u8,
        entries,
    })
}

pub fn parse_world_log(text: &str) -> Result<WorldDocument, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    match value.get("type").and_then(|v| v.as_str()) {
        Some("characters") => parse_characters(&value),
        Some("world") => {
            let entries = value.get("entries").and_then(|v| v.as_array()).ok_or_else(|| "missing entries".to_string())?;
            if entries.is_empty() {
                Ok(WorldDocument { characters: Vec::new() })
            } else {
                Err("legacy world log cannot be split into per-character checkpoints".to_string())
            }
        }
        _ => Err("not a character-log document".to_string()),
    }
}

fn parse_characters(value: &serde_json::Value) -> Result<WorldDocument, String> {
    let arr = value
        .get("characters")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "missing characters".to_string())?;
    let mut characters = Vec::with_capacity(arr.len());
    for (i, ch) in arr.iter().enumerate() {
        let token_id = req_u256(ch, "tokenId").map_err(|e| format!("character {i}: {e}"))?;
        let starting_job = ch
            .get("startingJob")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| format!("character {i} missing startingJob"))?;
        if starting_job > u64::from(u8::MAX) {
            return Err(format!("character {i} startingJob out of range"));
        }
        let entries = parse_entries(ch, true).map_err(|e| format!("character {i}: {e}"))?;
        characters.push(CharacterLogDocument {
            token_id,
            starting_job: starting_job as u8,
            entries,
        });
    }
    Ok(WorldDocument { characters })
}

pub fn parse_any_log(text: &str) -> Result<AnyLog, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    match value.get("type").and_then(|v| v.as_str()) {
        Some("characters") | Some("world") => Ok(AnyLog::World(parse_world_log(text)?)),
        _ => Ok(AnyLog::Character(parse_log(text)?)),
    }
}

fn parse_entries(value: &serde_json::Value, require_seq: bool) -> Result<Vec<LoggedEntry>, String> {
    let arr = value
        .get("entries")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "missing entries".to_string())?;
    let mut entries = Vec::with_capacity(arr.len());
    for (i, ent) in arr.iter().enumerate() {
        let hash_str = ent
            .get("hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("entry {i} missing hash"))?;
        let hash = parse_b256(hash_str).map_err(|_| format!("entry {i} bad hash"))?;
        let input_v = ent
            .get("input")
            .ok_or_else(|| format!("entry {i} missing input"))?;
        let input = parse_input(input_v).map_err(|e| format!("entry {i}: {e}"))?;
        let seq = if let Some(n) = ent.get("seq").and_then(|v| v.as_u64()) {
            n
        } else if require_seq {
            return Err(format!("entry {i} missing seq"));
        } else {
            i as u64
        };
        let ruleset_hash = if ent.get("rulesetHash").is_none() {
            [0u8; 32]
        } else {
            req_b256(ent, "rulesetHash").map_err(|e| format!("entry {i}: {e}"))?
        };
        entries.push(LoggedEntry { hash, input, seq, ruleset_hash });
    }
    Ok(entries)
}

fn req_label(value: &serde_json::Value, key: &str) -> Result<String, String> {
    let raw = value.get(key).and_then(|v| v.as_str()).ok_or_else(|| format!("missing {key}"))?;
    if raw.is_empty() || raw.len() > 128 || !raw.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Err(format!("bad {key}"));
    }
    Ok(raw.to_string())
}

fn req_u64(value: &serde_json::Value, key: &str) -> Result<u64, String> {
    let raw = value.get(key).ok_or_else(|| format!("missing {key}"))?;
    if let Some(n) = raw.as_u64() {
        return Ok(n);
    }
    if let Some(s) = raw.as_str() {
        return s.parse::<u64>().map_err(|_| format!("bad {key}"));
    }
    Err(format!("bad {key}"))
}

fn req_u256(value: &serde_json::Value, key: &str) -> Result<U256, String> {
    value
        .get(key)
        .ok_or_else(|| format!("missing {key}"))
        .and_then(parse_u256_json)
}

fn req_b256(value: &serde_json::Value, key: &str) -> Result<[u8; 32], String> {
    let raw = value
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing {key}"))?;
    let hexbody = raw
        .strip_prefix("0x")
        .or_else(|| raw.strip_prefix("0X"))
        .unwrap_or(raw);
    if hexbody.len() != 64 || !hexbody.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("bad {key}"));
    }
    parse_b256(hexbody).map_err(|_| format!("bad {key}"))
}

pub(crate) fn parse_input(value: &serde_json::Value) -> Result<Input, String> {
    let kind = value
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "input missing type".to_string())?;
    match kind {
        "spawn" => {
            let token_id = req_u256(value, "tokenId")?;
            let starting_job = value
                .get("startingJob")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "spawn missing startingJob".to_string())?;
            if starting_job > u64::from(u8::MAX) {
                return Err("spawn startingJob out of range".to_string());
            }
            Ok(Input::Spawn {
                token_id,
                starting_job: starting_job as u8,
            })
        }
        "depositKek" | "withdrawKek" | "spendKek" | "sendKek" | "paidRespecSkills" => {
            Err("KEK custody is retired".to_string())
        }
        "importItem" => Ok(Input::ImportItem {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
            nonce: req_u64(value, "nonce")?,
        }),
        "bagImport" => Ok(Input::BagImport {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "bagExport" => Ok(Input::BagExport {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "exportItem" => Ok(Input::ExportItem {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "sendItem" => Ok(Input::SendItem {
            from: req_u256(value, "from")?,
            to: req_u256(value, "to")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "list" => Ok(Input::List {
            listing_id: req_u256(value, "listingId")?,
            seller: req_u256(value, "seller")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "bid" => Ok(Input::Bid {
            listing_id: req_u256(value, "listingId")?,
            bidder: req_u256(value, "bidder")?,
            amount: req_u256(value, "amount")?,
        }),
        "cancel" => Ok(Input::Cancel {
            listing_id: req_u256(value, "listingId")?,
            seller: req_u256(value, "seller")?,
        }),
        "settle" => Ok(Input::Settle {
            listing_id: req_u256(value, "listingId")?,
        }),
        "ask" => Ok(Input::Ask {
            listing_id: req_u256(value, "listingId")?,
            seller: req_u256(value, "seller")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
            min_price: req_u256(value, "minPrice")?,
            listed_at: req_u64(value, "listedAt")?,
        }),
        "fill" => Ok(Input::Fill {
            bidder: req_u256(value, "bidder")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
            listing_id: req_u256(value, "listingId")?,
        }),
        "buy" => Ok(Input::Buy {
            bidder: req_u256(value, "bidder")?,
            item_id: req_u256(value, "itemId")?,
            listing_id: req_u256(value, "listingId")?,
        }),
        "cancelAsk" => Ok(Input::CancelAsk {
            listing_id: req_u256(value, "listingId")?,
            seller: req_u256(value, "seller")?,
        }),
        "reclaimAsk" => Ok(Input::ReclaimAsk {
            listing_id: req_u256(value, "listingId")?,
            seller: req_u256(value, "seller")?,
            now: req_u64(value, "now")?,
        }),
        "sendInbox" => Ok(Input::SendInbox {
            from: req_u256(value, "from")?,
            to: req_u256(value, "to")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "takeInbox" => Ok(Input::TakeInbox {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "levelUp" => {
            let level = req_u64(value, "level")?;
            if level == 0 || level > u64::from(u32::MAX) {
                return Err("level out of range".to_string());
            }
            Ok(Input::LevelUp {
                token_id: req_u256(value, "tokenId")?,
                level: level as u32,
            })
        }
        "learnAbility" => Ok(Input::LearnAbility {
            token_id: req_u256(value, "tokenId")?,
            ability_id: req_label(value, "abilityId")?,
        }),
        "craft" => Ok(Input::Craft {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "harvest" => Ok(Input::Harvest {
            token_id: req_u256(value, "tokenId")?,
            material_id: req_label(value, "materialId")?,
            amount: req_u256(value, "amount")?,
        }),
        "itemDrop" => Ok(Input::ItemDrop {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "lootDrop" => {
            let has_kill = value.get("killId").is_some();
            let has_batch = value.get("batchId").is_some();
            if has_kill != has_batch {
                return Err("lootDrop kill and batch must both be set".to_string());
            }
            let (kill_id, batch_id) = if has_kill {
                (Some(req_u256(value, "killId")?), Some(req_u64(value, "batchId")?))
            } else {
                (None, None)
            };
            Ok(Input::LootDrop {
                token_id: req_u256(value, "tokenId")?,
                item_id: req_u256(value, "itemId")?,
                amount: req_u256(value, "amount")?,
                kill_id,
                batch_id,
            })
        }
        "kill" => Ok(Input::Kill {
            token_id: req_u256(value, "tokenId")?,
            kill_id: req_u256(value, "killId")?,
            batch_id: req_u64(value, "batchId")?,
        }),
        "craftSkill" => {
            let level = req_u64(value, "level")?;
            if level == 0 || level > u64::from(u32::MAX) {
                return Err("craft skill level out of range".to_string());
            }
            Ok(Input::CraftSkill {
                token_id: req_u256(value, "tokenId")?,
                skill_id: req_label(value, "skillId")?,
                level: level as u32,
            })
        }
        "respecSkills" => {
            let token_id = req_u256(value, "tokenId")?;
            let raw = value
                .get("nodeIds")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "missing nodeIds".to_string())?;
            if raw.len() > 600 {
                return Err("too many skill nodes".to_string());
            }
            let mut node_ids = Vec::with_capacity(raw.len());
            for (i, row) in raw.iter().enumerate() {
                let id = row.as_str().ok_or_else(|| format!("bad nodeIds[{i}]"))?;
                if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
                    return Err(format!("bad nodeIds[{i}]"));
                }
                node_ids.push(id.to_string());
            }
            Ok(Input::RespecSkills { token_id, node_ids })
        }
        "goldEarn" => Ok(Input::GoldEarn {
            token_id: req_u256(value, "tokenId")?,
            source: req_label(value, "source")?,
            amount: req_u256(value, "amount")?,
            day: req_u64(value, "day")?,
        }),
        "goldSpend" => Ok(Input::GoldSpend {
            token_id: req_u256(value, "tokenId")?,
            sink: req_label(value, "sink")?,
            amount: req_u256(value, "amount")?,
        }),
        "goldSell" => Ok(Input::GoldSell {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            qty: req_u256(value, "qty")?,
            amount: req_u256(value, "amount")?,
            day: req_u64(value, "day")?,
        }),
        "chainFill" => Ok(Input::ChainFill {
            listing_id: req_u256(value, "listingId")?,
            buyer: req_u256(value, "buyer")?,
            price_wei: req_u256(value, "priceWei")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
            seller: req_u256(value, "seller")?,
            tx_hash: req_b256(value, "txHash")?,
            log_index: req_u64(value, "logIndex")?,
        }),
        "pvpBountyOpen" => Ok(Input::PvpBountyOpen {
            token_id: req_u256(value, "tokenId")?,
            amount_wei: req_u256(value, "amountWei")?,
            area_id: req_label(value, "areaId")?,
            tx_hash: req_b256(value, "txHash")?,
            log_index: req_u64(value, "logIndex")?,
        }),
        "pvpBountyCancel" => Ok(Input::PvpBountyCancel {
            token_id: req_u256(value, "tokenId")?,
            area_id: req_label(value, "areaId")?,
            tx_hash: req_b256(value, "txHash")?,
            log_index: req_u64(value, "logIndex")?,
        }),
        "pvpKill" => Ok(Input::PvpKill {
            victim: req_u256(value, "victim")?,
            slayer: req_u256(value, "slayer")?,
            area_id: req_label(value, "areaId")?,
            amount_wei: req_u256(value, "amountWei")?,
            tx_hash: req_b256(value, "txHash")?,
            log_index: req_u64(value, "logIndex")?,
        }),
        "goldPaidRespec" => {
            let token_id = req_u256(value, "tokenId")?;
            let amount = req_u256(value, "amount")?;
            let raw = value
                .get("nodeIds")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "goldPaidRespec needs nodeIds".to_string())?;
            let mut node_ids = Vec::with_capacity(raw.len());
            for (i, v) in raw.iter().enumerate() {
                let id = v
                    .as_str()
                    .ok_or_else(|| format!("bad nodeIds[{i}]"))?;
                if id.is_empty() {
                    return Err(format!("bad nodeIds[{i}]"));
                }
                node_ids.push(id.to_string());
            }
            if node_ids.is_empty() {
                return Err("gold paid respec needs at least one skill node".to_string());
            }
            Ok(Input::GoldPaidRespec { token_id, amount, node_ids })
        }
        other => Err(format!("unknown input type {other}")),
    }
}

fn parse_u256_json(value: &serde_json::Value) -> Result<U256, String> {
    if let Some(s) = value.as_str() {
        if let Some(hexbody) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            if hexbody.is_empty() || hexbody.len() > 64 || !hexbody.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("bad hex uint256".to_string());
            }
            let padded = format!("{:0>64}", hexbody);
            let word = parse_b256(&padded).map_err(|_| "bad hex uint256".to_string())?;
            return Ok(U256(word));
        }
        return U256::parse_dec(s).map_err(|_| "bad decimal uint256".to_string());
    }
    if let Some(n) = value.as_u64() {
        return Ok(U256::from_u64(n));
    }
    Err("token id must be a string or a small number".to_string())
}

pub(crate) fn input_to_json(input: &Input) -> serde_json::Value {
    let s = |v: &U256| serde_json::Value::String(v.to_dec());
    match input {
        Input::Spawn { token_id, starting_job } => serde_json::json!({
            "type": "spawn",
            "tokenId": token_id.to_dec(),
            "startingJob": starting_job,
        }),
        Input::ImportItem { token_id, item_id, amount, nonce } => serde_json::json!({
            "type": "importItem",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
            "nonce": nonce.to_string(),
        }),
        Input::BagImport { token_id, item_id, amount } => serde_json::json!({
            "type": "bagImport",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::BagExport { token_id, item_id, amount } => serde_json::json!({
            "type": "bagExport",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::ExportItem { token_id, item_id, amount } => serde_json::json!({
            "type": "exportItem",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::SendItem { from, to, item_id, amount } => serde_json::json!({
            "type": "sendItem",
            "from": s(from),
            "to": s(to),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::List { listing_id, seller, item_id, amount } => serde_json::json!({
            "type": "list",
            "listingId": s(listing_id),
            "seller": s(seller),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::Bid { listing_id, bidder, amount } => serde_json::json!({
            "type": "bid",
            "listingId": s(listing_id),
            "bidder": s(bidder),
            "amount": s(amount),
        }),
        Input::Cancel { listing_id, seller } => serde_json::json!({
            "type": "cancel",
            "listingId": s(listing_id),
            "seller": s(seller),
        }),
        Input::Settle { listing_id } => serde_json::json!({
            "type": "settle",
            "listingId": s(listing_id),
        }),
        Input::Ask { listing_id, seller, item_id, amount, min_price, listed_at } => serde_json::json!({
            "type": "ask",
            "listingId": s(listing_id),
            "seller": s(seller),
            "itemId": s(item_id),
            "amount": s(amount),
            "minPrice": s(min_price),
            "listedAt": listed_at,
        }),
        Input::Fill { bidder, item_id, amount, listing_id } => serde_json::json!({
            "type": "fill",
            "bidder": s(bidder),
            "itemId": s(item_id),
            "amount": s(amount),
            "listingId": s(listing_id),
        }),
                Input::Buy { bidder, item_id, listing_id } => serde_json::json!({
            "type": "buy",
            "bidder": s(bidder),
            "itemId": s(item_id),
            "listingId": s(listing_id),
        }),
Input::CancelAsk { listing_id, seller } => serde_json::json!({
            "type": "cancelAsk",
            "listingId": s(listing_id),
            "seller": s(seller),
        }),
        Input::ReclaimAsk { listing_id, seller, now } => serde_json::json!({
            "type": "reclaimAsk",
            "listingId": s(listing_id),
            "seller": s(seller),
            "now": now,
        }),
        Input::SendInbox { from, to, item_id, amount } => serde_json::json!({
            "type": "sendInbox",
            "from": s(from),
            "to": s(to),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::TakeInbox { token_id, item_id, amount } => serde_json::json!({
            "type": "takeInbox",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::LevelUp { token_id, level } => serde_json::json!({
            "type": "levelUp",
            "tokenId": s(token_id),
            "level": level,
        }),
        Input::LearnAbility { token_id, ability_id } => serde_json::json!({
            "type": "learnAbility",
            "tokenId": s(token_id),
            "abilityId": ability_id,
        }),
        Input::Craft { token_id, item_id, amount } => serde_json::json!({
            "type": "craft",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::Harvest { token_id, material_id, amount } => serde_json::json!({
            "type": "harvest",
            "tokenId": s(token_id),
            "materialId": material_id,
            "amount": s(amount),
        }),
        Input::ItemDrop { token_id, item_id, amount } => serde_json::json!({
            "type": "itemDrop",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::LootDrop {
            token_id,
            item_id,
            amount,
            kill_id,
            batch_id,
        } => {
            let mut value = serde_json::json!({
                "type": "lootDrop",
                "tokenId": s(token_id),
                "itemId": s(item_id),
                "amount": s(amount),
            });
            if let (Some(kill_id), Some(batch_id)) = (kill_id, batch_id) {
                value["killId"] = s(kill_id);
                value["batchId"] = serde_json::json!(batch_id);
            }
            value
        }
        Input::Kill { token_id, kill_id, batch_id } => serde_json::json!({
            "type": "kill",
            "tokenId": s(token_id),
            "killId": s(kill_id),
            "batchId": batch_id,
        }),
        Input::CraftSkill { token_id, skill_id, level } => serde_json::json!({
            "type": "craftSkill",
            "tokenId": s(token_id),
            "skillId": skill_id,
            "level": level,
        }),
        Input::RespecSkills { token_id, node_ids } => serde_json::json!({
            "type": "respecSkills",
            "tokenId": s(token_id),
            "nodeIds": node_ids,
        }),
        Input::GoldEarn { token_id, source, amount, day } => serde_json::json!({
            "type": "goldEarn",
            "tokenId": s(token_id),
            "source": source,
            "amount": s(amount),
            "day": day,
        }),
        Input::GoldSpend { token_id, sink, amount } => serde_json::json!({
            "type": "goldSpend",
            "tokenId": s(token_id),
            "sink": sink,
            "amount": s(amount),
        }),
        Input::GoldSell { token_id, item_id, qty, amount, day } => serde_json::json!({
            "type": "goldSell",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "qty": s(qty),
            "amount": s(amount),
            "day": day,
        }),
        Input::ChainFill {
            listing_id,
            buyer,
            price_wei,
            item_id,
            amount,
            seller,
            tx_hash,
            log_index,
        } => serde_json::json!({
            "type": "chainFill",
            "listingId": s(listing_id),
            "buyer": s(buyer),
            "priceWei": s(price_wei),
            "itemId": s(item_id),
            "amount": s(amount),
            "seller": s(seller),
            "txHash": format!("0x{}", hex::encode(tx_hash)),
            "logIndex": log_index,
        }),
        Input::PvpBountyOpen {
            token_id,
            amount_wei,
            area_id,
            tx_hash,
            log_index,
        } => serde_json::json!({
            "type": "pvpBountyOpen",
            "tokenId": s(token_id),
            "amountWei": s(amount_wei),
            "areaId": area_id,
            "txHash": format!("0x{}", hex::encode(tx_hash)),
            "logIndex": log_index,
        }),
        Input::PvpBountyCancel {
            token_id,
            area_id,
            tx_hash,
            log_index,
        } => serde_json::json!({
            "type": "pvpBountyCancel",
            "tokenId": s(token_id),
            "areaId": area_id,
            "txHash": format!("0x{}", hex::encode(tx_hash)),
            "logIndex": log_index,
        }),
        Input::PvpKill {
            victim,
            slayer,
            area_id,
            amount_wei,
            tx_hash,
            log_index,
        } => serde_json::json!({
            "type": "pvpKill",
            "victim": s(victim),
            "slayer": s(slayer),
            "areaId": area_id,
            "amountWei": s(amount_wei),
            "txHash": format!("0x{}", hex::encode(tx_hash)),
            "logIndex": log_index,
        }),
        Input::GoldPaidRespec { token_id, amount, node_ids } => serde_json::json!({
            "type": "goldPaidRespec",
            "tokenId": s(token_id),
            "amount": s(amount),
            "nodeIds": node_ids,
        }),
    }
}
