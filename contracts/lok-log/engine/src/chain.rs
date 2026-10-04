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

    pub fn push(&mut self, input: Input, hash: [u8; 32]) {
        let index = self.len();
        let prev_hash = self.head;
        self.entries.push(Entry {
            index,
            prev_hash,
            hash,
            input,
        });
        self.head = hash;
    }

    /// Drop the last link and restore the previous head. Used to undo a withdraw that never queued.
    pub fn pop(&mut self) -> Option<[u8; 32]> {
        let entry = self.entries.pop()?;
        self.head = entry.prev_hash;
        Some(entry.hash)
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
        let computed = entry_hash(&engine.head(), index, &entry.input);
        if computed != entry.hash {
            return Err(ReplayStop::BadHash {
                index,
                expected: entry.hash,
                computed,
            });
        }
        engine
            .apply(entry.input.clone())
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
        entries.push(LoggedEntry { hash, input, seq });
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
        "depositKek" => Ok(Input::DepositKek {
            token_id: req_u256(value, "tokenId")?,
            amount: req_u256(value, "amount")?,
            nonce: req_u64(value, "nonce")?,
        }),
        "importItem" => Ok(Input::ImportItem {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
            nonce: req_u64(value, "nonce")?,
        }),
        "exportItem" => Ok(Input::ExportItem {
            token_id: req_u256(value, "tokenId")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "withdrawKek" => Ok(Input::WithdrawKek {
            token_id: req_u256(value, "tokenId")?,
            amount: req_u256(value, "amount")?,
        }),
        "spendKek" => Ok(Input::SpendKek {
            token_id: req_u256(value, "tokenId")?,
            amount: req_u256(value, "amount")?,
        }),
        "sendItem" => Ok(Input::SendItem {
            from: req_u256(value, "from")?,
            to: req_u256(value, "to")?,
            item_id: req_u256(value, "itemId")?,
            amount: req_u256(value, "amount")?,
        }),
        "sendKek" => Ok(Input::SendKek {
            from: req_u256(value, "from")?,
            to: req_u256(value, "to")?,
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
        "paidRespecSkills" => {
            let token_id = req_u256(value, "tokenId")?;
            let amount = req_u256(value, "amount")?;
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
            if node_ids.is_empty() {
                return Err("paid respec needs at least one skill node".to_string());
            }
            Ok(Input::PaidRespecSkills { token_id, amount, node_ids })
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
        Input::DepositKek { token_id, amount, nonce } => serde_json::json!({
            "type": "depositKek",
            "tokenId": s(token_id),
            "amount": s(amount),
            "nonce": nonce.to_string(),
        }),
        Input::ImportItem { token_id, item_id, amount, nonce } => serde_json::json!({
            "type": "importItem",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
            "nonce": nonce.to_string(),
        }),
        Input::ExportItem { token_id, item_id, amount } => serde_json::json!({
            "type": "exportItem",
            "tokenId": s(token_id),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::WithdrawKek { token_id, amount } => serde_json::json!({
            "type": "withdrawKek",
            "tokenId": s(token_id),
            "amount": s(amount),
        }),
        Input::SpendKek { token_id, amount } => serde_json::json!({
            "type": "spendKek",
            "tokenId": s(token_id),
            "amount": s(amount),
        }),
        Input::SendItem { from, to, item_id, amount } => serde_json::json!({
            "type": "sendItem",
            "from": s(from),
            "to": s(to),
            "itemId": s(item_id),
            "amount": s(amount),
        }),
        Input::SendKek { from, to, amount } => serde_json::json!({
            "type": "sendKek",
            "from": s(from),
            "to": s(to),
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
        Input::PaidRespecSkills { token_id, amount, node_ids } => serde_json::json!({
            "type": "paidRespecSkills",
            "tokenId": s(token_id),
            "amount": s(amount),
            "nodeIds": node_ids,
        }),
    }
}
