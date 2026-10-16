//! Inputs applied to state, and the outcome of a successful apply.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::abi::{keccak256, Buf};
use crate::ids::spawn_tag;
use crate::u256::U256;

/// Last global `seq` of the quarantined pre-#206 live log
/// (`apps/server/data/lok-world.json.bak-pre-aacc7c8-20261005-151212`: 175 entries, seq 0..=174,
/// 32 `ItemDrop` entries, the last at seq 72).
///
/// That log is not replayed. `seq` is not part of the entry hash, so a low seq cannot
/// be trusted to mean "this ItemDrop was one of those 32". Every `ItemDrop` is
/// `ClosedMint` on append and on replay. Mob loot is `LootDrop`. Clear a log that
/// still contains `ItemDrop`.
pub const HISTORICAL_ITEM_DROP_MAX_SEQ: u64 = 174;

/// Legacy Black Anvil / local anvil world: crafts logged below this global seq
/// skip recipe/skill checks on replay (pre-#222 logs, seq 0..=174).
pub const HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_LEGACY: u64 = 175;

/// Fresh networks (Chiado, Gnosis): every logged craft is validated.
pub const HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_FRESH: u64 = 0;

/// Default runtime bound — legacy anvil quarantine. The game server sets
/// [`HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_FRESH`] on Chiado/Gnosis before `lok_open`.
/// Prefer [`craft_validate_min_seq`] at apply time.
pub const HISTORICAL_CRAFT_VALIDATE_MIN_SEQ: u64 = HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_LEGACY;

static CRAFT_VALIDATE_MIN_SEQ: AtomicU64 = AtomicU64::new(HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_LEGACY);

/// Override the craft-validation cutoff (per network / ruleset). Call before replaying a log.
pub fn set_craft_validate_min_seq(min_seq: u64) {
    CRAFT_VALIDATE_MIN_SEQ.store(min_seq, Ordering::SeqCst);
}

/// Current craft-validation cutoff (global world seq).
pub fn craft_validate_min_seq() -> u64 {
    CRAFT_VALIDATE_MIN_SEQ.load(Ordering::SeqCst)
}

