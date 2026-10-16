//! One Merkle tree over `(tokenId, characterRoot)`.
//!
//! Same binary tree as `commit_map` in `state`: pair with `keccak256(left || right)`,
//! duplicate the last node when a level is odd, and hash an empty set as `keccak256` of
//! empty bytes. Leaves are not character-sheet `Key` tags. Token id order is the only
//! order that matters, so insertion order does not change the root.
//!
//! This root is not the live batch `nextRoot`. That link stays the chain link.

use std::collections::BTreeMap;
use std::fmt;

use crate::abi::keccak256;
use crate::u256::U256;

/// `keccak256(tokenId || characterRoot)` with `tokenId` as 32-byte big-endian.
pub fn character_leaf(token_id: &U256, character_root: &[u8; 32]) -> [u8; 32] {
    let mut raw = [0u8; 64];
    raw[..32].copy_from_slice(&token_id.0);
    raw[32..].copy_from_slice(character_root);
    keccak256(&raw)
}

/// Token id is not in the tree. An empty sibling path is a one-leaf proof, not this error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MissingToken;

impl fmt::Display for MissingToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("missing token")
    }
}

/// One sibling on the path from the leaf up to the root.
///
/// `on_left` means this hash is the left child, so the parent is
/// `keccak256(hash || running)`. Otherwise the parent is `keccak256(running || hash)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sibling {
    pub hash: [u8; 32],
    pub on_left: bool,
}

/// Leaf plus the sibling path. A verifier folds `path` from `leaf` to recompute the root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterRootProof {
    pub leaf: [u8; 32],
    pub path: Vec<Sibling>,
}

impl CharacterRootProof {
    /// Root recomputed from the leaf and the sibling path.
    pub fn computed_root(&self) -> [u8; 32] {
        let mut running = self.leaf;
        for step in &self.path {
            running = if step.on_left {
                hash_pair(&step.hash, &running)
            } else {
                hash_pair(&running, &step.hash)
            };
        }
        running
    }

    /// True when `character_root` is the value committed for `token_id` under `root`.
    pub fn verify(&self, root: &[u8; 32], token_id: &U256, character_root: &[u8; 32]) -> bool {
        self.leaf == character_leaf(token_id, character_root) && self.computed_root() == *root
    }
}

/// Sorted map of token id to that character's state root.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CharacterRootTree {
    by_token: BTreeMap<U256, [u8; 32]>,
}

impl CharacterRootTree {
    pub fn new() -> Self {
        Self { by_token: BTreeMap::new() }
    }

    /// Insert or replace the character root for `token_id`.
    pub fn insert(&mut self, token_id: U256, character_root: [u8; 32]) {
        self.by_token.insert(token_id, character_root);
    }

    pub fn root(&self) -> [u8; 32] {
        fold(self.leaf_hashes())
    }

    /// Leaf and sibling path for `token_id`. A missing id is [`MissingToken`], not an empty path.
    pub fn prove(&self, token_id: &U256) -> Result<CharacterRootProof, MissingToken> {
        let index = self
            .by_token
            .keys()
            .position(|id| id == token_id)
            .ok_or(MissingToken)?;
        let character_root = self.by_token[token_id];
        Ok(CharacterRootProof {
            leaf: character_leaf(token_id, &character_root),
            path: sibling_path(&self.leaf_hashes(), index),
        })
    }

    fn leaf_hashes(&self) -> Vec<[u8; 32]> {
        self.by_token
            .iter()
            .map(|(token_id, character_root)| character_leaf(token_id, character_root))
            .collect()
    }
}

fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut raw = [0u8; 64];
    raw[..32].copy_from_slice(left);
    raw[32..].copy_from_slice(right);
    keccak256(&raw)
}

/// Same fold as `commit_map`: duplicate the last node on an odd level.
fn fold(mut level: Vec<[u8; 32]>) -> [u8; 32] {
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
            next.push(hash_pair(&pair[0], &pair[1]));
        }
        level = next;
    }
    level[0]
}

fn sibling_path(leaves: &[[u8; 32]], mut index: usize) -> Vec<Sibling> {
    let mut level = leaves.to_vec();
    let mut path = Vec::new();
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            let last = *level.last().expect("odd level has a last leaf");
            level.push(last);
        }
        let sibling = index ^ 1;
        path.push(Sibling {
            hash: level[sibling],
            on_left: sibling < index,
        });
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            next.push(hash_pair(&pair[0], &pair[1]));
        }
        index /= 2;
        level = next;
    }
    path
}
