//! Apply inputs to a character that already has a genesis anchor.

use std::fmt;

use crate::chain::Chain;
use crate::event::{craft_skill_validated_at, entry_hash, Input, Outcome};
use crate::gold::{self, GoldError};
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
    /// KEK custody, transfers, and KEK-priced fills are retired. Gold is in-game; asks settle on AhEscrow.
    KekRetired,
    InsufficientGold,
    InsufficientItem,
    Overflow,
    /// Daily gold earn cap (per source or total) would be exceeded.
    EarnCap,
    /// Gold earn day is older than the day already accumulated on the log.
    StaleDay,
    /// Gold earn day was zero or otherwise unusable.
    BadDay,
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
    /// Deposit or import nonce was already consumed or is zero.
    /// Inbounds for one character are the chain's `inboundCount` and apply in order.
    ReplayInbound,
    /// Deposit or import nonce is above the next expected one (a gap).
    OutOfOrderInbound,
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
    /// Craft targets a known recipe but craft skill rank is too low.
    BadCraftLevel,
    /// Craft targets a known recipe with invalid output quantity.
    BadCraftRecipe,
    /// No ask of that item is at or under the bid, after skipping the bidder's own asks.
    NoAsk,
    /// The ask is still inside its 7 day window.
    TooSoon,
    /// The inbox does not hold that stack.
    InsufficientInbox,
    /// The ask was recorded without a server timestamp.
    BadClock,
    /// `ItemDrop` does not credit items, on a new append or on replay. Mob loot is `LootDrop`.
    ClosedMint,
    /// A fill priced above the selected ask. The buyer pays the ask.
    OverAsk,
    /// ChainFill fields disagree with the open ask (item, amount, or seller).
    FillMismatch,
    /// NPC sell amount does not match the engine price table.
    BadPrice,
    /// Character already has an open PvP bounty.
    AlreadyBounty,
    /// Character has no open PvP bounty to cancel or claim.
    NoBounty,
    /// PvP bounty amount or area does not match the open escrow.
    BountyMismatch,
    /// PvP bounty amount is not the fixed 1×10^18 wei ruleset value.
    BadBountyAmount,
    /// This tx hash and log index already mirrored a PvP escrow event.
    DuplicatePvpFill,
    /// The cited kill seq is not on this character's log.
    MissingKill,
    /// The cited kill seq is this event or later, so it is not a prior kill.
    FutureKill,
    /// The cited event is not a mob kill. `PvpKill` does not justify mob loot.
    NotAKill,
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
            Self::KekRetired => write!(f, "KEK custody is retired"),
            Self::InsufficientGold => write!(f, "insufficient gold"),
            Self::InsufficientItem => write!(f, "insufficient item"),
            Self::Overflow => write!(f, "balance overflow"),
            Self::EarnCap => write!(f, "daily gold earn cap"),
            Self::StaleDay => write!(f, "gold earn day is stale"),
            Self::BadDay => write!(f, "gold earn day is invalid"),
            Self::ListingExists => write!(f, "listing id already exists"),
            Self::AlreadyListed => write!(f, "item is already listed"),
            Self::UnknownListing => write!(f, "unknown listing"),
            Self::BidNotHigher => write!(f, "bid is not strictly higher"),
            Self::NotSeller => write!(f, "only the seller can cancel"),
            Self::NoBid => write!(f, "listing has no bid"),
            Self::BadRange => write!(f, "checkpoint span is empty or out of order"),
            Self::ConflictingLog => write!(f, "character logs disagree on an event"),
            Self::NotOnCharacterLog => write!(f, "event does not involve this character"),
            Self::ReplayInbound => write!(f, "inbound nonce was already consumed"),
            Self::OutOfOrderInbound => write!(f, "inbound nonce is out of order"),
            Self::BadLevel => write!(f, "level is not the next level"),
            Self::AlreadyKnown => write!(f, "already known"),
            Self::BadId => write!(f, "id is empty or invalid"),
            Self::BadCraftSkill => write!(f, "craft skill level is not higher than the logged level"),
            Self::BadCraftLevel => write!(f, "craft skill level is too low for the recipe"),
            Self::BadCraftRecipe => write!(f, "craft recipe is invalid"),
            Self::NoAsk => write!(f, "no ask at or under that bid"),
            Self::TooSoon => write!(f, "ask can be reclaimed after 7 days"),
            Self::InsufficientInbox => write!(f, "nothing in the inbox"),
            Self::BadClock => write!(f, "listing has no time"),
            Self::ClosedMint => write!(f, "item drop cannot mint"),
            Self::OverAsk => write!(f, "buyer would pay more than the ask"),
            Self::FillMismatch => write!(f, "chain fill does not match the ask"),
            Self::BadPrice => write!(f, "npc sell price does not match the table"),
            Self::AlreadyBounty => write!(f, "pvp bounty already open"),
            Self::NoBounty => write!(f, "no open pvp bounty"),
            Self::BountyMismatch => write!(f, "pvp bounty does not match"),
            Self::BadBountyAmount => write!(f, "pvp bounty must be 1e18 wei"),
            Self::DuplicatePvpFill => write!(f, "pvp receipt already mirrored"),
            Self::MissingKill => write!(f, "kill event is not on this character's log"),
            Self::FutureKill => write!(f, "kill event is not yet in the log"),
            Self::NotAKill => write!(f, "cited event is not a mob kill"),
        }
    }
}

