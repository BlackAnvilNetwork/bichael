//! Apply inputs to a character that already has a genesis anchor.

use std::fmt;

use crate::chain::Chain;
use crate::event::{entry_hash, Input, Outcome};
use crate::ids::genesis_root;
use crate::state::{label_key, Key, State};
use crate::u256::U256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineError {
    AlreadySpawned,
    /// Spawn named a different token or job than the genesis anchor.
    SpawnMismatch,
    NotSpawned,
    SelfTransfer,
    ZeroAmount,
    InsufficientKek,
    InsufficientItem,
    Overflow,
    ListingExists,
    AlreadyListed,
    UnknownListing,
    BidNotHigher,
    NotSeller,
    NoBid,
    /// Checkpoint span is empty, backwards, or past this character's log.
    BadRange,
    /// Two character logs give the same sequence number a different payload.
    ConflictingLog,
    /// Deposit or import nonce was already consumed, skipped, or zero.
    /// Inbounds for one character are the chain's `inboundCount` and apply in order.
    ReplayInbound,
    /// The event does not name this character. Auction events are still applied by `World`
    /// onto every affected character's own chain; a lone engine has no shared listing book.
    NotOnCharacterLog,
    /// Level was zero, above the 16-bit summary, or not exactly the next level.
    BadLevel,
    /// This character already recorded that ability.
    AlreadyKnown,
    /// Ability, material, or item id is empty or not a printable token.
    BadId,
    /// Craft skill level was zero, above 16 bits, or not strictly higher than the logged level.
    BadCraftSkill,
    /// No ask of that item is at or under the bid, after skipping the bidder's own asks.
    NoAsk,
    /// The ask is still inside its 7 day window.
    TooSoon,
    /// The inbox does not hold that stack.
    InsufficientInbox,
    /// The ask was recorded without a server timestamp.
    BadClock,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadySpawned => write!(f, "already spawned"),
            Self::SpawnMismatch => write!(f, "spawn does not match genesis identity"),
            Self::NotSpawned => write!(f, "character is not spawned"),
            Self::SelfTransfer => write!(f, "cannot send to self"),
            Self::ZeroAmount => write!(f, "amount must be greater than zero"),
            Self::InsufficientKek => write!(f, "insufficient KEK"),
            Self::InsufficientItem => write!(f, "insufficient item"),
            Self::Overflow => write!(f, "balance overflow"),
            Self::ListingExists => write!(f, "listing id already exists"),
            Self::AlreadyListed => write!(f, "item is already listed"),
            Self::UnknownListing => write!(f, "unknown listing"),
            Self::BidNotHigher => write!(f, "bid is not strictly higher"),
            Self::NotSeller => write!(f, "only the seller can cancel"),
            Self::NoBid => write!(f, "listing has no bid"),
            Self::BadRange => write!(f, "checkpoint span is empty or out of order"),
            Self::ConflictingLog => write!(f, "character logs disagree on an event"),
            Self::NotOnCharacterLog => write!(f, "event does not involve this character"),
            Self::ReplayInbound => write!(f, "inbound nonce was already consumed or is out of order"),
            Self::BadLevel => write!(f, "level is not the next level"),
            Self::AlreadyKnown => write!(f, "already known"),
            Self::BadId => write!(f, "id is empty or invalid"),
            Self::BadCraftSkill => write!(f, "craft skill level is not higher than the logged level"),
            Self::NoAsk => write!(f, "no ask at or under that bid"),
            Self::TooSoon => write!(f, "ask can be reclaimed after 7 days"),
            Self::InsufficientInbox => write!(f, "nothing in the inbox"),
            Self::BadClock => write!(f, "listing has no time"),
        }
    }
}

pub(crate) const LABEL_MAX: usize = 128;

pub(crate) fn parse_label(raw: &str) -> Result<&str, EngineError> {
    if raw.is_empty() || raw.len() > LABEL_MAX {
        return Err(EngineError::BadId);
    }
    if !raw.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Err(EngineError::BadId);
    }
    Ok(raw)
}

pub struct Engine {
    token_id: U256,
    starting_job: u8,
    state: State,
    chain: Chain,
    /// How many deposit/import nonces this character has consumed. The next accepted nonce is this plus one.
    inbound_applied: u64,
}

impl Engine {
    /// Pre-Spawn engine. The log head is the genesis root; the map is empty.
    pub fn open(token_id: U256, starting_job: u8) -> Self {
        let anchor = genesis_root(&token_id, starting_job);
        Self {
            token_id,
            starting_job,
            state: State::new(),
            chain: Chain::new(anchor),
            inbound_applied: 0,
        }
    }

