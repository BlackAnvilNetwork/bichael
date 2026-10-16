//! Kills that can justify a loot drop. A kill belongs to one batch.
//!
//! `begin` opens a batch and drops every kill from the previous one. A later
//! batch cannot cite them. The set is rebuilt while a log replays and is not
//! part of the state hash.

use std::collections::BTreeMap;

use crate::engine::EngineError;
use crate::event::drop_kill_required_at;
use crate::u256::U256;

#[derive(Clone, Debug, Default)]
pub struct DropBatch {
    id: Option<u64>,
    /// Set by the live tick. A kill that names another batch is refused.
    /// Replay leaves this clear so the next kill id can open its own batch.
    locked: bool,
    /// `kill_id` → the character the kill was logged for.
    kills: BTreeMap<U256, U256>,
}

impl DropBatch {
    pub fn begin(&mut self, batch_id: u64) {
        self.kills.clear();
        self.id = Some(batch_id);
        self.locked = true;
    }

    /// Record a kill. Does not credit items, gold, or XP.
    pub fn note_kill(&mut self, token_id: U256, kill_id: U256, batch_id: u64) -> Result<(), EngineError> {
        if kill_id == U256::ZERO {
            return Err(EngineError::BadId);
        }
        if let Some(open) = self.id {
            if open != batch_id {
                if self.locked {
                    return Err(EngineError::DropWithoutKill);
                }
                self.kills.clear();
                self.id = Some(batch_id);
            }
        } else {
            self.id = Some(batch_id);
        }
        if let Some(owner) = self.kills.get(&kill_id) {
            if *owner != token_id {
                return Err(EngineError::BadId);
            }
        }
        self.kills.insert(kill_id, token_id);
        Ok(())
    }

    /// A historical drop with no kill reference skips this. A drop that names a
    /// kill, and every new append, must name a kill in the open batch.
    pub fn accept_drop(
        &self,
        token_id: U256,
        kill_id: Option<U256>,
        batch_id: Option<u64>,
        logged_seq: Option<u64>,
    ) -> Result<(), EngineError> {
        let named = match (kill_id, batch_id) {
            (None, None) => None,
            (Some(id), Some(batch)) => Some((id, batch)),
            _ => return Err(EngineError::DropWithoutKill),
        };
        if named.is_none() && !drop_kill_required_at(logged_seq) {
            return Ok(());
        }
        let (id, batch) = named.ok_or(EngineError::DropWithoutKill)?;
        if id == U256::ZERO {
            return Err(EngineError::BadId);
        }
        if self.id != Some(batch) {
            return Err(EngineError::DropWithoutKill);
        }
        match self.kills.get(&id) {
            Some(owner) if *owner == token_id => Ok(()),
            _ => Err(EngineError::DropWithoutKill),
        }
    }
}
