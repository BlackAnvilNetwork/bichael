//! Sorted character state and its Merkle commitment.

use std::collections::BTreeMap;

use crate::abi::{keccak256, Buf};
use crate::u256::U256;

/// Map keys. Declaration order is the `BTreeMap` order for the scalar fields.
/// `Item` sorts last, then by item id. Spawn does not credit `Kek`. The world log credits a deposit, never a transfer.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Key {
    TokenId,
    Level,
    Job,
    Subjob,
    JobXp,
    SubjobXp,
    Location,
    UnspentPoints,
    Kek,
    Item(U256),
    /// Learned ability. Value is 1. Key data is keccak256 of the ability id.
    Ability(U256),
    /// Total amount crafted of an item. Not a spendable balance.
    Craft(U256),
    /// Total amount gathered of a material. Key data is keccak256 of the material id. Not spendable.
    Harvest(U256),
    /// Craft skill level. Key data is keccak256 of the skill id. Value is the level, not XP.
    CraftSkill(U256),
    /// Total amount looted of an item (`LootDrop`). Not a spendable balance and not a mint.
    /// Declared last with the newest tag so state roots of logs without loot counters are unchanged.
    Drop(U256),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct State {
    map: BTreeMap<Key, U256>,
}

impl State {
    pub fn new() -> Self {
        Self { map: BTreeMap::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn get(&self, key: &Key) -> U256 {
        self.map.get(key).copied().unwrap_or(U256::ZERO)
    }

    pub(crate) fn spawn(&mut self, token_id: U256, starting_job: u8) {
        self.map.insert(Key::TokenId, token_id);
        self.map.insert(Key::Level, U256::from_u64(1));
        self.map.insert(Key::Job, U256::from_u64(u64::from(starting_job)));
        self.map.insert(Key::Subjob, U256::ZERO);
        self.map.insert(Key::JobXp, U256::ZERO);
        self.map.insert(Key::SubjobXp, U256::ZERO);
        self.map.insert(Key::Location, U256::ZERO);
        self.map.insert(Key::UnspentPoints, U256::ZERO);
        // Deposit-only. Spawn does not grant KEK.
        self.map.insert(Key::Kek, U256::ZERO);
    }

    pub(crate) fn set_kek(&mut self, amount: U256) {
        self.map.insert(Key::Kek, amount);
    }

    pub fn level_u32(&self) -> u32 {
        let raw = self.get(&Key::Level);
        u32::from_be_bytes(raw.0[28..].try_into().expect("4 bytes"))
    }

    pub(crate) fn set_level(&mut self, level: u32) {
        self.map.insert(Key::Level, U256::from_u64(u64::from(level)));
    }

    pub(crate) fn mark_ability(&mut self, id: U256) {
        self.map.insert(Key::Ability(id), U256::from_u64(1));
    }

    pub(crate) fn clear_ability(&mut self, id: U256) {
        self.map.remove(&Key::Ability(id));
    }

    pub(crate) fn set_craft_skill(&mut self, id: U256, level: u32) {
        self.map.insert(Key::CraftSkill(id), U256::from_u64(u64::from(level)));
    }

    pub fn craft_skill_level(&self, id: &U256) -> u32 {
        let raw = self.get(&Key::CraftSkill(*id));
        u32::from_be_bytes(raw.0[28..].try_into().expect("4 bytes"))
    }

    pub fn knows_ability_key(&self, id: &U256) -> bool {
        self.get(&Key::Ability(*id)) != U256::ZERO
    }

    pub(crate) fn add_count(&mut self, key: Key, amount: U256) -> Result<(), ()> {
        let next = self.get(&key).checked_add(amount).ok_or(())?;
        self.map.insert(key, next);
        Ok(())
    }

    pub fn crafts(&self) -> Vec<(U256, U256)> {
        self.rows(|key| match key {
            Key::Craft(id) => Some(*id),
            _ => None,
        })
    }

    pub fn harvest_keys(&self) -> Vec<(U256, U256)> {
        self.rows(|key| match key {
            Key::Harvest(id) => Some(*id),
            _ => None,
        })
    }

    pub fn drops(&self) -> Vec<(U256, U256)> {
        self.rows(|key| match key {
            Key::Drop(id) => Some(*id),
            _ => None,
        })
    }

    fn rows(&self, pick: impl Fn(&Key) -> Option<U256>) -> Vec<(U256, U256)> {
        self.map
            .iter()
            .filter_map(|(key, amount)| pick(key).map(|id| (id, *amount)))
            .collect()
    }

    pub(crate) fn set_item(&mut self, item_id: U256, amount: U256) {
        if amount == U256::ZERO {
            self.map.remove(&Key::Item(item_id));
        } else {
            self.map.insert(Key::Item(item_id), amount);
        }
    }

    /// Bit layout from `CharacterCheckpoint.summary`.
    pub fn summary(&self) -> U256 {
        let level = self.get(&Key::Level).mask_low(16);
        let job = self.get(&Key::Job).mask_low(8).shl(16);
        let subjob = self.get(&Key::Subjob).mask_low(8).shl(24);
        let job_xp = self.get(&Key::JobXp).mask_low(32).shl(32);
        let subjob_xp = self.get(&Key::SubjobXp).mask_low(32).shl(64);
        let location = self.get(&Key::Location).mask_low(16).shl(96);
        let unspent = self.get(&Key::UnspentPoints).mask_low(16).shl(112);
        level
            .bitor(job)
            .bitor(subjob)
            .bitor(job_xp)
            .bitor(subjob_xp)
            .bitor(location)
            .bitor(unspent)
    }

    pub fn root(&self) -> [u8; 32] {
        commit_map(&self.map)
    }

    /// Spendable item rows. Zero balances are not stored.
    pub fn items(&self) -> Vec<(U256, U256)> {
        self.map
            .iter()
            .filter_map(|(key, amount)| match key {
                Key::Item(id) => Some((*id, *amount)),
                _ => None,
            })
            .collect()
    }
}

fn key_tag(key: &Key) -> u8 {
    match key {
        Key::TokenId => 0,
        Key::Level => 1,
        Key::Job => 2,
        Key::Subjob => 3,
        Key::JobXp => 4,
        Key::SubjobXp => 5,
        Key::Location => 6,
        Key::UnspentPoints => 7,
        Key::Kek => 8,
        Key::Item(_) => 9,
        Key::Ability(_) => 10,
        Key::Craft(_) => 11,
        Key::Harvest(_) => 12,
        Key::CraftSkill(_) => 13,
        Key::Drop(_) => 14,
    }
}

fn leaf(key: &Key, value: &U256) -> [u8; 32] {
    let key_data = match key {
        Key::Item(id) | Key::Ability(id) | Key::Craft(id) | Key::Harvest(id) | Key::Drop(id) | Key::CraftSkill(id) => *id,
        _ => U256::ZERO,
    };
    let mut buf = Buf::new();
    buf.u8(key_tag(key));
    buf.u256(&key_data);
    buf.u256(value);
    keccak256(&buf.bytes)
}

fn commit_map(map: &BTreeMap<Key, U256>) -> [u8; 32] {
    let mut level: Vec<[u8; 32]> = map.iter().map(|(k, v)| leaf(k, v)).collect();
    if level.is_empty() {
        return keccak256(&[]);
    }
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            let last = *level.last().expect("odd level has a last leaf");
            level.push(last);
        }
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            let mut raw = [0u8; 64];
            raw[..32].copy_from_slice(&pair[0]);
            raw[32..].copy_from_slice(&pair[1]);
            next.push(keccak256(&raw));
        }
        level = next;
    }
    level[0]
}

/// Commitment of an arbitrary set of entries. Duplicate keys: the last one wins.
/// Order of `entries` does not matter.
pub fn commit_entries(entries: impl IntoIterator<Item = (Key, U256)>) -> [u8; 32] {
    commit_map(&entries.into_iter().collect())
}

/// keccak256(utf-8 label), used as the map key for an ability or material id.
pub fn label_key(label: &str) -> U256 {
    U256(keccak256(label.as_bytes()))
}
