//! Bellgrave lok engine.
//!
//! Proven against the golden vectors in `contracts/lok-log/test/Golden.t.sol` and
//! `test/golden/verify.mjs`. The game server calls this crate (wasm gate) for every item and KEK move.
//! KEK is deposit-only: a character log credits it only as a vault deposit, and
//! transfers cannot create it. `WithdrawKek` decreases spendable KEK and does not
//! submit an onchain withdrawal. `SpendKek` debits spendable KEK for an in-game
//! price, leaves escrowed bids locked, is not `kekOut`, and does not mint.
//! Level-up, ability, craft, harvest, loot-drop counters, and bag imports are per character and
//! do not mint KEK. Bag imports credit items without a chain inbound nonce. Each character has their own hash chain.
//! `LootDrop` is the loot counter and never credits items. `ItemDrop` is closed for new appends
//! (`ClosedMint`); entries already on a log at `seq <= HISTORICAL_ITEM_DROP_MAX_SEQ` replay as the
//! item credit they were when written, and any later one is refused even on replay.
//! A KEK deposit or item import carries that character's inbound nonce and is rejected
//! if the same nonce is applied again. The nonce must be the next one (`inboundCount`).

mod abi;
mod chain;
mod checkpoint;
mod craft_recipe_data;
mod engine;
mod event;
mod gold;
mod ids;
mod npc_price;
mod npc_price_data;
mod state;
mod u256;
mod gate;
mod world;

#[cfg(target_arch = "wasm32")]
mod wasm_api;

pub use chain::{
    load_world, parse_any_log, parse_log, parse_world_log, replay, replay_world, AnyLog,
    CharacterLogDocument, LoggedEntry, LogDocument, ReplayReport, ReplayStop, WorldDocument,
    WorldReplayReport,
};
pub use checkpoint::{checkpoint_body_hash, eip712_digest, Checkpoint, Export};
pub use engine::{Engine, EngineError};
pub use event::{
    craft_skill_validated_at, craft_validate_min_seq, entry_hash, event_id, item_drop_credits_at,
    set_craft_validate_min_seq, Input, Outcome, HISTORICAL_CRAFT_VALIDATE_MIN_SEQ,
    HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_FRESH, HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_LEGACY,
    HISTORICAL_ITEM_DROP_MAX_SEQ,
};
pub use gold::{
    gold_source_cap, GOLD_DAILY_TOTAL_CAP, GOLD_MAX_DAY, GOLD_SOURCE_CRAFT_REFUND, GOLD_SOURCE_NPC_SELL,
};
pub use npc_price::npc_sell_unit_price;
pub use ids::{fungible_id, genesis_root, genesis_tag, spawn_tag, unique_id, world_genesis};
pub use state::{commit_entries, label_key, Key, State};
pub use u256::{parse_address, parse_b256, U256};
pub use gate::Gate;
pub use world::{
    AppliedEvent, CharacterLink, CharacterSnapshot, Listing, OpenPvpBounty, World, PVP_BOUNTY_WEI,
};

pub use abi::keccak256;
