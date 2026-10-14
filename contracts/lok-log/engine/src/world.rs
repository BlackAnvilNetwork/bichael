//! Per-character hash chains for items, KEK, and the auction house.
//!
//! Each character's log starts at that character's genesis root and advances its own
//! index. A transfer or auction is one payload appended to every affected character's
//! log, so each side can checkpoint its own span. Rebasing one character drops only
//! that character's uncommitted tail; another character's committed copy of the trade
//! stays on their chain.
//!
//! KEK enters only through `DepositKek`. `WithdrawKek` decreases spendable KEK
//! (the `kekOut` image) and does not submit an onchain withdrawal. `SpendKek`
//! decreases spendable KEK for an in-game price, is not `kekOut`, and does not mint.
//! Escrowed bids are not spendable. There is no transfer tax and no auction fee.

use std::collections::{BTreeMap, BTreeSet};

use crate::abi::keccak256;
use crate::chain::{Chain, CharacterLogDocument, LoggedEntry, ReplayStop, WorldDocument};
use crate::checkpoint::{Checkpoint, Export};
use crate::engine::{gold_err, parse_label, EngineError};
use crate::event::{entry_hash, item_drop_credits_at, Input};
use crate::gold;
use crate::ids::{genesis_root, world_genesis};
use crate::state::{label_key, Key, State};
use crate::u256::U256;

#[derive(Clone, Debug)]
struct Character {
    starting_job: u8,
    state: State,
    chain: Chain,
    entries: Vec<LoggedEntry>,
    /// Onchain `logIndex`: events `[0, committed)` are committed. Rebase keeps this prefix.
    committed: u64,
    /// Deposit and import nonces consumed on this character. Next accepted nonce is this plus one.
    inbound_applied: u64,
    /// Ability ids recorded on this character. Rebuilt by replay.
    abilities: BTreeSet<String>,
    /// Material id to gathered amount. Rebuilt by replay. Not a spendable balance.
    harvests: BTreeMap<String, U256>,
    /// Craft skill id to level. Rebuilt by replay. Not XP, items, or KEK.
    craft_skills: BTreeMap<String, u32>,
    /// Items waiting at the Provisioner. Not spendable and not in the bag.
    inbox: BTreeMap<U256, U256>,
    /// Skill ids removed by respec and not learned again. Rebuilt by replay.
    dropped_skills: BTreeSet<String>,
    /// Vault attribution still withdrawable by this character. Receipts add to it.
    /// KEK that was sent, spent, or withdrawn is not included.
    vault_claim: U256,
    /// In-game prices (trainer, craft, respec). Not withdrawable and not kekOut.
    sunk_kek: U256,
}

/// An auction listing. The item amount is escrowed out of the seller's spendable
/// balance, and `high_bid` is escrowed out of the bidder's spendable KEK.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listing {
    pub id: U256,
    pub seller: U256,
    pub item_id: U256,
    pub amount: U256,
    pub high_bidder: Option<U256>,
    pub high_bid: U256,
    /// Order-book minimum. Zero on a legacy listing that still uses bid and settle.
    pub min_price: U256,
    /// Unix seconds supplied when the ask was listed. Zero on a legacy listing.
    pub listed_at: u64,
    /// True when this row is an order-book ask. Legacy rows stay on bid and settle.
    pub book: bool,
}

/// Unsold asks can be reclaimed after this many seconds. The log has no clock;
/// the ask event stores the server time and reclaim compares the server time.
pub const ASK_WINDOW_SEC: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterSnapshot {
    pub token_id: U256,
    pub starting_job: u8,
    pub state_root: [u8; 32],
    pub summary: U256,
    /// Spendable KEK. Escrowed bids are not included.
    pub kek: U256,
    /// Spendable KEK plus this character's escrowed bids. This is the solvency counter.
    pub solvency_kek: U256,
    /// Spendable in-game gold. No vault; not KEK.
    pub gold: U256,
}

/// One accepted command, linked onto each affected character's own chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterLink {
    pub token_id: U256,
    pub index: u64,
    pub prev_hash: [u8; 32],
    pub entry_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppliedEvent {
    pub seq: u64,
    pub links: Vec<CharacterLink>,
}

/// Fixed head-bounty for Black Anvil PvP (1 native / 1 xDAI in wei).
pub const PVP_BOUNTY_WEI: u64 = 1_000_000_000_000_000_000;

/// Open PvP bounty tracked by the world (mirror of on-chain escrow; no ETH on the log).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenPvpBounty {
    pub amount_wei: U256,
    pub area_id: String,
}

#[derive(Clone, Debug)]
pub struct World {
    characters: BTreeMap<U256, Character>,
    listings: BTreeMap<U256, Listing>,
    /// token_id → open head-bounty. Rebuilt by replay. No settlement balance.
    pvp_bounties: BTreeMap<U256, OpenPvpBounty>,
    next_seq: u64,
}

impl World {
    pub fn new() -> Self {
        Self {
            characters: BTreeMap::new(),
            listings: BTreeMap::new(),
            pvp_bounties: BTreeMap::new(),
            next_seq: 0,
        }
    }

    pub fn genesis(&self) -> [u8; 32] {
        world_genesis()
    }

    /// Commitment of every character head, in token order. Empty worlds use `LOK_WORLD_V1`.
    /// This is not a character's checkpoint hash.
    pub fn head(&self) -> [u8; 32] {
        if self.characters.is_empty() {
            return world_genesis();
        }
        let mut raw = Vec::new();
        for (token_id, ch) in &self.characters {
            raw.extend_from_slice(&token_id.0);
            raw.extend_from_slice(&ch.chain.head());
        }
        keccak256(&raw)
    }

    /// How many commands were accepted. A transfer counts once, even though two logs advance.
    pub fn len(&self) -> u64 {
        let mut seqs = BTreeSet::new();
        for ch in self.characters.values() {
            for entry in &ch.entries {
                seqs.insert(entry.seq);
            }
        }
        seqs.len() as u64
    }

    /// Spendable KEK. Bids in escrow are not included; they sit on the listing.
    pub fn kek_balance(&self, token_id: &U256) -> Option<U256> {
        self.characters.get(token_id).map(|c| c.state.get(&Key::Kek))
    }

    /// Spendable in-game gold.
    pub fn gold_balance(&self, token_id: &U256) -> Option<U256> {
        self.characters.get(token_id).map(|c| c.state.get(&Key::Gold))
    }

    /// Spendable KEK plus escrowed bids. Vault solvency counts this, not spendable alone.
    pub fn solvency_kek(&self, token_id: &U256) -> Option<U256> {
        let spendable = self.kek_balance(token_id)?;
        Some(
            spendable
                .checked_add(escrowed_bids(&self.listings, token_id))
                .expect("solvency overflow"),
        )
    }

    /// Spendable items. A listed quantity is escrowed and is not returned here,
    /// so it cannot be transferred, exported, or listed again.
    pub fn item_balance(&self, token_id: &U256, item_id: &U256) -> Option<U256> {
        self.characters.get(token_id).map(|c| c.state.get(&Key::Item(*item_id)))
    }

    pub fn level(&self, token_id: &U256) -> Option<u32> {
        self.characters.get(token_id).map(|c| c.state.level_u32())
    }

    pub fn knows(&self, token_id: &U256, ability_id: &str) -> bool {
        self.characters
            .get(token_id)
            .map(|c| c.abilities.contains(ability_id))
            .unwrap_or(false)
    }