impl EngineError {
    /// Stable rejection code.
    ///
    /// Assigned in enum order, starting at 1. A code stays with its variant.
    /// Do not renumber. A new variant takes the next unused number.
    pub fn code(&self) -> u16 {
        match self {
            Self::AlreadySpawned => 1,
            Self::SpawnMismatch => 2,
            Self::NotSpawned => 3,
            Self::SelfTransfer => 4,
            Self::ZeroAmount => 5,
            Self::InsufficientKek => 6,
            Self::KekRetired => 7,
            Self::InsufficientGold => 8,
            Self::InsufficientItem => 9,
            Self::Overflow => 10,
            Self::EarnCap => 11,
            Self::StaleDay => 12,
            Self::BadDay => 13,
            Self::ListingExists => 14,
            Self::AlreadyListed => 15,
            Self::UnknownListing => 16,
            Self::BidNotHigher => 17,
            Self::NotSeller => 18,
            Self::NoBid => 19,
            Self::BadRange => 20,
            Self::ConflictingLog => 21,
            Self::ReplayInbound => 22,
            Self::OutOfOrderInbound => 23,
            Self::NotOnCharacterLog => 24,
            Self::BadLevel => 25,
            Self::AlreadyKnown => 26,
            Self::BadId => 27,
            Self::BadCraftSkill => 28,
            Self::BadCraftLevel => 29,
            Self::BadCraftRecipe => 30,
            Self::NoAsk => 31,
            Self::TooSoon => 32,
            Self::InsufficientInbox => 33,
            Self::BadClock => 34,
            Self::ClosedMint => 35,
            Self::OverAsk => 36,
            Self::FillMismatch => 37,
            Self::BadPrice => 38,
            Self::AlreadyBounty => 39,
            Self::NoBounty => 40,
            Self::BountyMismatch => 41,
            Self::BadBountyAmount => 42,
            Self::DuplicatePvpFill => 43,
            Self::MissingKill => 44,
            Self::FutureKill => 45,
            Self::NotAKill => 46,
        }
    }
}