/// True when craft recipe/skill checks run for this apply.
/// New appends (`None`) always validate; logged entries validate only at/after
/// [`craft_validate_min_seq`].
pub fn craft_skill_validated_at(logged_seq: Option<u64>) -> bool {
    match logged_seq {
        None => true,
        Some(seq) => seq >= craft_validate_min_seq(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    /// First log event. Must name the same token and job the genesis anchor was built from.
    Spawn { token_id: U256, starting_job: u8 },
    /// Log image of an item import. Credits items already burned into the log.
    /// `nonce` is that character's inbound id and may be applied once.
    ImportItem { token_id: U256, item_id: U256, amount: U256, nonce: u64 },
    /// Move a stack from the in-game bag onto the log. No chain inbound nonce.
    /// Not counted in inboundConsumed. Credits spendable items.
    BagImport { token_id: U256, item_id: U256, amount: U256 },
    /// Move a stack from the log back into the in-game bag. Debits spendable items.
    /// Not a checkpoint export: it does not mint ERC-1155.
    BagExport { token_id: U256, item_id: U256, amount: U256 },
    /// Burns spendable items out of the log as a chain withdrawal. Packed into
    /// `Checkpoint.exports` and minted when exports are enabled. Escrowed listings
    /// are not spendable. A bag move is `BagExport`, not this.
    ExportItem { token_id: U256, item_id: U256, amount: U256 },
    SendItem { from: U256, to: U256, item_id: U256, amount: U256 },
    List { listing_id: U256, seller: U256, item_id: U256, amount: U256 },
    Bid { listing_id: U256, bidder: U256, amount: U256 },
    Cancel { listing_id: U256, seller: U256 },
    Settle { listing_id: U256 },
    /// Next level for this character. Must be exactly one above the logged level.
    /// Does not mint KEK or items.
    LevelUp { token_id: U256, level: u32 },
    /// One ability or skill-node id. A second record of the same id is rejected.
    LearnAbility { token_id: U256, ability_id: String },
    /// A successful craft. Counts the crafted amount. Does not credit spendable items or KEK.
    Craft { token_id: U256, item_id: U256, amount: U256 },
    /// A successful gather. Counts the material. Does not credit spendable items or KEK.
    Harvest { token_id: U256, material_id: String, amount: U256 },
    /// Closed mint. Refused on append and on replay (`ClosedMint`). A low `seq` does not
    /// credit items. Mob loot is `LootDrop`.
    ItemDrop { token_id: U256, item_id: U256, amount: U256 },
    /// Loot drop counter. Like Harvest: records the drop, does not credit spendable items or KEK.
    LootDrop { token_id: U256, item_id: U256, amount: U256 },
    /// Craft skill level for this character. Must be strictly higher than the logged level.
    /// Does not store XP and does not credit items or KEK.
    CraftSkill { token_id: U256, skill_id: String, level: u32 },
    /// Drops the named skill-node ids so they can be learned again. Does not spend gold.
    RespecSkills { token_id: U256, node_ids: Vec<String> },
    /// Order-book ask. The stack leaves spendable items and is held at \min_price\.
    /// \listed_at\ is a unix second from the server. This log has no clock of its own.
    Ask {
        listing_id: U256,
        seller: U256,
        item_id: U256,
        amount: U256,
        min_price: U256,
        listed_at: u64,
    },
    /// Immediate fill of one ask. The buyer pays \mount\ (not the minimum).
    /// \listing_id\ is the ask the price-time rule selected. No standing buy is left.
    /// amount must equal the selected ask. A higher number is rejected.
    Fill { bidder: U256, item_id: U256, amount: U256, listing_id: U256 },
    /// Buy the cheapest open ask. The price is that ask, not a bid.
    /// Equal prices fill the oldest ask. A seller cannot buy their own ask.
    Buy { bidder: U256, item_id: U256, listing_id: U256 },
    /// Seller pulls an unsold ask into their inbox before it sells.
    CancelAsk { listing_id: U256, seller: U256 },
    /// After 7 days an unsold ask is reclaimed into the seller inbox. ow\ is the server clock.
    ReclaimAsk { listing_id: U256, seller: U256, now: u64 },
    /// Player-to-player item send into the recipient inbox, not their spendable balance.
    SendInbox { from: U256, to: U256, item_id: U256, amount: U256 },
    /// Take items out of the inbox. They leave the log; the server bags them.
    TakeInbox { token_id: U256, item_id: U256, amount: U256 },
    /// Credit in-game gold. `day` is server-stamped; the engine enforces daily earn caps.
    /// Not KEK, not a vault deposit, and not transferable between characters in v1.
    GoldEarn { token_id: U256, source: String, amount: U256, day: u64 },
    /// Debit in-game gold for a sink (trainer, craft, respec, shop). Fails if short.
    GoldSpend { token_id: U256, sink: String, amount: U256 },
    /// NPC buy-back: burn `qty` of `item_id`, credit `amount` gold under the npc_sell earn cap.
    /// `day` is server-stamped like GoldEarn. Price tables are ruleset content (E3); the amount
    /// is part of the event payload the server appends.
    GoldSell { token_id: U256, item_id: U256, qty: U256, amount: U256, day: u64 },
    /// On-chain AhEscrow fill mirrored into the log. Moves the ask's stack into the buyer's
    /// inbox. Does **not** debit or credit settlement ETH/`Key::Kek` — payment already settled
    /// on-chain. `price_wei` / `item_id` / `amount` / `seller` must match the open ask.
    /// `tx_hash` + `log_index` bind the mirror to the AskFilled receipt (dedupe + audit).
    /// Appended only by the server after a trusted on-chain fill. Not yet on any committed log.
    ChainFill {
        listing_id: U256,
        buyer: U256,
        price_wei: U256,
        item_id: U256,
        amount: U256,
        seller: U256,
        tx_hash: [u8; 32],
        log_index: u64,
    },
    /// Debit in-game gold and drop skill-node ids in one apply.
    GoldPaidRespec {
        token_id: U256,
        amount: U256,
        node_ids: Vec<String>,
    },
    /// Mirror of an on-chain PvP head-bounty escrow open (1 xDAI / 1 native).
    /// Does **not** credit or debit settlement ETH/`Key::Kek` — payment lives on-chain.
    /// `amount_wei` must equal [`crate::world::PVP_BOUNTY_WEI`]. `area_id` is the PvP
    /// area label (server-validated). `tx_hash` + `log_index` bind to the escrow receipt.
    PvpBountyOpen {
        token_id: U256,
        amount_wei: U256,
        area_id: String,
        tx_hash: [u8; 32],
        log_index: u64,
    },
    /// Mirror of an on-chain PvP bounty cancel / refund (left the area without dying).
    /// Does not move ETH on the log. Requires an open bounty for `token_id`.
    PvpBountyCancel {
        token_id: U256,
        area_id: String,
        tx_hash: [u8; 32],
        log_index: u64,
    },
    /// Mirror of an on-chain PvP bounty claim after a slay inside a PvP area.
    /// Clears the victim's open bounty. Does **not** move ETH on the log — the
    /// escrow already paid the slayer on-chain. Both characters are linked.
    PvpKill {
        victim: U256,
        slayer: U256,
        area_id: String,
        amount_wei: U256,
        tx_hash: [u8; 32],
        log_index: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Applied {
        index: u64,
        prev_hash: [u8; 32],
        entry_hash: [u8; 32],
        state_root: [u8; 32],
        summary: U256,
    },
}

fn domain(label: &[u8]) -> [u8; 32] {
    keccak256(label)
}

fn push_label(buf: &mut Buf, label: &str) {
    let bytes = label.as_bytes();
    buf.u64(bytes.len() as u64);
    buf.bytes.extend_from_slice(bytes);
}

/// Domain-separated id of an input: `keccak256(abi.encode(tag, ...fields))`.
pub fn event_id(input: &Input) -> [u8; 32] {
    let mut buf = Buf::new();
    match input {
        Input::Spawn { token_id, starting_job } => {
            buf.b256(&spawn_tag());
            buf.u256(token_id);
            buf.u8(*starting_job);
        }
        Input::ImportItem { token_id, item_id, amount, nonce } => {
            buf.b256(&domain(b"LOK_IMPORT_ITEM_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
            buf.u64(*nonce);
        }
        Input::BagImport { token_id, item_id, amount } => {
            buf.b256(&domain(b"LOK_BAG_IMPORT_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::BagExport { token_id, item_id, amount } => {
            buf.b256(&domain(b"LOK_BAG_EXPORT_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::ExportItem { token_id, item_id, amount } => {
            buf.b256(&domain(b"LOK_EXPORT_ITEM_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::SendItem { from, to, item_id, amount } => {
            buf.b256(&domain(b"LOK_SEND_ITEM_V1"));
            buf.u256(from);
            buf.u256(to);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::List { listing_id, seller, item_id, amount } => {
            buf.b256(&domain(b"LOK_LIST_V1"));
            buf.u256(listing_id);
            buf.u256(seller);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::Bid { listing_id, bidder, amount } => {
            buf.b256(&domain(b"LOK_BID_V1"));
            buf.u256(listing_id);
            buf.u256(bidder);
            buf.u256(amount);
        }
        Input::Cancel { listing_id, seller } => {
            buf.b256(&domain(b"LOK_CANCEL_V1"));
            buf.u256(listing_id);
            buf.u256(seller);
        }
        Input::Settle { listing_id } => {
            buf.b256(&domain(b"LOK_SETTLE_V1"));
            buf.u256(listing_id);
        }
        Input::LevelUp { token_id, level } => {
            buf.b256(&domain(b"LOK_LEVEL_UP_V1"));
            buf.u256(token_id);
            buf.u32(*level);
        }
        Input::LearnAbility { token_id, ability_id } => {
            buf.b256(&domain(b"LOK_LEARN_ABILITY_V1"));
            buf.u256(token_id);
            push_label(&mut buf, ability_id);
        }
        Input::Craft { token_id, item_id, amount } => {
            buf.b256(&domain(b"LOK_CRAFT_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::Harvest { token_id, material_id, amount } => {
            buf.b256(&domain(b"LOK_HARVEST_V1"));
            buf.u256(token_id);
            push_label(&mut buf, material_id);
            buf.u256(amount);
        }
        Input::ItemDrop { token_id, item_id, amount } => {
            buf.b256(&domain(b"LOK_ITEM_DROP_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::LootDrop { token_id, item_id, amount } => {
            buf.b256(&domain(b"LOK_LOOT_DROP_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::CraftSkill { token_id, skill_id, level } => {
            buf.b256(&domain(b"LOK_CRAFT_SKILL_V1"));
            buf.u256(token_id);
            push_label(&mut buf, skill_id);
            buf.u32(*level);
        }
        Input::RespecSkills { token_id, node_ids } => {
            buf.b256(&domain(b"LOK_RESPEC_SKILLS_V1"));
            buf.u256(token_id);
            buf.u64(node_ids.len() as u64);
            for id in node_ids {
                push_label(&mut buf, id);
            }
        }
        Input::Ask { listing_id, seller, item_id, amount, min_price, listed_at } => {
            buf.b256(&domain(b"LOK_ASK_V1"));
            buf.u256(listing_id);
            buf.u256(seller);
            buf.u256(item_id);
            buf.u256(amount);
            buf.u256(min_price);
            buf.u64(*listed_at);
        }
        Input::Fill { bidder, item_id, amount, listing_id } => {
            buf.b256(&domain(b"LOK_FILL_V1"));
            buf.u256(bidder);
            buf.u256(item_id);
            buf.u256(amount);
            buf.u256(listing_id);
        }
                Input::Buy { bidder, item_id, listing_id } => {
            buf.b256(&domain(b"LOK_BUY_V1"));
            buf.u256(bidder);
            buf.u256(item_id);
            buf.u256(listing_id);
        }
Input::CancelAsk { listing_id, seller } => {
            buf.b256(&domain(b"LOK_CANCEL_ASK_V1"));
            buf.u256(listing_id);
            buf.u256(seller);
        }
        Input::ReclaimAsk { listing_id, seller, now } => {
            buf.b256(&domain(b"LOK_RECLAIM_ASK_V1"));
            buf.u256(listing_id);
            buf.u256(seller);
            buf.u64(*now);
        }
        Input::SendInbox { from, to, item_id, amount } => {
            buf.b256(&domain(b"LOK_SEND_INBOX_V1"));
            buf.u256(from);
            buf.u256(to);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::TakeInbox { token_id, item_id, amount } => {
            buf.b256(&domain(b"LOK_TAKE_INBOX_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::GoldEarn { token_id, source, amount, day } => {
            buf.b256(&domain(b"LOK_GOLD_EARN_V1"));
            buf.u256(token_id);
            push_label(&mut buf, source);
            buf.u256(amount);
            buf.u64(*day);
        }
        Input::GoldSpend { token_id, sink, amount } => {
            buf.b256(&domain(b"LOK_GOLD_SPEND_V1"));
            buf.u256(token_id);
            push_label(&mut buf, sink);
            buf.u256(amount);
        }
        Input::GoldSell { token_id, item_id, qty, amount, day } => {
            buf.b256(&domain(b"LOK_GOLD_SELL_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(qty);
            buf.u256(amount);
            buf.u64(*day);
        }
        Input::ChainFill {
            listing_id,
            buyer,
            price_wei,
            item_id,
            amount,
            seller,
            tx_hash,
            log_index,
        } => {
            buf.b256(&domain(b"LOK_CHAIN_FILL_V1"));
            buf.u256(listing_id);
            buf.u256(buyer);
            buf.u256(price_wei);
            buf.u256(item_id);
            buf.u256(amount);
            buf.u256(seller);
            buf.b256(tx_hash);
            buf.u64(*log_index);
        }
        Input::GoldPaidRespec { token_id, amount, node_ids } => {
            buf.b256(&domain(b"LOK_GOLD_PAID_RESPEC_V1"));
            buf.u256(token_id);
            buf.u256(amount);
            buf.u64(node_ids.len() as u64);
            for id in node_ids {
                push_label(&mut buf, id);
            }
        }
        Input::PvpBountyOpen {
            token_id,
            amount_wei,
            area_id,
            tx_hash,
            log_index,
        } => {
            buf.b256(&domain(b"LOK_PVP_BOUNTY_OPEN_V1"));
            buf.u256(token_id);
            buf.u256(amount_wei);
            push_label(&mut buf, area_id);
            buf.b256(tx_hash);
            buf.u64(*log_index);
        }
        Input::PvpBountyCancel {
            token_id,
            area_id,
            tx_hash,
            log_index,
        } => {
            buf.b256(&domain(b"LOK_PVP_BOUNTY_CANCEL_V1"));
            buf.u256(token_id);
            push_label(&mut buf, area_id);
            buf.b256(tx_hash);
            buf.u64(*log_index);
        }
        Input::PvpKill {
            victim,
            slayer,
            area_id,
            amount_wei,
            tx_hash,
            log_index,
        } => {
            buf.b256(&domain(b"LOK_PVP_KILL_V1"));
            buf.u256(victim);
            buf.u256(slayer);
            push_label(&mut buf, area_id);
            buf.u256(amount_wei);
            buf.b256(tx_hash);
            buf.u64(*log_index);
        }
    }
    keccak256(&buf.bytes)
}

/// `keccak256(prev || index || eventId)`, plus the ruleset word when it is not 32 zero bytes.
/// A zero ruleset is left off so existing links keep their digest. The link does not depend on state bytes.
pub fn entry_hash(prev: &[u8; 32], index: u64, input: &Input, ruleset: &[u8; 32]) -> [u8; 32] {
    let mut buf = Buf::new();
    buf.b256(prev);
    buf.u64(index);
    buf.b256(&event_id(input));
    if *ruleset != [0u8; 32] {
        buf.b256(ruleset);
    }
    keccak256(&buf.bytes)
}