    pub fn abilities_of(&self, token_id: &U256) -> Vec<String> {
        self.characters
            .get(token_id)
            .map(|c| c.abilities.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn crafted(&self, token_id: &U256, item_id: &U256) -> Option<U256> {
        self.characters.get(token_id).map(|c| c.state.get(&Key::Craft(*item_id)))
    }

    pub fn crafts_of(&self, token_id: &U256) -> Vec<(U256, U256)> {
        self.character_state(token_id).map(|state| state.crafts()).unwrap_or_default()
    }

    pub fn dropped(&self, token_id: &U256, item_id: &U256) -> Option<U256> {
        self.characters.get(token_id).map(|c| c.state.get(&Key::Drop(*item_id)))
    }

    pub fn drops_of(&self, token_id: &U256) -> Vec<(U256, U256)> {
        self.character_state(token_id).map(|state| state.drops()).unwrap_or_default()
    }

    pub fn harvested(&self, token_id: &U256, material_id: &str) -> Option<U256> {
        self.characters.get(token_id).map(|c| c.harvests.get(material_id).copied().unwrap_or(U256::ZERO))
    }

    pub fn harvests_of(&self, token_id: &U256) -> Vec<(String, U256)> {
        self.characters
            .get(token_id)
            .map(|c| c.harvests.iter().map(|(k, v)| (k.clone(), *v)).collect())
            .unwrap_or_default()
    }

    pub fn craft_skill_level(&self, token_id: &U256, skill_id: &str) -> u32 {
        self.characters
            .get(token_id)
            .and_then(|c| c.craft_skills.get(skill_id).copied())
            .unwrap_or(0)
    }

    pub fn craft_skills_of(&self, token_id: &U256) -> Vec<(String, u32)> {
        self.characters
            .get(token_id)
            .map(|c| c.craft_skills.iter().map(|(k, v)| (k.clone(), *v)).collect())
            .unwrap_or_default()
    }

    pub fn listing(&self, id: &U256) -> Option<&Listing> {
        self.listings.get(id)
    }

    pub fn listings(&self) -> impl Iterator<Item = &Listing> {
        self.listings.values()
    }

    /// Open PvP head-bounty for a character, if any.
    pub fn pvp_bounty(&self, token_id: &U256) -> Option<&OpenPvpBounty> {
        self.pvp_bounties.get(token_id)
    }

    /// All open PvP bounties (token_id, bounty).
    pub fn pvp_bounties(&self) -> impl Iterator<Item = (&U256, &OpenPvpBounty)> {
        self.pvp_bounties.iter()
    }

    /// Spendable item balances for one character. Listed stacks are not included.
    pub fn spendable_items(&self, token_id: &U256) -> Vec<(U256, U256)> {
        match self.character_state(token_id) {
            Some(state) => state.items(),
            None => Vec::new(),
        }
    }

    pub fn character_state(&self, token_id: &U256) -> Option<&State> {
        self.characters.get(token_id).map(|c| &c.state)
    }

    pub fn character_len(&self, token_id: &U256) -> Option<u64> {
        self.characters.get(token_id).map(|ch| ch.entries.len() as u64)
    }

    pub fn character_head(&self, token_id: &U256) -> Option<[u8; 32]> {
        self.characters.get(token_id).map(|ch| ch.chain.head())
    }

    pub fn character_entries(&self, token_id: &U256) -> Option<&[LoggedEntry]> {
        self.characters.get(token_id).map(|ch| ch.entries.as_slice())
    }

    pub fn committed_index(&self, token_id: &U256) -> Option<u64> {
        self.characters.get(token_id).map(|ch| ch.committed)
    }

    /// How many inbound nonces (KEK deposits and item imports) this character has consumed.
    pub fn inbound_applied(&self, token_id: &U256) -> Option<u64> {
        self.characters.get(token_id).map(|ch| ch.inbound_applied)
    }

    /// KEK this character can still withdraw. Sent and spent KEK is not included.
    pub fn vault_claim(&self, token_id: &U256) -> Option<U256> {
        self.characters.get(token_id).map(|ch| ch.vault_claim)
    }

    /// KEK removed from this character by an in-game price.
    pub fn sunk_kek(&self, token_id: &U256) -> Option<U256> {
        self.characters.get(token_id).map(|ch| ch.sunk_kek)
    }

    pub fn snapshots(&self) -> Vec<CharacterSnapshot> {
        self.characters
            .iter()
            .map(|(token_id, ch)| CharacterSnapshot {
                token_id: *token_id,
                starting_job: ch.starting_job,
                state_root: ch.state.root(),
                summary: ch.state.summary(),
                kek: ch.state.get(&Key::Kek),
                solvency_kek: ch
                    .state
                    .get(&Key::Kek)
                    .checked_add(escrowed_bids(&self.listings, token_id))
                    .expect("solvency overflow"),
                gold: ch.state.get(&Key::Gold),
            })
            .collect()
    }

    pub fn to_document(&self) -> WorldDocument {
        WorldDocument {
            characters: self
                .characters
                .iter()
                .map(|(token_id, ch)| CharacterLogDocument {
                    token_id: *token_id,
                    starting_job: ch.starting_job,
                    entries: ch.entries.clone(),
                })
                .collect(),
        }
    }

    pub fn append_spawn(&mut self, token_id: U256, starting_job: u8) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::Spawn { token_id, starting_job })
    }

