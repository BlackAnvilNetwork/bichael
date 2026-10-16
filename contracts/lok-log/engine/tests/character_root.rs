//! Sibling proofs for the `(tokenId, characterRoot)` tree.

use lok_engine::{
    character_leaf, keccak256, CharacterRootProof, CharacterRootTree, MissingToken, State, U256,
};

fn word(byte: u8) -> [u8; 32] {
    let mut raw = [0u8; 32];
    raw[31] = byte;
    raw
}

fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut raw = [0u8; 64];
    raw[..32].copy_from_slice(left);
    raw[32..].copy_from_slice(right);
    keccak256(&raw)
}

/// Fold the sibling path the way a verifier would, without calling the library fold.
fn recompute(proof: &CharacterRootProof) -> [u8; 32] {
    let mut running = proof.leaf;
    for step in &proof.path {
        running = if step.on_left {
            hash_pair(&step.hash, &running)
        } else {
            hash_pair(&running, &step.hash)
        };
    }
    running
}

#[test]
fn one_leaf_proof_is_the_leaf_and_a_missing_token_errors() {
    let token = U256::from_u64(7);
    let character_root = word(0x11);
    let mut tree = CharacterRootTree::new();
    assert_eq!(tree.root(), keccak256(&[]));
    assert_eq!(tree.root(), State::new().root());
    assert_eq!(tree.prove(&token), Err(MissingToken));

    tree.insert(token, character_root);
    let proof = tree.prove(&token).expect("present token");
    assert!(proof.path.is_empty(), "one leaf has no sibling");
    assert_eq!(proof.leaf, character_leaf(&token, &character_root));
    assert_eq!(tree.root(), proof.leaf);
    assert_eq!(recompute(&proof), tree.root());
    assert!(proof.verify(&tree.root(), &token, &character_root));
    assert_eq!(tree.prove(&U256::from_u64(8)), Err(MissingToken));
}

#[test]
fn two_leaves_keep_the_same_root_in_either_insertion_order() {
    let low = U256::from_u64(1);
    let high = U256::from_u64(2);
    let low_root = word(0x21);
    let high_root = word(0x22);

    let mut forward = CharacterRootTree::new();
    forward.insert(low, low_root);
    forward.insert(high, high_root);

    let mut backward = CharacterRootTree::new();
    backward.insert(high, high_root);
    backward.insert(low, low_root);

    let low_leaf = character_leaf(&low, &low_root);
    let high_leaf = character_leaf(&high, &high_root);
    let expected = hash_pair(&low_leaf, &high_leaf);
    assert_eq!(forward.root(), expected);
    assert_eq!(backward.root(), expected);
    assert_ne!(forward.root(), hash_pair(&high_leaf, &low_leaf));

    for tree in [&forward, &backward] {
        let low_proof = tree.prove(&low).expect("low");
        let high_proof = tree.prove(&high).expect("high");
        assert_eq!(low_proof.path.len(), 1);
        assert_eq!(high_proof.path.len(), 1);
        assert!(!low_proof.path[0].on_left);
        assert_eq!(low_proof.path[0].hash, high_leaf);
        assert!(high_proof.path[0].on_left);
        assert_eq!(high_proof.path[0].hash, low_leaf);
        assert_eq!(recompute(&low_proof), tree.root());
        assert_eq!(recompute(&high_proof), tree.root());
        assert!(low_proof.verify(&tree.root(), &low, &low_root));
        assert!(high_proof.verify(&tree.root(), &high, &high_root));
    }
}

#[test]
fn odd_leaf_count_duplicates_the_last_node() {
    let ids = [U256::from_u64(10), U256::from_u64(2), U256::from_u64(7)];
    let roots = [word(0x31), word(0x32), word(0x33)];
    let mut tree = CharacterRootTree::new();
    for (id, root) in ids.iter().zip(roots.iter()) {
        tree.insert(*id, *root);
    }
    let mut sorted = CharacterRootTree::new();
    sorted.insert(U256::from_u64(2), word(0x32));
    sorted.insert(U256::from_u64(7), word(0x33));
    sorted.insert(U256::from_u64(10), word(0x31));
    assert_eq!(tree.root(), sorted.root());

    let leaf_2 = character_leaf(&U256::from_u64(2), &word(0x32));
    let leaf_7 = character_leaf(&U256::from_u64(7), &word(0x33));
    let leaf_10 = character_leaf(&U256::from_u64(10), &word(0x31));
    let left = hash_pair(&leaf_2, &leaf_7);
    let right = hash_pair(&leaf_10, &leaf_10);
    let expected = hash_pair(&left, &right);
    assert_eq!(tree.root(), expected);

    let last = tree.prove(&U256::from_u64(10)).expect("last leaf");
    assert_eq!(last.path[0].hash, leaf_10, "odd level duplicates the last node");
    assert!(!last.path[0].on_left);
    assert!(last.path[1].on_left);
    assert_eq!(last.path[1].hash, left);
    assert_eq!(recompute(&last), tree.root());
    assert!(last.verify(&tree.root(), &U256::from_u64(10), &word(0x31)));

    for (id, root) in [
        (U256::from_u64(2), word(0x32)),
        (U256::from_u64(7), word(0x33)),
        (U256::from_u64(10), word(0x31)),
    ] {
        let proof = tree.prove(&id).expect("present");
        assert_eq!(recompute(&proof), tree.root());
        assert!(proof.verify(&tree.root(), &id, &root));
    }
}

#[test]
fn a_flipped_character_root_fails_verification() {
    let token = U256::from_u64(4);
    let character_root = word(0x44);
    let other = U256::from_u64(5);
    let mut tree = CharacterRootTree::new();
    tree.insert(token, character_root);
    tree.insert(other, word(0x45));
    let root = tree.root();
    let proof = tree.prove(&token).expect("present");
    assert!(proof.verify(&root, &token, &character_root));

    let mut flipped = character_root;
    flipped[31] ^= 0x01;
    assert!(!proof.verify(&root, &token, &flipped));
    assert_ne!(character_leaf(&token, &flipped), proof.leaf);

    let mut claimed = proof.clone();
    claimed.leaf = character_leaf(&token, &flipped);
    assert!(!claimed.verify(&root, &token, &flipped));
    assert_ne!(recompute(&claimed), root);
}
