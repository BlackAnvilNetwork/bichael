//! Bellgrave lok engine.
//!
//! Proven against the golden vectors in `contracts/lok-log/test/Golden.t.sol` and
//! `test/golden/verify.mjs`. The game server calls this crate (wasm gate) for every item and KEK move.
//! KEK is deposit-only: a character log credits it only as a vault deposit, and
//! transfers cannot create it. `WithdrawKek` decreases spendable KEK and does not
//! submit an onchain withdrawal. `SpendKek` debits spendable KEK for an in-game
//! price, leaves escrowed bids locked, is not `kekOut`, and does not mint.
//! Level-up, ability, craft, harvest, item-drop counters, and bag imports are per character and
//! do not mint KEK. Bag imports credit items without a chain inbound nonce. Each character has their own hash chain.
//! A KEK deposit or item import carries that character's inbound nonce and is rejected
//! if the same nonce is applied again. The nonce must be the next one (`inboundCount`).

mod abi;
mod chain;
mod checkpoint;
mod engine;
mod event;
mod ids;
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
pub use event::{entry_hash, event_id, Input, Outcome};
pub use ids::{fungible_id, genesis_root, genesis_tag, spawn_tag, unique_id, world_genesis};
pub use state::{commit_entries, label_key, Key, State};
pub use u256::{parse_address, parse_b256, U256};
pub use gate::Gate;
pub use world::{AppliedEvent, CharacterLink, CharacterSnapshot, Listing, World};

pub use abi::keccak256;