    pub fn genesis(&self) -> [u8; 32] {
        genesis_root(&self.token_id, self.starting_job)
    }

    pub fn head(&self) -> [u8; 32] {
        self.chain.head()
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn len(&self) -> u64 {
        self.chain.len()
    }

    pub fn apply(&mut self, input: Input) -> Result<Outcome, EngineError> {
        let saved = self.state.clone();
        if let Err(err) = self.apply_local(&input) {
            self.state = saved;
            return Err(err);
        }
        let index = self.chain.len();
        let prev_hash = self.chain.head();
        let link = entry_hash(&prev_hash, index, &input);
        let state_root = self.state.root();
        let summary = self.state.summary();
        self.chain.push(input, link);
        Ok(Outcome::Applied {
            index,
            prev_hash,
            entry_hash: link,
            state_root,
            summary,
        })
    }

    /// Local delta for events whose payload names this character.
    /// Sends debit or credit only this side. The counterparty's log carries the same payload
    /// and applies the other side. List, bid, cancel, and settle need the shared listing book,
    /// so they are appended by `World` rather than here.
    fn apply_local(&mut self, input: &Input) -> Result<(), EngineError> {
        match input {
            Input::Spawn { token_id, starting_job } => {
                if token_id != &self.token_id || *starting_job != self.starting_job {
                    return Err(EngineError::SpawnMismatch);
                }
                if !self.state.is_empty() {
                    return Err(EngineError::AlreadySpawned);
                }
                self.state.spawn(*token_id, *starting_job);
                Ok(())
            }
            Input::DepositKek { token_id, amount, nonce } => {
                self.credit_inbound(*token_id, *nonce, |engine| engine.credit_kek(*token_id, *amount))
            }
            Input::WithdrawKek { token_id, amount } => self.debit_kek(*token_id, *amount),
            Input::SpendKek { token_id, amount } => self.debit_kek(*token_id, *amount),
            Input::ImportItem { token_id, item_id, amount, nonce } => {
                self.credit_inbound(*token_id, *nonce, |engine| engine.credit_item(*token_id, *item_id, *amount))
            }
            Input::ExportItem { token_id, item_id, amount } => self.debit_item(*token_id, *item_id, *amount),
            Input::SendKek { from, to, amount } => self.transfer_kek(*from, *to, *amount),
            Input::SendItem { from, to, item_id, amount } => self.transfer_item(*from, *to, *item_id, *amount),
            Input::List { .. }
            | Input::Bid { .. }
            | Input::Cancel { .. }
            | Input::Settle { .. }
            | Input::Ask { .. }
            | Input::Fill { .. }
            | Input::CancelAsk { .. }
            | Input::ReclaimAsk { .. }
            | Input::SendInbox { .. }
            | Input::TakeInbox { .. } => Err(EngineError::NotOnCharacterLog),
            Input::LevelUp { token_id, level } => self.apply_level(*token_id, *level),
            Input::LearnAbility { token_id, ability_id } => self.learn(*token_id, ability_id),
            Input::Craft { token_id, item_id, amount } => self.note_craft(*token_id, *item_id, *amount),
            Input::Harvest { token_id, material_id, amount } => self.note_harvest(*token_id, material_id, *amount),
            Input::ItemDrop { token_id, item_id, amount } => self.drop_item(*token_id, *item_id, *amount),
            Input::CraftSkill { token_id, skill_id, level } => self.note_craft_skill(*token_id, skill_id, *level),
            Input::RespecSkills { token_id, node_ids } => self.respec_skills(*token_id, node_ids),
            Input::PaidRespecSkills { token_id, amount, node_ids } => {
                self.debit_kek(*token_id, *amount)?;
                self.respec_skills(*token_id, node_ids)
            }
        }
    }

    fn apply_level(&mut self, token_id: U256, level: u32) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        let current = self.state.level_u32();
        if level == 0 || level > 65535 || current >= 65535 || level != current + 1 {
            return Err(EngineError::BadLevel);
        }
        self.state.set_level(level);
        Ok(())
    }