/// A loot drop may cite only a prior `MobKill` on this character.
/// `horizon` is the seq this drop would occupy. A seq at or above it is not prior.
pub(crate) fn require_prior_mob_kill<'a>(
    prior: impl Iterator<Item = (u64, &'a Input)>,
    token_id: &U256,
    kill_seq: u64,
    horizon: u64,
) -> Result<(), EngineError> {
    if kill_seq >= horizon {
        return Err(EngineError::FutureKill);
    }
    let mut cited = None;
    for (seq, input) in prior {
        if seq == kill_seq {
            cited = Some(input);
            break;
        }
    }
    match cited {
        Some(Input::MobKill { token_id: killer }) if killer == token_id => Ok(()),
        Some(_) => Err(EngineError::NotAKill),
        None => Err(EngineError::MissingKill),
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
    /// Global seq of each chain link, in order. A new append uses the chain index.
    /// Replay stores the seq from the log. Used to cite a prior mob kill.
    seqs: Vec<u64>,
    /// How many deposit/import nonces this character has consumed. The next accepted nonce is this plus one.
    inbound_applied: u64,
    /// Ruleset included in each new entry hash. Starts at 32 zero bytes, same as `World`.
    /// Set with `set_ruleset_hash`. Does not rewrite links already on the log.
    ruleset_hash: [u8; 32],
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
            seqs: Vec::new(),
            inbound_applied: 0,
            ruleset_hash: [0u8; 32],
        }
    }

    /// Ruleset for the next entry hash. Does not rewrite links already on the log.
    pub fn set_ruleset_hash(&mut self, hash: [u8; 32]) {
        self.ruleset_hash = hash;
    }

    pub fn ruleset_hash(&self) -> [u8; 32] {
        self.ruleset_hash
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

    /// Append a new event. A new `ItemDrop` is refused (`ClosedMint`); mob loot is `LootDrop`.
    pub fn apply(&mut self, input: Input) -> Result<Outcome, EngineError> {
        self.apply_with(input, None)
    }

    /// Re-apply an entry that is already on a log, at its global `seq`. An `ItemDrop` is refused
    /// (`ClosedMint`) at every seq.
    pub fn replay_logged(&mut self, input: Input, seq: u64) -> Result<Outcome, EngineError> {
        self.apply_with(input, Some(seq))
    }

    fn apply_with(&mut self, input: Input, logged: Option<u64>) -> Result<Outcome, EngineError> {
        // Roll back a partial sheet on failure. The copy ends with this block, so a
        // successful apply does not keep the preimage alive across root and append.
        {
            let saved = self.state.clone();
            if let Err(err) = self.apply_local(&input, logged) {
                self.state = saved;
                return Err(err);
            }
        }
        let index = self.chain.len();
        let seq = logged.unwrap_or(index);
        let prev_hash = self.chain.head();
        let link = entry_hash(&prev_hash, index, &input, &self.ruleset_hash);
        let state_root = self.state.root();
        let summary = self.state.summary();
        self.chain.push(input, link, self.ruleset_hash);
        self.seqs.push(seq);
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
    /// `logged` is the entry's global seq on the replay path and `None` for a new append.
    fn apply_local(&mut self, input: &Input, logged: Option<u64>) -> Result<(), EngineError> {
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
            Input::ImportItem { token_id, item_id, amount, nonce } => {
                self.credit_inbound(*token_id, *nonce, |engine| engine.credit_item(*token_id, *item_id, *amount))
            }
            Input::BagImport { token_id, item_id, amount } => self.credit_item(*token_id, *item_id, *amount),
            Input::BagExport { token_id, item_id, amount } => self.debit_item(*token_id, *item_id, *amount),
            Input::ExportItem { token_id, item_id, amount } => self.debit_item(*token_id, *item_id, *amount),
            Input::SendItem { from, to, item_id, amount } => self.transfer_item(*from, *to, *item_id, *amount),
            Input::List { .. }
            | Input::Bid { .. }
            | Input::Cancel { .. }
            | Input::Settle { .. }
            | Input::Ask { .. }
            | Input::Fill { .. }
            | Input::Buy { .. }
            | Input::CancelAsk { .. }
            | Input::ReclaimAsk { .. }
            | Input::SendInbox { .. }
            | Input::TakeInbox { .. }
            | Input::ChainFill { .. }
            | Input::PvpBountyOpen { .. }
            | Input::PvpBountyCancel { .. }
            | Input::PvpKill { .. } => Err(EngineError::NotOnCharacterLog),
            // GoldPaidRespec is applied on the character log (gold + skills).
            Input::LevelUp { token_id, level } => self.apply_level(*token_id, *level),
            Input::LearnAbility { token_id, ability_id } => self.learn(*token_id, ability_id),
            Input::Craft { token_id, item_id, amount } => {
                self.note_craft(*token_id, *item_id, *amount, logged)
            }
            Input::Harvest { token_id, material_id, amount } => self.note_harvest(*token_id, material_id, *amount),
            Input::ItemDrop { .. } => Err(EngineError::ClosedMint),
            Input::MobKill { token_id } => {
                self.involves(token_id)?;
                Ok(())
            }
            Input::LootDrop { token_id, item_id, amount, kill_seq } => {
                self.involves(token_id)?;
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                let horizon = logged.unwrap_or(self.chain.len());
                require_prior_mob_kill(
                    self.seqs.iter().copied().zip(self.chain.entries().iter().map(|entry| &entry.input)),
                    token_id,
                    *kill_seq,
                    horizon,
                )?;
                self.note_drop(*token_id, *item_id, *amount)
            }
            Input::CraftSkill { token_id, skill_id, level } => self.note_craft_skill(*token_id, skill_id, *level),
            Input::RespecSkills { token_id, node_ids } => self.respec_skills(*token_id, node_ids),
            Input::GoldEarn { token_id, source, amount, day } => {
                self.involves(token_id)?;
                gold::credit_earn(&mut self.state, source, *amount, *day).map_err(gold_err)
            }
            Input::GoldSpend { token_id, sink, amount } => {
                self.involves(token_id)?;
                gold::debit_spend_for(&mut self.state, sink, *amount).map_err(gold_err)
            }
            Input::GoldSell { token_id, item_id, qty, amount, day } => {
                self.involves(token_id)?;
                gold::sell_item(&mut self.state, *item_id, *qty, *amount, *day).map_err(gold_err)
            }
            Input::GoldPaidRespec { token_id, amount, node_ids } => {
                if node_ids.is_empty() {
                    return Err(EngineError::BadId);
                }
                self.involves(token_id)?;
                gold::debit_spend(&mut self.state, *amount).map_err(gold_err)?;
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

    fn note_craft(
        &mut self,
        token_id: U256,
        item_id: U256,
        amount: U256,
        logged_seq: Option<u64>,
    ) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        if item_id == U256::ZERO {
            return Err(EngineError::BadId);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        // Known catalog recipes: require craft skill rank on new appends / post-cutoff seq.
        // Material burn stays server-side so Harvest roots of committed logs stay identical.
        if craft_skill_validated_at(logged_seq) && item_id.0[..24].iter().all(|b| *b == 0) {
            let id = u64::from_be_bytes(item_id.0[24..].try_into().expect("8 bytes"));
            if let Some(recipe) = crate::craft_recipe_data::craft_recipe(id) {
                if recipe.output_qty == 0 {
                    return Err(EngineError::BadCraftRecipe);
                }
                let skill = crate::craft_recipe_data::skill_label(recipe.skill).ok_or(EngineError::BadId)?;
                let raw = self.state.craft_skill_level(&label_key(skill));
                let have = if raw == 0 { 1 } else { raw };
                if have < u32::from(recipe.level) {
                    return Err(EngineError::BadCraftLevel);
                }
            }
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

    fn note_drop(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        if item_id == U256::ZERO {
            return Err(EngineError::BadId);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        self.state
            .add_count(Key::Drop(item_id), amount)
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

    /// Check the nonce, apply the credit, then record it. A failed credit does not consume the nonce.
    fn credit_inbound(
        &mut self,
        token_id: U256,
        nonce: u64,
        credit: impl FnOnce(&mut Self) -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        self.involves(&token_id)?;
        let next = self.inbound_applied.checked_add(1).ok_or(EngineError::Overflow)?;
        if nonce == 0 || nonce < next {
            return Err(EngineError::ReplayInbound);
        }
        if nonce > next {
            return Err(EngineError::OutOfOrderInbound);
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

pub(crate) fn gold_err(err: GoldError) -> EngineError {
    match err {
        GoldError::ZeroAmount => EngineError::ZeroAmount,
        GoldError::Overflow => EngineError::Overflow,
        GoldError::InsufficientGold => EngineError::InsufficientGold,
        GoldError::InsufficientItem => EngineError::InsufficientItem,
        GoldError::EarnCap => EngineError::EarnCap,
        GoldError::StaleDay => EngineError::StaleDay,
        GoldError::BadDay => EngineError::BadDay,
        GoldError::BadId => EngineError::BadId,
        GoldError::BadPrice => EngineError::BadPrice,
    }
}
