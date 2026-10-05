//! Inputs applied to state, and the outcome of a successful apply.

use crate::abi::{keccak256, Buf};
use crate::ids::spawn_tag;
use crate::u256::U256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    /// First log event. Must name the same token and job the genesis anchor was built from.
    Spawn { token_id: U256, starting_job: u8 },
    /// Log image of a KekVault deposit. Credits KEK the vault already holds. Not a mint.
    /// `nonce` is that character's inbound id (shared with item imports) and may be applied once.
    DepositKek { token_id: U256, amount: U256, nonce: u64 },
    /// Log image of an item import. Credits items already burned into the log. Not a mint of KEK.
    /// `nonce` is that character's inbound id (shared with KEK deposits) and may be applied once.
    ImportItem { token_id: U256, item_id: U256, amount: U256, nonce: u64 },
    /// Move a stack from the in-game bag onto the log. No chain inbound nonce.
    /// Not counted in inboundConsumed. Credits spendable items; does not mint KEK.
    BagImport { token_id: U256, item_id: U256, amount: U256 },
    /// Burns spendable items out of the log (the export side of a checkpoint). Escrowed listings are not spendable.
    ExportItem { token_id: U256, item_id: U256, amount: U256 },
    /// Decreases spendable KEK. Escrowed bids are not spendable, so they cannot be withdrawn.
    /// This is the log image of `kekOut`. It does not submit an onchain withdrawal.
    WithdrawKek { token_id: U256, amount: U256 },
    /// In-game price. Debits spendable KEK only. Escrowed bids stay locked.
    /// Not a mint, not `kekOut`, and not an onchain withdrawal.
    SpendKek { token_id: U256, amount: U256 },
    SendItem { from: U256, to: U256, item_id: U256, amount: U256 },
    SendKek { from: U256, to: U256, amount: U256 },
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
    /// Historical loot credit. Entries already on a log replay exactly as they were written:
    /// they credit spendable items (not KEK). New appends are refused with `ClosedMint`;
    /// mob loot is logged as `LootDrop` instead. Do not reinterpret committed entries.
    ItemDrop { token_id: U256, item_id: U256, amount: U256 },
    /// Loot drop counter. Like Harvest: records the drop, does not credit spendable items or KEK.
    LootDrop { token_id: U256, item_id: U256, amount: U256 },
    /// Craft skill level for this character. Must be strictly higher than the logged level.
    /// Does not store XP and does not credit items or KEK.
    CraftSkill { token_id: U256, skill_id: String, level: u32 },
    /// Drops the named skill-node ids so they can be learned again. Does not spend KEK.
    RespecSkills { token_id: U256, node_ids: Vec<String> },
    /// Debit spendable KEK and drop skill-node ids in one apply. Not a mint and not kekOut.
    PaidRespecSkills { token_id: U256, amount: U256, node_ids: Vec<String> },
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
        Input::DepositKek { token_id, amount, nonce } => {
            buf.b256(&domain(b"LOK_DEPOSIT_KEK_V1"));
            buf.u256(token_id);
            buf.u256(amount);
            buf.u64(*nonce);
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
        Input::ExportItem { token_id, item_id, amount } => {
            buf.b256(&domain(b"LOK_EXPORT_ITEM_V1"));
            buf.u256(token_id);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::WithdrawKek { token_id, amount } => {
            buf.b256(&domain(b"LOK_WITHDRAW_KEK_V1"));
            buf.u256(token_id);
            buf.u256(amount);
        }
        Input::SpendKek { token_id, amount } => {
            buf.b256(&domain(b"LOK_SPEND_KEK_V1"));
            buf.u256(token_id);
            buf.u256(amount);
        }
        Input::SendItem { from, to, item_id, amount } => {
            buf.b256(&domain(b"LOK_SEND_ITEM_V1"));
            buf.u256(from);
            buf.u256(to);
            buf.u256(item_id);
            buf.u256(amount);
        }
        Input::SendKek { from, to, amount } => {
            buf.b256(&domain(b"LOK_SEND_KEK_V1"));
            buf.u256(from);
            buf.u256(to);
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
        Input::PaidRespecSkills { token_id, amount, node_ids } => {
            buf.b256(&domain(b"LOK_PAID_RESPEC_SKILLS_V1"));
            buf.u256(token_id);
            buf.u256(amount);
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
    }
    keccak256(&buf.bytes)
}

/// `keccak256(abi.encode(prev, index, eventId))`. Static, so the link does not depend on state bytes.
pub fn entry_hash(prev: &[u8; 32], index: u64, input: &Input) -> [u8; 32] {
    let mut buf = Buf::new();
    buf.b256(prev);
    buf.u64(index);
    buf.b256(&event_id(input));
    keccak256(&buf.bytes)
}