    fn learn(&mut self, token_id: U256, ability_id: &str) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        parse_label(ability_id)?;
        let key = label_key(ability_id);
        if self.state.knows_ability_key(&key) {
            return Err(EngineError::AlreadyKnown);
        }
        self.state.mark_ability(key);
        Ok(())
    }

    fn note_craft(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        if item_id == U256::ZERO {
            return Err(EngineError::BadId);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        self.state
            .add_count(Key::Craft(item_id), amount)
            .map_err(|_| EngineError::Overflow)?;
        Ok(())
    }

    fn note_harvest(&mut self, token_id: U256, material_id: &str, amount: U256) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        parse_label(material_id)?;
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        self.state
            .add_count(Key::Harvest(label_key(material_id)), amount)
            .map_err(|_| EngineError::Overflow)?;
        Ok(())
    }

    fn note_craft_skill(&mut self, token_id: U256, skill_id: &str, level: u32) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        parse_label(skill_id)?;
        if level == 0 || level > 65535 {
            return Err(EngineError::BadCraftSkill);
        }
        let key = label_key(skill_id);
        let current = self.state.craft_skill_level(&key);
        if level <= current {
            return Err(EngineError::BadCraftSkill);
        }
        self.state.set_craft_skill(key, level);
        Ok(())
    }

    fn respec_skills(&mut self, token_id: U256, node_ids: &[String]) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        if node_ids.len() > 600 {
            return Err(EngineError::BadId);
        }
        for id in node_ids {
            parse_label(id)?;
            self.state.clear_ability(label_key(id));
        }
        Ok(())
    }

    fn drop_item(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        if item_id == U256::ZERO {
            return Err(EngineError::BadId);
        }
        self.credit_item(token_id, item_id, amount)
    }

    /// Check the nonce, apply the credit, then record it. A failed credit does not consume the nonce.
    fn credit_inbound(
        &mut self,
        token_id: U256,
        nonce: u64,
        credit: impl FnOnce(&mut Self) -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        let next = self.inbound_applied.checked_add(1).ok_or(EngineError::Overflow)?;
        if nonce == 0 || nonce != next {
            return Err(EngineError::ReplayInbound);
        }
        credit(self)?;
        self.inbound_applied = nonce;
        Ok(())
    }

    fn involves(&self, token_id: &U256) -> Result<(), EngineError> {
        if token_id != &self.token_id {
            return Err(EngineError::NotOnCharacterLog);
        }
        if self.state.is_empty() {
            return Err(EngineError::NotSpawned);
        }
        Ok(())
    }

    fn credit_kek(&mut self, token_id: U256, amount: U256) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let next = self.state.get(&Key::Kek).checked_add(amount).ok_or(EngineError::Overflow)?;
        self.state.set_kek(next);
        Ok(())
    }

    fn debit_kek(&mut self, token_id: U256, amount: U256) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let next = self
            .state
            .get(&Key::Kek)
            .checked_sub(amount)
            .ok_or(EngineError::InsufficientKek)?;
        self.state.set_kek(next);
        Ok(())
    }

    fn credit_item(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let next = self
            .state
            .get(&Key::Item(item_id))
            .checked_add(amount)
            .ok_or(EngineError::Overflow)?;
        self.state.set_item(item_id, next);
        Ok(())
    }

    fn debit_item(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let next = self
            .state
            .get(&Key::Item(item_id))
            .checked_sub(amount)
            .ok_or(EngineError::InsufficientItem)?;
        self.state.set_item(item_id, next);
        Ok(())
    }

    fn transfer_kek(&mut self, from: U256, to: U256, amount: U256) -> Result<(), EngineError> {
        if from == to {
            return Err(EngineError::SelfTransfer);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        if from != self.token_id && to != self.token_id {
            return Err(EngineError::NotOnCharacterLog);
        }
        if self.state.is_empty() {
            return Err(EngineError::NotSpawned);
        }
        if from == self.token_id {
            let next = self
                .state
                .get(&Key::Kek)
                .checked_sub(amount)
                .ok_or(EngineError::InsufficientKek)?;
            self.state.set_kek(next);
        }
        if to == self.token_id {
            let next = self.state.get(&Key::Kek).checked_add(amount).ok_or(EngineError::Overflow)?;
            self.state.set_kek(next);
        }
        Ok(())
    }

    fn transfer_item(&mut self, from: U256, to: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        if from == to {
            return Err(EngineError::SelfTransfer);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        if from != self.token_id && to != self.token_id {
            return Err(EngineError::NotOnCharacterLog);
        }
        if self.state.is_empty() {
            return Err(EngineError::NotSpawned);
        }
        if from == self.token_id {
            let next = self
                .state
                .get(&Key::Item(item_id))
                .checked_sub(amount)
                .ok_or(EngineError::InsufficientItem)?;
            self.state.set_item(item_id, next);
        }
        if to == self.token_id {
            let next = self
                .state
                .get(&Key::Item(item_id))
                .checked_add(amount)
                .ok_or(EngineError::Overflow)?;
            self.state.set_item(item_id, next);
        }
        Ok(())
    }
}