    pub fn append_deposit_kek(&mut self, token_id: U256, amount: U256, nonce: u64) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::DepositKek { token_id, amount, nonce })
    }

    pub fn append_withdraw_kek(&mut self, token_id: U256, amount: U256) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::WithdrawKek { token_id, amount })
    }

    /// Debit spendable KEK for an in-game price. Not a withdrawal and not a mint.
    pub fn append_spend_kek(&mut self, token_id: U256, amount: U256) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::SpendKek { token_id, amount })
    }

    /// Credit in-game gold from a faucet. Enforces daily earn caps for `day`.
    pub fn append_gold_earn(
        &mut self,
        token_id: U256,
        source: String,
        amount: U256,
        day: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::GoldEarn { token_id, source, amount, day })
    }

    /// Debit in-game gold for a sink.
    pub fn append_gold_spend(
        &mut self,
        token_id: U256,
        sink: String,
        amount: U256,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::GoldSpend { token_id, sink, amount })
    }

    /// NPC buy-back: burn items, credit gold under the npc_sell earn cap.
    pub fn append_gold_sell(
        &mut self,
        token_id: U256,
        item_id: U256,
        qty: U256,
        amount: U256,
        day: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::GoldSell { token_id, item_id, qty, amount, day })
    }

    /// Debit spendable KEK and clear skill nodes together. Not a withdrawal and not a mint.
    pub fn append_paid_respec_skills(
        &mut self,
        token_id: U256,
        amount: U256,
        node_ids: Vec<String>,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::PaidRespecSkills { token_id, amount, node_ids })
    }

    pub fn append_import_item(
        &mut self,
        token_id: U256,
        item_id: U256,
        amount: U256,
        nonce: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::ImportItem { token_id, item_id, amount, nonce })
    }

    /// Credit a bag stack onto the log without a chain inbound nonce.
    pub fn append_bag_import(
        &mut self,
        token_id: U256,
        item_id: U256,
        amount: U256,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::BagImport { token_id, item_id, amount })
    }

    pub fn append_export_item(
        &mut self,
        token_id: U256,
        item_id: U256,
        amount: U256,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::ExportItem { token_id, item_id, amount })
    }

    pub fn append_send_item(
        &mut self,
        from: U256,
        to: U256,
        item_id: U256,
        amount: U256,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::SendItem { from, to, item_id, amount })
    }

    pub fn append_send_kek(&mut self, from: U256, to: U256, amount: U256) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::SendKek { from, to, amount })
    }

    pub fn append_list(
        &mut self,
        listing_id: U256,
        seller: U256,
        item_id: U256,
        amount: U256,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::List { listing_id, seller, item_id, amount })
    }

    pub fn append_bid(&mut self, listing_id: U256, bidder: U256, amount: U256) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::Bid { listing_id, bidder, amount })
    }

    pub fn append_cancel(&mut self, listing_id: U256, seller: U256) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::Cancel { listing_id, seller })
    }

    pub fn append_settle(&mut self, listing_id: U256) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::Settle { listing_id })
    }

    pub fn append_ask(
        &mut self,
        listing_id: U256,
        seller: U256,
        item_id: U256,
        amount: U256,
        min_price: U256,
        listed_at: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::Ask { listing_id, seller, item_id, amount, min_price, listed_at })
    }

    /// Fill the cheapest ask of item_id that this bidder does not own and whose minimum is at most mount.
    pub fn append_fill(&mut self, bidder: U256, item_id: U256, amount: U256) -> Result<AppliedEvent, EngineError> {
        let chosen = self.choose_ask(bidder, item_id, amount)?;
        self.apply(Input::Fill {
            bidder,
            item_id,
            amount: chosen.min_price,
            listing_id: chosen.id,
        })
    }

    /// Buy the cheapest open ask. Pays the ask price. Equal asks fill the oldest.
    pub fn append_buy(&mut self, bidder: U256, item_id: U256) -> Result<AppliedEvent, EngineError> {
        let chosen = self.choose_lowest_ask(bidder, item_id)?;
        self.apply(Input::Buy { bidder, item_id, listing_id: chosen.id })
    }

    /// Mirror an AhEscrow on-chain fill: item to buyer inbox, no Kek/ETH on the log.
    pub fn append_chain_fill(
        &mut self,
        listing_id: U256,
        buyer: U256,
        price_wei: U256,
        item_id: U256,
        amount: U256,
        seller: U256,
        tx_hash: [u8; 32],
        log_index: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::ChainFill {
            listing_id,
            buyer,
            price_wei,
            item_id,
            amount,
            seller,
            tx_hash,
            log_index,
        })
    }

    /// Mirror an on-chain PvP bounty escrow open. No ETH on the log.
    pub fn append_pvp_bounty_open(
        &mut self,
        token_id: U256,
        amount_wei: U256,
        area_id: String,
        tx_hash: [u8; 32],
        log_index: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::PvpBountyOpen {
            token_id,
            amount_wei,
            area_id,
            tx_hash,
            log_index,
        })
    }

    /// Mirror an on-chain PvP bounty cancel/refund. No ETH on the log.
    pub fn append_pvp_bounty_cancel(
        &mut self,
        token_id: U256,
        area_id: String,
        tx_hash: [u8; 32],
        log_index: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::PvpBountyCancel {
            token_id,
            area_id,
            tx_hash,
            log_index,
        })
    }

    /// Mirror an on-chain PvP bounty claim after a slay. No ETH on the log.
    pub fn append_pvp_kill(
        &mut self,
        victim: U256,
        slayer: U256,
        area_id: String,
        amount_wei: U256,
        tx_hash: [u8; 32],
        log_index: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::PvpKill {
            victim,
            slayer,
            area_id,
            amount_wei,
            tx_hash,
            log_index,
        })
    }

    pub fn append_gold_paid_respec(
        &mut self,
        token_id: U256,
        amount: U256,
        node_ids: Vec<String>,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::GoldPaidRespec { token_id, amount, node_ids })
    }

    pub fn append_cancel_ask(&mut self, listing_id: U256, seller: U256) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::CancelAsk { listing_id, seller })
    }

    pub fn append_reclaim_ask(
        &mut self,
        listing_id: U256,
        seller: U256,
        now: u64,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::ReclaimAsk { listing_id, seller, now })
    }

    pub fn append_send_inbox(
        &mut self,
        from: U256,
        to: U256,
        item_id: U256,
        amount: U256,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::SendInbox { from, to, item_id, amount })
    }

    pub fn append_take_inbox(
        &mut self,
        token_id: U256,
        item_id: U256,
        amount: U256,
    ) -> Result<AppliedEvent, EngineError> {
        self.apply(Input::TakeInbox { token_id, item_id, amount })
    }

    pub fn inbox_balance(&self, token_id: &U256, item_id: &U256) -> Option<U256> {
        self.characters.get(token_id).map(|c| c.inbox.get(item_id).copied().unwrap_or(U256::ZERO))
    }

    pub fn inbox_of(&self, token_id: &U256) -> Vec<(U256, U256)> {
        self.characters
            .get(token_id)
            .map(|c| c.inbox.iter().map(|(id, amount)| (*id, *amount)).collect())
            .unwrap_or_default()
    }

    pub fn dropped_skills_of(&self, token_id: &U256) -> Vec<String> {
        self.characters
            .get(token_id)
            .map(|c| c.dropped_skills.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Apply one command. On failure nothing is appended to any character log.
    pub fn apply(&mut self, input: Input) -> Result<AppliedEvent, EngineError> {
        let touch = self.affected(&input)?;
        let characters = self.characters.clone();
        let listings = self.listings.clone();
        if let Err(err) = self.effects(&input, &touch, None) {
            self.characters = characters;
            self.listings = listings;
            return Err(err);
        }
        let seq = self.next_seq;
        Ok(self.link_at(&input, &touch, seq))
    }

    /// Draft the checkpoint for `(committed, to_index]`. Does not mark it committed.
    pub fn checkpoint_span(&self, token_id: &U256, to_index: u64) -> Result<Checkpoint, EngineError> {
        let from_index = self.characters.get(token_id).ok_or(EngineError::NotSpawned)?.committed;
        self.checkpoint_covering(token_id, from_index, to_index)
    }

    /// Draft the checkpoint for `[from_index, to_index)`. `from_index` is the on-chain log position.
    pub fn checkpoint_covering(
        &self,
        token_id: &U256,
        from_index: u64,
        to_index: u64,
    ) -> Result<Checkpoint, EngineError> {
        let ch = self.characters.get(token_id).ok_or(EngineError::NotSpawned)?;
        if to_index <= from_index || to_index > ch.entries.len() as u64 {
            return Err(EngineError::BadRange);
        }
        let prev_root = self.root_at(token_id, from_index)?;
        let (new_root, summary) = self.projection_at(token_id, to_index)?;
        let log_hash = ch.entries[to_index as usize - 1].hash;
        let mut kek_out = U256::ZERO;
        let mut exports = Vec::new();
        // SpendKek is an in-game sink. It must not become kekOut, or a checkpoint would
        // queue a vault withdrawal of KEK the player already spent.
        for entry in &ch.entries[from_index as usize..to_index as usize] {
            match &entry.input {
                Input::WithdrawKek { token_id: who, amount } if who == token_id => {
                    kek_out = kek_out.checked_add(*amount).ok_or(EngineError::Overflow)?;
                }
                Input::ExportItem { token_id: who, item_id, amount } if who == token_id => {
                    exports.push(Export {
                        item_id: *item_id,
                        amount: fit_u32(*amount)?,
                    });
                }
                _ => {}
            }
        }
        Ok(Checkpoint {
            prev_root,
            new_root,
            from_index,
            to_index,
            log_hash,
            ruleset_hash: [0u8; 32],
            summary,
            inbound_consumed: inbound_count(&ch.entries[..to_index as usize], token_id),
            kek_out,
            exports,
        })
    }

    /// Record that `[0, to_index)` of this character's log is committed on chain.
    pub fn commit_span(&mut self, token_id: U256, to_index: u64) -> Result<Checkpoint, EngineError> {
        let checkpoint = self.checkpoint_span(&token_id, to_index)?;
        self.characters.get_mut(&token_id).expect("checkpoint found the character").committed = to_index;
        Ok(checkpoint)
    }

    /// Drop this character's uncommitted tail and rebuild from the logs that remain.
    ///
    /// Conservation rule: Spawn is never dropped. An event is never dropped if any character has committed it, or if a
    /// committed event depends on it. Dependencies are (1) earlier entries on the same chain,
    /// (2) the other participants' copies of the same payload (same `seq`), and (3) earlier
    /// events on the same auction listing. Those events stay as a pinned, still-uncommitted tail
    /// of this character's log. Everything else in the tail is dropped, and so is anything that
    /// depends on a dropped event, on any character's chain. Each chain is only ever truncated,
    /// so surviving hashes stay valid.
    ///
    /// Without this a rebase after a one-sided commit would drop a debit that a counterparty has
    /// already committed the matching credit for, creating KEK or items from nothing.
    pub fn rebase(&mut self, token_id: U256) -> Result<(), EngineError> {
        if !self.characters.contains_key(&token_id) {
            return Err(EngineError::NotSpawned);
        }
        let committed: BTreeMap<U256, u64> = self.characters.iter().map(|(id, ch)| (*id, ch.committed)).collect();

        // seq -> listing id, and listing id -> seqs, for dependency tracking.
        let mut seq_listing: BTreeMap<u64, U256> = BTreeMap::new();
        for ch in self.characters.values() {
            for e in &ch.entries {
                if let Some(id) = listing_id_of(&e.input) {
                    seq_listing.insert(e.seq, id);
                }
            }
        }

        // 1. Required set: every committed seq plus everything those depend on, to a fixed point.
        let mut required: BTreeSet<u64> = BTreeSet::new();
        for ch in self.characters.values() {
            for e in &ch.entries[..ch.committed as usize] {
                required.insert(e.seq);
            }
            // Spawn is the character's existence (its onchain genesis); a rebase never removes it.
            for e in &ch.entries {
                if matches!(e.input, Input::Spawn { .. }) {
                    required.insert(e.seq);
                }
            }
        }
        loop {
            let before = required.len();
            for ch in self.characters.values() {
                // (1)+(2): a chain keeps a prefix, so everything before its last required entry is required.
                if let Some(last) = ch.entries.iter().rposition(|e| required.contains(&e.seq)) {
                    for e in &ch.entries[..=last] {
                        required.insert(e.seq);
                    }
                }
            }
            // (3): earlier events on the same listing as a required event.
            let mut max_required_per_listing: BTreeMap<U256, u64> = BTreeMap::new();
            for seq in &required {
                if let Some(id) = seq_listing.get(seq) {
                    let m = max_required_per_listing.entry(*id).or_insert(*seq);
                    if *seq > *m {
                        *m = *seq;
                    }
                }
            }
            for (seq, id) in &seq_listing {
                if let Some(max) = max_required_per_listing.get(id) {
                    if seq <= max {
                        required.insert(*seq);
                    }
                }
            }
            if required.len() == before {
                break;
            }
        }

        // 2. Dropped set: this character's tail minus required, then everything that depends on it.
        let mut dropped: BTreeSet<u64> = BTreeSet::new();
        {
            let ch = &self.characters[&token_id];
            for e in &ch.entries[ch.committed as usize..] {
                if !required.contains(&e.seq) {
                    dropped.insert(e.seq);
                }
            }
        }
        let mut keep_len: BTreeMap<U256, usize> =
            self.characters.iter().map(|(id, ch)| (*id, ch.entries.len())).collect();
        loop {
            let before = dropped.len();
            // A dropped listing event drops every later event on that listing.
            let dropped_listings: BTreeMap<U256, u64> = dropped
                .iter()
                .filter_map(|seq| seq_listing.get(seq).map(|id| (*id, *seq)))
                .fold(BTreeMap::new(), |mut acc, (id, seq)| {
                    let m = acc.entry(id).or_insert(seq);
                    if seq < *m {
                        *m = seq;
                    }
                    acc
                });
            for (seq, id) in &seq_listing {
                if let Some(first) = dropped_listings.get(id) {
                    if seq >= first {
                        dropped.insert(*seq);
                    }
                }
            }
            // Truncate each chain at its first dropped entry; the rest of that chain depends on it.
            for (id, ch) in &self.characters {
                if let Some(first) = ch.entries.iter().position(|e| dropped.contains(&e.seq)) {
                    for e in &ch.entries[first..] {
                        dropped.insert(e.seq);
                    }
                    let k = keep_len.get_mut(id).expect("keep_len has every character");
                    *k = (*k).min(first);
                }
            }
            if dropped.len() == before {
                break;
            }
        }
        // Required events can never be in the dropped set (required is closed under every dependency).
        for (id, ch) in &self.characters {
            if keep_len[id] < ch.committed as usize {
                return Err(EngineError::ConflictingLog);
            }
        }

        let mut doc = self.to_document();
        for character in &mut doc.characters {
            character.entries.truncate(keep_len[&character.token_id]);
        }
        let mut rebuilt = World::load(&doc).map_err(|_| EngineError::ConflictingLog)?;
        for (id, n) in committed {
            if let Some(ch) = rebuilt.characters.get_mut(&id) {
                ch.committed = n.min(ch.entries.len() as u64);
            }
        }
        // Keep sequence numbers monotonic so a dropped seq is never reused against a surviving copy.
        rebuilt.next_seq = rebuilt.next_seq.max(self.next_seq);
        *self = rebuilt;
        Ok(())
    }

    pub(crate) fn load(doc: &WorldDocument) -> Result<World, ReplayStop> {
        let mut world = World::new();
        let mut head: BTreeMap<U256, [u8; 32]> = BTreeMap::new();
        let mut next_index: BTreeMap<U256, u64> = BTreeMap::new();
        let mut seen = BTreeSet::new();
        for character in &doc.characters {
            if !seen.insert(character.token_id) {
                return Err(ReplayStop::Rejected {
                    index: 0,
                    reason: EngineError::ConflictingLog,
                });
            }
            head.insert(character.token_id, genesis_root(&character.token_id, character.starting_job));
            next_index.insert(character.token_id, 0);
            let mut last_seq: Option<u64> = None;
            for entry in &character.entries {
                if let Some(prev) = last_seq {
                    if entry.seq <= prev {
                        return Err(ReplayStop::Rejected {
                            index: entry.seq,
                            reason: EngineError::ConflictingLog,
                        });
                    }
                }
                last_seq = Some(entry.seq);
            }
        }

        let mut groups: BTreeMap<u64, (Input, BTreeMap<U256, [u8; 32]>)> = BTreeMap::new();
        for character in &doc.characters {
            for entry in &character.entries {
                match groups.get_mut(&entry.seq) {
                    Some((input, tokens)) => {
                        if input != &entry.input {
                            return Err(ReplayStop::Rejected {
                                index: entry.seq,
                                reason: EngineError::ConflictingLog,
                            });
                        }
                        if tokens.insert(character.token_id, entry.hash).is_some() {
                            return Err(ReplayStop::Rejected {
                                index: entry.seq,
                                reason: EngineError::ConflictingLog,
                            });
                        }
                    }
                    None => {
                        let mut tokens = BTreeMap::new();
                        tokens.insert(character.token_id, entry.hash);
                        groups.insert(entry.seq, (entry.input.clone(), tokens));
                    }
                }
            }
        }

        for (seq, (input, tokens)) in groups {
            let touch: BTreeSet<U256> = tokens.keys().copied().collect();
            for (token, hash) in &tokens {
                let prev = head[token];
                let index = next_index[token];
                let computed = entry_hash(&prev, index, &input);
                if computed != *hash {
                    return Err(ReplayStop::BadHash {
                        index,
                        expected: *hash,
                        computed,
                    });
                }
            }
            world
                .effects(&input, &touch, Some(seq))
                .map_err(|reason| ReplayStop::Rejected { index: seq, reason })?;
            let event = world.link_at(&input, &touch, seq);
            for link in &event.links {
                let expected = tokens[&link.token_id];
                if link.entry_hash != expected {
                    return Err(ReplayStop::BadHash {
                        index: link.index,
                        expected,
                        computed: link.entry_hash,
                    });
                }
                head.insert(link.token_id, link.entry_hash);
                *next_index.get_mut(&link.token_id).expect("index") += 1;
            }
        }
        Ok(world)
    }

    fn affected(&self, input: &Input) -> Result<BTreeSet<U256>, EngineError> {
        let mut touch = BTreeSet::new();
        match input {
            Input::Spawn { token_id, .. } => {
                if self.characters.contains_key(token_id) {
                    return Err(EngineError::AlreadySpawned);
                }
                touch.insert(*token_id);
            }
            Input::DepositKek { token_id, amount, .. }
            | Input::WithdrawKek { token_id, amount }
            | Input::SpendKek { token_id, amount } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::ImportItem { token_id, amount, .. } | Input::ExportItem { token_id, amount, .. } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::SendKek { from, to, amount } | Input::SendItem { from, to, amount, .. } => {
                if from == to {
                    return Err(EngineError::SelfTransfer);
                }
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if !self.characters.contains_key(from) || !self.characters.contains_key(to) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*from);
                touch.insert(*to);
            }
            Input::List { listing_id, seller, item_id, amount } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if !self.characters.contains_key(seller) {
                    return Err(EngineError::NotSpawned);
                }
                if self.listings.contains_key(listing_id) {
                    return Err(EngineError::ListingExists);
                }
                if self.listings.values().any(|l| l.seller == *seller && l.item_id == *item_id) {
                    return Err(EngineError::AlreadyListed);
                }
                touch.insert(*seller);
            }
            Input::Bid { listing_id, bidder, amount } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                let listing = self.listings.get(listing_id).ok_or(EngineError::UnknownListing)?;
                if *amount <= listing.high_bid {
                    return Err(EngineError::BidNotHigher);
                }
                if !self.characters.contains_key(bidder) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*bidder);
                if let Some(prev) = listing.high_bidder {
                    touch.insert(prev);
                }
            }
            Input::Cancel { listing_id, seller } => {
                let listing = self.listings.get(listing_id).ok_or(EngineError::UnknownListing)?;
                if listing.seller != *seller {
                    return Err(EngineError::NotSeller);
                }
                touch.insert(*seller);
                if let Some(prev) = listing.high_bidder {
                    touch.insert(prev);
                }
            }
            Input::Settle { listing_id } => {
                let listing = self.listings.get(listing_id).ok_or(EngineError::UnknownListing)?;
                let winner = listing.high_bidder.ok_or(EngineError::NoBid)?;
                touch.insert(winner);
                touch.insert(listing.seller);
            }
            Input::LevelUp { token_id, level } => {
                if *level == 0 || *level > 65535 {
                    return Err(EngineError::BadLevel);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::LearnAbility { token_id, ability_id } => {
                parse_label(ability_id)?;
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            // A new ItemDrop append is closed. Logged ItemDrop entries replay through
            // load() -> effects(), which never calls affected(); effects() credits them only at
            // seq <= HISTORICAL_ITEM_DROP_MAX_SEQ.
            Input::ItemDrop { .. } => return Err(EngineError::ClosedMint),
            Input::LootDrop { token_id, item_id, amount } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::BagImport { token_id, item_id, amount } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::Craft { token_id, item_id, amount } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::Harvest { token_id, material_id, amount } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                parse_label(material_id)?;
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::CraftSkill { token_id, skill_id, level } => {
                parse_label(skill_id)?;
                if *level == 0 || *level > 65535 {
                    return Err(EngineError::BadCraftSkill);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::RespecSkills { token_id, node_ids } => {
                if node_ids.len() > 600 {
                    return Err(EngineError::BadId);
                }
                for id in node_ids {
                    parse_label(id)?;
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::PaidRespecSkills { token_id, amount, node_ids } => {
                if node_ids.is_empty() {
                    return Err(EngineError::BadId);
                }
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if node_ids.len() > 600 {
                    return Err(EngineError::BadId);
                }
                for id in node_ids {
                    parse_label(id)?;
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::GoldEarn { token_id, source, amount, day } => {
                parse_label(source)?;
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *day == 0 || *day > crate::gold::GOLD_MAX_DAY {
                    return Err(EngineError::BadDay);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::GoldSpend { token_id, sink, amount } => {
                parse_label(sink)?;
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::GoldSell { token_id, item_id, qty, amount, day } => {
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                if *qty == U256::ZERO || *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *day == 0 || *day > crate::gold::GOLD_MAX_DAY {
                    return Err(EngineError::BadDay);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::Ask { listing_id, seller, item_id, amount, min_price, listed_at } => {
                if *amount == U256::ZERO || *min_price == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *item_id == U256::ZERO || *listing_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                if *listed_at == 0 {
                    return Err(EngineError::BadClock);
                }
                if self.listings.contains_key(listing_id) {
                    return Err(EngineError::ListingExists);
                }
                if !self.characters.contains_key(seller) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*seller);
            }
            Input::Fill { bidder, item_id, amount, listing_id } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                let chosen = self.choose_ask(*bidder, *item_id, *amount)?;
                if chosen.id != *listing_id || *amount != chosen.min_price {
                    return Err(if *amount != chosen.min_price { EngineError::OverAsk } else { EngineError::NoAsk });
                }
                if !self.characters.contains_key(bidder) || !self.characters.contains_key(&chosen.seller) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*bidder);
                touch.insert(chosen.seller);
            }
            Input::Buy { bidder, item_id, listing_id } => {
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                let chosen = self.choose_lowest_ask(*bidder, *item_id)?;
                if chosen.id != *listing_id {
                    return Err(EngineError::NoAsk);
                }
                if !self.characters.contains_key(bidder) || !self.characters.contains_key(&chosen.seller) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*bidder);
                touch.insert(chosen.seller);
            }
            Input::ChainFill {
                listing_id,
                buyer,
                price_wei,
                item_id,
                amount,
                seller,
                tx_hash: _,
                log_index: _,
            } => {
                if *price_wei == U256::ZERO || *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *item_id == U256::ZERO || *listing_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                let listing = self.listings.get(listing_id).ok_or(EngineError::UnknownListing)?;
                if !listing.book {
                    return Err(EngineError::UnknownListing);
                }
                if listing.seller == *buyer {
                    return Err(EngineError::SelfTransfer);
                }
                if *price_wei != listing.min_price {
                    return Err(EngineError::OverAsk);
                }
                if *item_id != listing.item_id || *amount != listing.amount || *seller != listing.seller {
                    return Err(EngineError::FillMismatch);
                }
                if !self.characters.contains_key(buyer) || !self.characters.contains_key(seller) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*buyer);
                touch.insert(*seller);
            }
            Input::GoldPaidRespec { token_id, amount, node_ids } => {
                if *amount == U256::ZERO || node_ids.is_empty() {
                    return Err(EngineError::BadId);
                }
                for id in node_ids {
                    parse_label(id)?;
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
            Input::PvpBountyOpen {
                token_id,
                amount_wei,
                area_id,
                tx_hash: _,
                log_index: _,
            } => {
                if *amount_wei != U256::from_u64(PVP_BOUNTY_WEI) {
                    return Err(EngineError::BadBountyAmount);
                }
                parse_label(area_id)?;
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                if self.pvp_bounties.contains_key(token_id) {
                    return Err(EngineError::AlreadyBounty);
                }
                touch.insert(*token_id);
            }
            Input::PvpBountyCancel {
                token_id,
                area_id,
                tx_hash: _,
                log_index: _,
            } => {
                parse_label(area_id)?;
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                let open = self.pvp_bounties.get(token_id).ok_or(EngineError::NoBounty)?;
                if open.area_id != *area_id {
                    return Err(EngineError::BountyMismatch);
                }
                touch.insert(*token_id);
            }
            Input::PvpKill {
                victim,
                slayer,
                area_id,
                amount_wei,
                tx_hash: _,
                log_index: _,
            } => {
                if victim == slayer {
                    return Err(EngineError::SelfTransfer);
                }
                if *amount_wei != U256::from_u64(PVP_BOUNTY_WEI) {
                    return Err(EngineError::BadBountyAmount);
                }
                parse_label(area_id)?;
                if !self.characters.contains_key(victim) || !self.characters.contains_key(slayer) {
                    return Err(EngineError::NotSpawned);
                }
                let open = self.pvp_bounties.get(victim).ok_or(EngineError::NoBounty)?;
                if open.area_id != *area_id || open.amount_wei != *amount_wei {
                    return Err(EngineError::BountyMismatch);
                }
                touch.insert(*victim);
                touch.insert(*slayer);
            }
            Input::CancelAsk { listing_id, seller } => {
                let listing = self.listings.get(listing_id).ok_or(EngineError::UnknownListing)?;
                if !listing.book {
                    return Err(EngineError::UnknownListing);
                }
                if listing.seller != *seller {
                    return Err(EngineError::NotSeller);
                }
                if !self.characters.contains_key(seller) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*seller);
            }
            Input::ReclaimAsk { listing_id, seller, now } => {
                let listing = self.listings.get(listing_id).ok_or(EngineError::UnknownListing)?;
                if !listing.book {
                    return Err(EngineError::UnknownListing);
                }
                if listing.seller != *seller {
                    return Err(EngineError::NotSeller);
                }
                if listing.listed_at == 0 || *now < listing.listed_at.saturating_add(ASK_WINDOW_SEC) {
                    return Err(EngineError::TooSoon);
                }
                if !self.characters.contains_key(seller) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*seller);
            }
            Input::SendInbox { from, to, item_id, amount } => {
                if *from == *to {
                    return Err(EngineError::SelfTransfer);
                }
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                if !self.characters.contains_key(from) || !self.characters.contains_key(to) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*from);
                touch.insert(*to);
            }
            Input::TakeInbox { token_id, item_id, amount } => {
                if *amount == U256::ZERO {
                    return Err(EngineError::ZeroAmount);
                }
                if *item_id == U256::ZERO {
                    return Err(EngineError::BadId);
                }
                if !self.characters.contains_key(token_id) {
                    return Err(EngineError::NotSpawned);
                }
                touch.insert(*token_id);
            }
        }
        Ok(touch)
    }

    /// `logged_seq` is the entry's seq when replaying a log (`load`) and `None` for a new append.
    fn effects(&mut self, input: &Input, touch: &BTreeSet<U256>, logged_seq: Option<u64>) -> Result<(), EngineError> {
        match input {
            Input::Spawn { token_id, starting_job } => {
                if !touch.contains(token_id) {
                    return Ok(());
                }
                if self.characters.contains_key(token_id) {
                    return Err(EngineError::AlreadySpawned);
                }
                let mut state = State::new();
                state.spawn(*token_id, *starting_job);
                self.characters.insert(
                    *token_id,
                    Character {
                        starting_job: *starting_job,
                        state,
                        chain: Chain::new(genesis_root(token_id, *starting_job)),
                        entries: Vec::new(),
                        committed: 0,
                        inbound_applied: 0,
                        abilities: BTreeSet::new(),
                        harvests: BTreeMap::new(),
                        craft_skills: BTreeMap::new(),
                        inbox: BTreeMap::new(),
                        dropped_skills: BTreeSet::new(),
                        vault_claim: U256::ZERO,
                        sunk_kek: U256::ZERO,
                    },
                );
                Ok(())
            }
            Input::DepositKek { token_id, amount, nonce } => {
                if touch.contains(token_id) {
                    self.credit_inbound(*token_id, *nonce, |world| world.credit_kek(*token_id, *amount))?;
                    self.add_claim(*token_id, *amount)?;
                }
                Ok(())
            }
            Input::WithdrawKek { token_id, amount } => {
                if touch.contains(token_id) {
                    self.debit_kek(*token_id, *amount)?;
                    self.sub_claim(*token_id, *amount)?;
                }
                Ok(())
            }
            Input::SpendKek { token_id, amount } => {
                if touch.contains(token_id) {
                    self.debit_kek(*token_id, *amount)?;
                    self.sink_claim(*token_id, *amount)?;
                }
                Ok(())
            }
            Input::ImportItem { token_id, item_id, amount, nonce } => {
                if touch.contains(token_id) {
                    self.credit_inbound(*token_id, *nonce, |world| world.credit_item(*token_id, *item_id, *amount))?;
                }
                Ok(())
            }
            Input::ExportItem { token_id, item_id, amount } => {
                if touch.contains(token_id) {
                    self.debit_item(*token_id, *item_id, *amount)?;
                }
                Ok(())
            }
            Input::SendKek { from, to, amount } => {
                self.transfer_kek(*from, *to, *amount, touch)?;
                self.move_claim(*from, *to, *amount)?;
                Ok(())
            }
            Input::SendItem { from, to, item_id, amount } => {
                self.transfer_item(*from, *to, *item_id, *amount, touch)
            }
            Input::List { listing_id, seller, item_id, amount } => {
                self.list(*listing_id, *seller, *item_id, *amount, touch)
            }
            Input::Bid { listing_id, bidder, amount } => self.bid(*listing_id, *bidder, *amount, touch),
            Input::Cancel { listing_id, seller } => self.cancel(*listing_id, *seller, touch),
            Input::Settle { listing_id } => self.settle(*listing_id, touch),
            Input::LevelUp { token_id, level } => {
                if touch.contains(token_id) {
                    self.apply_level(*token_id, *level)?;
                }
                Ok(())
            }
            Input::LearnAbility { token_id, ability_id } => {
                if touch.contains(token_id) {
                    self.learn(*token_id, ability_id)?;
                }
                Ok(())
            }
            Input::Craft { token_id, item_id, amount } => {
                if touch.contains(token_id) {
                    self.note_craft(*token_id, *item_id, *amount, logged_seq)?;
                }
                Ok(())
            }
            Input::Harvest { token_id, material_id, amount } => {
                if touch.contains(token_id) {
                    self.note_harvest(*token_id, material_id, *amount)?;
                }
                Ok(())
            }
            Input::ItemDrop { token_id, item_id, amount } => {
                // Historical log entries (seq <= HISTORICAL_ITEM_DROP_MAX_SEQ) still credit.
                // A later logged ItemDrop is refused even on replay. affected() refuses a new append.
                if !logged_seq.is_some_and(item_drop_credits_at) {
                    return Err(EngineError::ClosedMint);
                }
                if touch.contains(token_id) {
                    self.credit_item(*token_id, *item_id, *amount)?;
                }
                Ok(())
            }
            Input::LootDrop { token_id, item_id, amount } => {
                // Counter only, like Harvest. Does not credit spendable items or KEK.
                if touch.contains(token_id) {
                    self.note_drop(*token_id, *item_id, *amount)?;
                }
                Ok(())
            }
            Input::BagImport { token_id, item_id, amount } => {
                if touch.contains(token_id) {
                    self.credit_item(*token_id, *item_id, *amount)?;
                }
                Ok(())
            }
            Input::CraftSkill { token_id, skill_id, level } => {
                if touch.contains(token_id) {
                    self.note_craft_skill(*token_id, skill_id, *level)?;
                }
                Ok(())
            }
            Input::RespecSkills { token_id, node_ids } => {
                if touch.contains(token_id) {
                    self.respec_skills(*token_id, node_ids)?;
                }
                Ok(())
            }
            Input::PaidRespecSkills { token_id, amount, node_ids } => {
                if node_ids.is_empty() {
                    return Err(EngineError::BadId);
                }
                if touch.contains(token_id) {
                    self.debit_kek(*token_id, *amount)?;
                    self.sink_claim(*token_id, *amount)?;
                    self.respec_skills(*token_id, node_ids)?;
                }
                Ok(())
            }
            Input::Ask { listing_id, seller, item_id, amount, min_price, listed_at } => {
                self.ask(*listing_id, *seller, *item_id, *amount, *min_price, *listed_at, touch)
            }
            Input::Fill { bidder, item_id, amount, listing_id } => {
                self.fill(*bidder, *item_id, *amount, *listing_id, touch)
            }
            Input::Buy { bidder, item_id, listing_id } => self.buy(*bidder, *item_id, *listing_id, touch),
            Input::ChainFill {
                listing_id,
                buyer,
                price_wei,
                item_id,
                amount,
                seller,
                ..
            } => self.chain_fill(*listing_id, *buyer, *price_wei, *item_id, *amount, *seller, touch),
            Input::PvpBountyOpen {
                token_id,
                amount_wei,
                area_id,
                ..
            } => {
                self.pvp_bounties.insert(
                    *token_id,
                    OpenPvpBounty {
                        amount_wei: *amount_wei,
                        area_id: area_id.clone(),
                    },
                );
                Ok(())
            }
            Input::PvpBountyCancel { token_id, .. } => {
                self.pvp_bounties.remove(token_id);
                Ok(())
            }
            Input::PvpKill { victim, .. } => {
                self.pvp_bounties.remove(victim);
                Ok(())
            }
            Input::GoldPaidRespec { token_id, amount, node_ids } => {
                if touch.contains(token_id) {
                    let ch = self.characters.get_mut(token_id).ok_or(EngineError::NotSpawned)?;
                    gold::debit_spend(&mut ch.state, *amount).map_err(gold_err)?;
                    self.respec_skills(*token_id, node_ids)?;
                }
                Ok(())
            }
            Input::CancelAsk { listing_id, seller } => self.cancel_ask(*listing_id, *seller, touch),
            Input::ReclaimAsk { listing_id, seller, now } => self.reclaim_ask(*listing_id, *seller, *now, touch),
            Input::SendInbox { from, to, item_id, amount } => {
                self.send_inbox(*from, *to, *item_id, *amount, touch)
            }
            Input::TakeInbox { token_id, item_id, amount } => self.take_inbox(*token_id, *item_id, *amount, touch),
            Input::GoldEarn { token_id, source, amount, day } => {
                if touch.contains(token_id) {
                    let ch = self.characters.get_mut(token_id).ok_or(EngineError::NotSpawned)?;
                    gold::credit_earn(&mut ch.state, source, *amount, *day).map_err(gold_err)?;
                }
                Ok(())
            }
            Input::GoldSpend { token_id, sink, amount } => {
                if touch.contains(token_id) {
                    parse_label(sink)?;
                    let ch = self.characters.get_mut(token_id).ok_or(EngineError::NotSpawned)?;
                    gold::debit_spend(&mut ch.state, *amount).map_err(gold_err)?;
                }
                Ok(())
            }
            Input::GoldSell { token_id, item_id, qty, amount, day } => {
                if touch.contains(token_id) {
                    let ch = self.characters.get_mut(token_id).ok_or(EngineError::NotSpawned)?;
                    gold::sell_item(&mut ch.state, *item_id, *qty, *amount, *day).map_err(gold_err)?;
                }
                Ok(())
            }
        }
    }

    fn apply_level(&mut self, token_id: U256, level: u32) -> Result<(), EngineError> {
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        let current = ch.state.level_u32();
        if level == 0 || level > 65535 || current >= 65535 || level != current + 1 {
            return Err(EngineError::BadLevel);
        }
        ch.state.set_level(level);
        Ok(())
    }

    fn learn(&mut self, token_id: U256, ability_id: &str) -> Result<(), EngineError> {
        parse_label(ability_id)?;
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        if !ch.abilities.insert(ability_id.to_string()) {
            return Err(EngineError::AlreadyKnown);
        }
        ch.dropped_skills.remove(ability_id);
        let key = label_key(ability_id);
        if ch.state.knows_ability_key(&key) {
            return Err(EngineError::AlreadyKnown);
        }
        ch.state.mark_ability(key);
        Ok(())
    }

    fn note_craft(
        &mut self,
        token_id: U256,
        item_id: U256,
        amount: U256,
        logged_seq: Option<u64>,
    ) -> Result<(), EngineError> {
        if item_id == U256::ZERO {
            return Err(EngineError::BadId);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        // Known catalog recipes require craft skill on new appends / post-cutoff seq.
        if crate::event::craft_skill_validated_at(logged_seq) && item_id.0[..24].iter().all(|b| *b == 0) {
            let id = u64::from_be_bytes(item_id.0[24..].try_into().expect("8 bytes"));
            if let Some(recipe) = crate::craft_recipe_data::craft_recipe(id) {
                if recipe.output_qty == 0 {
                    return Err(EngineError::BadCraftRecipe);
                }
                let skill = crate::craft_recipe_data::skill_label(recipe.skill).ok_or(EngineError::BadId)?;
                let raw = ch.craft_skills.get(skill).copied().unwrap_or(0);
                let have = if raw == 0 { 1 } else { raw };
                if have < u32::from(recipe.level) {
                    return Err(EngineError::BadCraftLevel);
                }
            }
        }
        ch.state.add_count(Key::Craft(item_id), amount).map_err(|_| EngineError::Overflow)?;
        Ok(())
    }

    fn note_craft_skill(&mut self, token_id: U256, skill_id: &str, level: u32) -> Result<(), EngineError> {
        parse_label(skill_id)?;
        if level == 0 || level > 65535 {
            return Err(EngineError::BadCraftSkill);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        let current = ch.craft_skills.get(skill_id).copied().unwrap_or(0);
        if level <= current {
            return Err(EngineError::BadCraftSkill);
        }
        ch.craft_skills.insert(skill_id.to_string(), level);
        ch.state.set_craft_skill(label_key(skill_id), level);
        Ok(())
    }

    fn respec_skills(&mut self, token_id: U256, node_ids: &[String]) -> Result<(), EngineError> {
        if node_ids.len() > 600 {
            return Err(EngineError::BadId);
        }
        for id in node_ids {
            parse_label(id)?;
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        for id in node_ids {
            ch.abilities.remove(id);
            ch.state.clear_ability(label_key(id));
            ch.dropped_skills.insert(id.clone());
        }
        Ok(())
    }

    fn note_harvest(&mut self, token_id: U256, material_id: &str, amount: U256) -> Result<(), EngineError> {
        parse_label(material_id)?;
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        let next = ch
            .harvests
            .get(material_id)
            .copied()
            .unwrap_or(U256::ZERO)
            .checked_add(amount)
            .ok_or(EngineError::Overflow)?;
        ch.harvests.insert(material_id.to_string(), next);
        ch.state
            .add_count(Key::Harvest(label_key(material_id)), amount)
            .map_err(|_| EngineError::Overflow)?;
        Ok(())
    }

    fn note_drop(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        if item_id == U256::ZERO {
            return Err(EngineError::BadId);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        ch.state.add_count(Key::Drop(item_id), amount).map_err(|_| EngineError::Overflow)?;
        Ok(())
    }

    fn link_at(&mut self, input: &Input, touch: &BTreeSet<U256>, seq: u64) -> AppliedEvent {
        let mut links = Vec::new();
        for token in touch {
            let ch = self.characters.get_mut(token).expect("affected character is spawned");
            let index = ch.chain.len();
            let prev_hash = ch.chain.head();
            let hash = entry_hash(&prev_hash, index, input);
            ch.chain.push(input.clone(), hash);
            ch.entries.push(LoggedEntry {
                hash,
                input: input.clone(),
                seq,
            });
            links.push(CharacterLink {
                token_id: *token,
                index,
                prev_hash,
                entry_hash: hash,
            });
        }
        if self.next_seq <= seq {
            self.next_seq = seq + 1;
        }
        AppliedEvent { seq, links }
    }

    fn root_at(&self, token_id: &U256, index: u64) -> Result<[u8; 32], EngineError> {
        Ok(self.projection_at(token_id, index)?.0)
    }

    fn projection_at(&self, token_id: &U256, index: u64) -> Result<([u8; 32], U256), EngineError> {
        let ch = self.characters.get(token_id).ok_or(EngineError::NotSpawned)?;
        if index > ch.entries.len() as u64 {
            return Err(EngineError::BadRange);
        }
        if index == 0 {
            return Ok((genesis_root(token_id, ch.starting_job), U256::ZERO));
        }
        if index == ch.entries.len() as u64 {
            return Ok((ch.state.root(), ch.state.summary()));
        }
        let seq_limit = ch.entries[index as usize - 1].seq;
        let mut doc = self.to_document();
        for character in &mut doc.characters {
            character.entries.retain(|entry| entry.seq <= seq_limit);
        }
        let replayed = World::load(&doc).map_err(|_| EngineError::ConflictingLog)?;
        let state = replayed.character_state(token_id).ok_or(EngineError::NotSpawned)?;
        Ok((state.root(), state.summary()))
    }

    fn credit_inbound(
        &mut self,
        token_id: U256,
        nonce: u64,
        credit: impl FnOnce(&mut Self) -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        let ch = self.characters.get(&token_id).ok_or(EngineError::NotSpawned)?;
        let next = ch.inbound_applied.checked_add(1).ok_or(EngineError::Overflow)?;
        if nonce == 0 || nonce < next {
            return Err(EngineError::ReplayInbound);
        }
        if nonce > next {
            return Err(EngineError::OutOfOrderInbound);
        }
        credit(self)?;
        self.characters.get_mut(&token_id).expect("inbound character").inbound_applied = nonce;
        Ok(())
    }

    fn add_claim(&mut self, token_id: U256, amount: U256) -> Result<(), EngineError> {
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        ch.vault_claim = ch.vault_claim.checked_add(amount).ok_or(EngineError::Overflow)?;
        Ok(())
    }

    fn sub_claim(&mut self, token_id: U256, amount: U256) -> Result<(), EngineError> {
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        ch.vault_claim = ch.vault_claim.checked_sub(amount).ok_or(EngineError::InsufficientKek)?;
        Ok(())
    }

    fn sink_claim(&mut self, token_id: U256, amount: U256) -> Result<(), EngineError> {
        self.sub_claim(token_id, amount)?;
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        ch.sunk_kek = ch.sunk_kek.checked_add(amount).ok_or(EngineError::Overflow)?;
        Ok(())
    }

    fn move_claim(&mut self, from: U256, to: U256, amount: U256) -> Result<(), EngineError> {
        if from == to {
            return Ok(());
        }
        self.sub_claim(from, amount)?;
        self.add_claim(to, amount)
    }

    /// How many withdraws of this amount are already on the character log.
    pub fn withdraw_count(&self, token_id: U256, amount: U256) -> u64 {
        let Some(ch) = self.characters.get(&token_id) else {
            return 0;
        };
        ch.entries
            .iter()
            .filter(|entry| matches!(&entry.input, Input::WithdrawKek { token_id: who, amount: logged } if who == &token_id && logged == &amount))
            .count() as u64
    }

    /// Drop a withdraw that was appended but never queued. Only the last uncommitted entry.
    pub fn undo_last_withdraw(&mut self, token_id: U256, amount: U256) -> Result<(), EngineError> {
        let ch = self.characters.get(&token_id).ok_or(EngineError::NotSpawned)?;
        let last = ch.entries.last().ok_or(EngineError::BadRange)?;
        match &last.input {
            Input::WithdrawKek { token_id: who, amount: logged } if who == &token_id && logged == &amount => {}
            _ => return Err(EngineError::BadRange),
        }
        if ch.committed >= ch.entries.len() as u64 {
            return Err(EngineError::BadRange);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        ch.entries.pop();
        ch.chain.pop().ok_or(EngineError::BadRange)?;
        self.credit_kek(token_id, amount)?;
        self.add_claim(token_id, amount)?;
        Ok(())
    }

    fn credit_kek(&mut self, token_id: U256, amount: U256) -> Result<(), EngineError> {
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        let next = ch.state.get(&Key::Kek).checked_add(amount).ok_or(EngineError::Overflow)?;
        ch.state.set_kek(next);
        Ok(())
    }

    fn debit_kek(&mut self, token_id: U256, amount: U256) -> Result<(), EngineError> {
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        // Spendable only. Escrowed bids were already removed from this balance, so they
        // cannot be withdrawn.
        let next = ch.state.get(&Key::Kek).checked_sub(amount).ok_or(EngineError::InsufficientKek)?;
        ch.state.set_kek(next);
        Ok(())
    }

    fn credit_item(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        let next = ch
            .state
            .get(&Key::Item(item_id))
            .checked_add(amount)
            .ok_or(EngineError::Overflow)?;
        ch.state.set_item(item_id, next);
        Ok(())
    }

    fn debit_item(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        let next = ch
            .state
            .get(&Key::Item(item_id))
            .checked_sub(amount)
            .ok_or(EngineError::InsufficientItem)?;
        ch.state.set_item(item_id, next);
        Ok(())
    }

    fn transfer_kek(
        &mut self,
        from: U256,
        to: U256,
        amount: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        if from == to {
            return Err(EngineError::SelfTransfer);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        if touch.contains(&from) {
            self.debit_kek(from, amount)?;
        }
        if touch.contains(&to) {
            self.credit_kek(to, amount)?;
        }
        Ok(())
    }

    fn transfer_item(
        &mut self,
        from: U256,
        to: U256,
        item_id: U256,
        amount: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        if from == to {
            return Err(EngineError::SelfTransfer);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        if touch.contains(&from) {
            self.debit_item(from, item_id, amount)?;
        }
        if touch.contains(&to) {
            self.credit_item(to, item_id, amount)?;
        }
        Ok(())
    }

    fn list(
        &mut self,
        listing_id: U256,
        seller: U256,
        item_id: U256,
        amount: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        if self.listings.contains_key(&listing_id) {
            return Err(EngineError::ListingExists);
        }
        if self.listings.values().any(|l| l.seller == seller && l.item_id == item_id) {
            return Err(EngineError::AlreadyListed);
        }
        if touch.contains(&seller) {
            self.debit_item(seller, item_id, amount)?;
        }
        self.listings.insert(
            listing_id,
            Listing {
                id: listing_id,
                seller,
                item_id,
                amount,
                high_bidder: None,
                high_bid: U256::ZERO,
                min_price: U256::ZERO,
                listed_at: 0,
                book: false,
            },
        );
        Ok(())
    }

    fn bid(
        &mut self,
        listing_id: U256,
        bidder: U256,
        amount: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let listing = self
            .listings
            .get(&listing_id)
            .cloned()
            .ok_or(EngineError::UnknownListing)?;
        if listing.book {
            return Err(EngineError::NoAsk);
        }
        if amount <= listing.high_bid {
            return Err(EngineError::BidNotHigher);
        }
        if let Some(prev) = listing.high_bidder {
            if touch.contains(&prev) {
                self.credit_kek(prev, listing.high_bid)?;
            }
        }
        if touch.contains(&bidder) {
            self.debit_kek(bidder, amount)?;
        }
        let listing = self.listings.get_mut(&listing_id).unwrap();
        listing.high_bidder = Some(bidder);
        listing.high_bid = amount;
        Ok(())
    }

    fn cancel(&mut self, listing_id: U256, seller: U256, touch: &BTreeSet<U256>) -> Result<(), EngineError> {
        let listing = self
            .listings
            .get(&listing_id)
            .cloned()
            .ok_or(EngineError::UnknownListing)?;
        if listing.seller != seller {
            return Err(EngineError::NotSeller);
        }
        if listing.book {
            if touch.contains(&listing.seller) {
                self.credit_inbox(listing.seller, listing.item_id, listing.amount)?;
            }
            self.listings.remove(&listing_id);
            return Ok(());
        }
        if touch.contains(&listing.seller) {
            self.credit_item(listing.seller, listing.item_id, listing.amount)?;
        }
        if let Some(prev) = listing.high_bidder {
            if touch.contains(&prev) {
                self.credit_kek(prev, listing.high_bid)?;
            }
        }
        self.listings.remove(&listing_id);
        Ok(())
    }

    fn settle(&mut self, listing_id: U256, touch: &BTreeSet<U256>) -> Result<(), EngineError> {
        let listing = self
            .listings
            .get(&listing_id)
            .cloned()
            .ok_or(EngineError::UnknownListing)?;
        let winner = listing.high_bidder.ok_or(EngineError::NoBid)?;
        if touch.contains(&winner) {
            self.credit_item(winner, listing.item_id, listing.amount)?;
        }
        if touch.contains(&listing.seller) {
            self.credit_kek(listing.seller, listing.high_bid)?;
        }
        self.move_claim(winner, listing.seller, listing.high_bid)?;
        self.listings.remove(&listing_id);
        Ok(())
    }

    pub(crate) fn choose_lowest_ask(&self, bidder: U256, item_id: U256) -> Result<Listing, EngineError> {
        self.choose_ask_capped(bidder, item_id, None)
    }

    pub(crate) fn choose_ask(&self, bidder: U256, item_id: U256, amount: U256) -> Result<Listing, EngineError> {
        self.choose_ask_capped(bidder, item_id, Some(amount))
    }

    fn choose_ask_capped(
        &self,
        bidder: U256,
        item_id: U256,
        max_price: Option<U256>,
    ) -> Result<Listing, EngineError> {
        if !self.characters.contains_key(&bidder) {
            return Err(EngineError::NotSpawned);
        }
        let mut best: Option<&Listing> = None;
        for listing in self.listings.values() {
            if !listing.book || listing.item_id != item_id || listing.seller == bidder {
                continue;
            }
            if max_price.is_some_and(|max| listing.min_price > max) {
                continue;
            }
            best = Some(match best {
                None => listing,
                Some(cur) => {
                    let cheaper = listing.min_price < cur.min_price;
                    let older = listing.min_price == cur.min_price
                        && (listing.listed_at < cur.listed_at
                            || (listing.listed_at == cur.listed_at && listing.id < cur.id));
                    if cheaper || older { listing } else { cur }
                }
            });
        }
        best.cloned().ok_or(EngineError::NoAsk)
    }

    fn ask(
        &mut self,
        listing_id: U256,
        seller: U256,
        item_id: U256,
        amount: U256,
        min_price: U256,
        listed_at: u64,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        if amount == U256::ZERO || min_price == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        if listed_at == 0 {
            return Err(EngineError::BadClock);
        }
        if self.listings.contains_key(&listing_id) {
            return Err(EngineError::ListingExists);
        }
        if touch.contains(&seller) {
            self.debit_item(seller, item_id, amount)?;
        }
        self.listings.insert(
            listing_id,
            Listing {
                id: listing_id,
                seller,
                item_id,
                amount,
                high_bidder: None,
                high_bid: U256::ZERO,
                min_price,
                listed_at,
                book: true,
            },
        );
        Ok(())
    }

    fn fill(
        &mut self,
        bidder: U256,
        item_id: U256,
        amount: U256,
        listing_id: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        let chosen = self.choose_ask(bidder, item_id, amount)?;
        if chosen.id != listing_id {
            return Err(EngineError::NoAsk);
        }
        if amount != chosen.min_price {
            return Err(EngineError::OverAsk);
        }
        self.pay_ask(bidder, &chosen, amount, touch)?;
        self.listings.remove(&listing_id);
        Ok(())
    }

    fn buy(
        &mut self,
        bidder: U256,
        item_id: U256,
        listing_id: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        let chosen = self.choose_lowest_ask(bidder, item_id)?;
        if chosen.id != listing_id {
            return Err(EngineError::NoAsk);
        }
        self.pay_ask(bidder, &chosen, chosen.min_price, touch)?;
        self.listings.remove(&listing_id);
        Ok(())
    }

    /// Item-only ask fill after AhEscrow paid the seller on-chain.
    fn chain_fill(
        &mut self,
        listing_id: U256,
        buyer: U256,
        price_wei: U256,
        item_id: U256,
        amount: U256,
        seller: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        let listing = self.listings.get(&listing_id).cloned().ok_or(EngineError::UnknownListing)?;
        if !listing.book {
            return Err(EngineError::UnknownListing);
        }
        if listing.seller == buyer {
            return Err(EngineError::SelfTransfer);
        }
        if price_wei != listing.min_price {
            return Err(EngineError::OverAsk);
        }
        if item_id != listing.item_id || amount != listing.amount || seller != listing.seller {
            return Err(EngineError::FillMismatch);
        }
        if touch.contains(&buyer) {
            self.credit_inbox(buyer, listing.item_id, listing.amount)?;
        }
        self.listings.remove(&listing_id);
        Ok(())
    }

    fn pay_ask(
        &mut self,
        bidder: U256,
        chosen: &Listing,
        price: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        if price != chosen.min_price {
            return Err(EngineError::OverAsk);
        }
        if touch.contains(&bidder) {
            self.debit_kek(bidder, price)?;
        }
        if touch.contains(&chosen.seller) {
            self.credit_kek(chosen.seller, price)?;
        }
        if touch.contains(&bidder) {
            self.credit_inbox(bidder, chosen.item_id, chosen.amount)?;
        }
        self.move_claim(bidder, chosen.seller, price)?;
        Ok(())
    }

    fn cancel_ask(&mut self, listing_id: U256, seller: U256, touch: &BTreeSet<U256>) -> Result<(), EngineError> {
        let listing = self.listings.get(&listing_id).cloned().ok_or(EngineError::UnknownListing)?;
        if !listing.book {
            return Err(EngineError::UnknownListing);
        }
        if listing.seller != seller {
            return Err(EngineError::NotSeller);
        }
        if touch.contains(&seller) {
            self.credit_inbox(seller, listing.item_id, listing.amount)?;
        }
        self.listings.remove(&listing_id);
        Ok(())
    }

    fn reclaim_ask(
        &mut self,
        listing_id: U256,
        seller: U256,
        now: u64,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        let listing = self.listings.get(&listing_id).cloned().ok_or(EngineError::UnknownListing)?;
        if !listing.book || listing.seller != seller {
            return Err(if listing.seller != seller { EngineError::NotSeller } else { EngineError::UnknownListing });
        }
        if listing.listed_at == 0 || now < listing.listed_at.saturating_add(ASK_WINDOW_SEC) {
            return Err(EngineError::TooSoon);
        }
        if touch.contains(&seller) {
            self.credit_inbox(seller, listing.item_id, listing.amount)?;
        }
        self.listings.remove(&listing_id);
        Ok(())
    }

    fn send_inbox(
        &mut self,
        from: U256,
        to: U256,
        item_id: U256,
        amount: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        if from == to {
            return Err(EngineError::SelfTransfer);
        }
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        if touch.contains(&from) {
            self.debit_item(from, item_id, amount)?;
        }
        if touch.contains(&to) {
            self.credit_inbox(to, item_id, amount)?;
        }
        Ok(())
    }

    fn take_inbox(
        &mut self,
        token_id: U256,
        item_id: U256,
        amount: U256,
        touch: &BTreeSet<U256>,
    ) -> Result<(), EngineError> {
        if !touch.contains(&token_id) {
            return Ok(());
        }
        self.debit_inbox(token_id, item_id, amount)
    }

    fn credit_inbox(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        let next = ch.inbox.get(&item_id).copied().unwrap_or(U256::ZERO).checked_add(amount).ok_or(EngineError::Overflow)?;
        if next == U256::ZERO {
            ch.inbox.remove(&item_id);
        } else {
            ch.inbox.insert(item_id, next);
        }
        Ok(())
    }

    fn debit_inbox(&mut self, token_id: U256, item_id: U256, amount: U256) -> Result<(), EngineError> {
        if amount == U256::ZERO {
            return Err(EngineError::ZeroAmount);
        }
        let ch = self.characters.get_mut(&token_id).ok_or(EngineError::NotSpawned)?;
        let have = ch.inbox.get(&item_id).copied().unwrap_or(U256::ZERO);
        let next = have.checked_sub(amount).ok_or(EngineError::InsufficientInbox)?;
        if next == U256::ZERO {
            ch.inbox.remove(&item_id);
        } else {
            ch.inbox.insert(item_id, next);
        }
        Ok(())
    }

}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

fn escrowed_bids(listings: &BTreeMap<U256, Listing>, token_id: &U256) -> U256 {
    let mut total = U256::ZERO;
    for listing in listings.values() {
        if listing.high_bidder == Some(*token_id) {
            total = total.checked_add(listing.high_bid).expect("escrow overflow");
        }
    }
    total
}

fn fit_u32(amount: U256) -> Result<u32, EngineError> {
    if amount.0[..28].iter().any(|byte| *byte != 0) {
        return Err(EngineError::Overflow);
    }
    let bytes: [u8; 4] = amount.0[28..].try_into().expect("4 bytes");
    let value = u32::from_be_bytes(bytes);
    if value == 0 {
        return Err(EngineError::ZeroAmount);
    }
    Ok(value)
}

fn inbound_count(entries: &[LoggedEntry], token_id: &U256) -> u64 {
    entries
        .iter()
        .filter(|entry| match &entry.input {
            Input::DepositKek { token_id: who, .. } | Input::ImportItem { token_id: who, .. } => who == token_id,
            _ => false,
        })
        .count() as u64
}

fn listing_id_of(input: &Input) -> Option<U256> {
    match input {
        Input::List { listing_id, .. }
        | Input::Bid { listing_id, .. }
        | Input::Cancel { listing_id, .. }
        | Input::Settle { listing_id }
        | Input::Ask { listing_id, .. }
        | Input::Fill { listing_id, .. }
        | Input::Buy { listing_id, .. }
        | Input::CancelAsk { listing_id, .. }
        | Input::ReclaimAsk { listing_id, .. } => Some(*listing_id),
        _ => None,
    }
}
