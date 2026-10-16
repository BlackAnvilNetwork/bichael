//! Bellgrave lok engine.
//!
//! Proven against the golden vectors in `contracts/lok-log/test/Golden.t.sol` and
//! `test/golden/verify.mjs`. The game server calls this crate (wasm gate) for item moves and gold.
//! KEK custody is retired: deposit, withdraw, spend, send, and paid respec do not parse,
//! and KEK-priced bid, settle, fill, and buy return `KekRetired` without appending.
//! Asks, chain fills, item list/cancel, and gold sinks remain.
//! Level-up, ability, craft, harvest, loot-drop counters, and bag imports are per character and
//! do not mint items. Bag imports credit items without a chain inbound nonce. Bag exports debit
//! spendable items back to the bag and are not checkpoint ERC-1155 exports. `ExportItem` is the
//! chain withdrawal packed into `Checkpoint.exports`. Each character has their own hash chain.
//! `LootDrop` is the loot counter and never credits items. A new drop names a kill in the
//! same batch. An already-logged drop keeps its encoding. `ItemDrop` is `ClosedMint` on append
//! and on replay. A low `seq` does not credit items.
//! An item import carries that character's inbound nonce and is rejected
//! if the same nonce is applied again. The nonce must be the next one (`inboundCount`).

mod abi;
mod chain;
mod drop_batch;
mod character_root;
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
pub use character_root::{
    character_root_leaf, verify_character_root, CharacterRootProof, CharacterRootTree, Sibling,
};
pub use checkpoint::{checkpoint_body_hash, eip712_digest, Checkpoint, Export};
pub use engine::{Engine, EngineError};
pub use event::{
    craft_skill_validated_at, craft_validate_min_seq, drop_kill_min_seq, drop_kill_required_at, entry_hash,
    event_id, set_craft_validate_min_seq, set_drop_kill_min_seq, Input, Outcome, HISTORICAL_CRAFT_VALIDATE_MIN_SEQ,
    HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_FRESH, HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_LEGACY,
    HISTORICAL_DROP_KILL_MIN_SEQ, HISTORICAL_ITEM_DROP_MAX_SEQ,
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
