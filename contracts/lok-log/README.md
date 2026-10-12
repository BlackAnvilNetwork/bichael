# Black Anvil character contracts (lok-log; engine names unchanged) (log model)

Event-sourced characters with onchain checkpoints. The chain stores **one state root per character** plus a position in
that character's hash-chained event log. Crafting, XP, abilities and equipment are off-chain game events that anyone can
replay from the published log. Contracts: `CharacterNFT`, `CharacterCheckpoint`, `CharacterFactory`, `RulesetRegistry`,
`KekVault`. The ERC-1155 items contract and KEK (ERC-20) are external.

## How it fits together
- **Checkpoint** (`CharacterCheckpoint.checkpoint`): the owner submits (and pays gas for) a verifier-signed span of the log.
  Accepted only if `prevRoot == stateRoot`, `fromIndex == logIndex`, the ruleset is accepted, and the signer is active.
  Writes three storage slots regardless of how much changed. This blocks forks and dupes: two signed branches from one root
  can never both land.
- **Rulesets** (`RulesetRegistry`): public, timelocked record of every ruleset bundle hash (engine + rules + content +
  invariants). Replaces the old item/collection allowlists and the onchain RecipeBook.
- **Items**: live as leaves in the state tree. They become ERC-1155 tokens only via `exports[]` inside a signed checkpoint
  (mint) and return via `importItem` (burn) plus a log event that consumes it.
- **KEK** (`KekVault`): `depositKek` custodies tokens and credits the in-game counter when the log applies the event.
  `kekOut` in a signed checkpoint queues a **delayed, guardian-cancellable** withdrawal. The vault refuses to queue more
  than it holds. Solvency invariant: `vault balance >= sum of in-game KEK counters`.
- **Inbound queue**: item imports and KEK deposits share one counter (`inboundCount`); each checkpoint's `inboundConsumed`
  proves the log applied them. Watchers cross-check the log against the emitted request events.

## Hashing and ids (keccak256 everywhere)
| Value | Definition |
|---|---|
| genesis root | `keccak256(abi.encode(GENESIS_TAG, tokenId, startingJob))`; the first log event is `Spawn` |
| unique item id | `keccak256(0x01 \|\| type_id \|\| instance_id as big-endian u64)`, supply 1 |
| fungible item id | `keccak256(0x00 \|\| type_id)` |
| checkpoint signature | EIP-712 `Checkpoint(tokenId, player, version, deadline, bodyHash)`, `bodyHash = keccak256(abi.encode(Checkpoint))` |

The leading tag byte on item ids is domain separation: without it a fungible `type_id` could collide with a unique
`(type_id, instance_id)` pair. `ItemIds.sol` is the reference implementation.

## Setup
```
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.4.0 OpenZeppelin/openzeppelin-contracts-upgradeable@v5.4.0
forge test
cd test/golden && npm i && node verify.mjs
```
Solc 0.8.28, cancun. OZ 5.x (namespaced storage, so no `__gap`s).

## Roles
| Contract | Role | Holder |
|---|---|---|
| CharacterCheckpoint | DEFAULT_ADMIN | multisig (upgrades, unpause, setRulesets/setItems/setVault) |
| CharacterCheckpoint | ROTATOR | automated KMS key: `addSigner(key, expiry <= now+24h)` |
| CharacterCheckpoint | GUARDIAN | ops keys: `pause`, `revokeSigner`, `revokeAllSigners` |
| CharacterCheckpoint | FACTORY / NFT | CharacterFactory / CharacterNFT |
| CharacterNFT | MINTER | CharacterFactory |
| RulesetRegistry | DEFAULT_ADMIN | multisig (cancel, retire, setMinDelay, upgrades) |
| RulesetRegistry | PROPOSER | studio ops: normal releases, `>= minDelay` notice (48h) |
| RulesetRegistry | EMERGENCY | multisig: may skip the timelock; emitted with `emergency = true` |
| KekVault | BRIDGE | CharacterCheckpoint |
| KekVault | GUARDIAN | ops keys: `pause`, `cancel` pending withdrawals |
| KekVault | DEFAULT_ADMIN | multisig (`restore`, `unpause`, `setWithdrawDelay`, upgrades) |

## Deploy
`script/Deploy.s.sol` deploys all five behind UUPS proxies, wires roles and hands admin to the multisig.
Then the multisig: `items.setMinter(checkpoint, true)` and `factory.setStartingJob(...)`; the proposer proposes the first
ruleset and waits out the timelock; the rotator service calls `checkpoint.addSigner(sessionKey, expiry)`.

## Off-chain compatibility
`test/golden/verify.mjs` (viem) recomputes the checkpoint body hash, EIP-712 digest, genesis root and both item ids, and
must match `test/Golden.t.sol`. The Rust engine crate is `engine/` (`lok-engine`). `cargo test` there fails if the genesis root, item ids, or checkpoint body hash drift from these vectors.

## Known limits (MVP)
- Single active signer; threshold (k-of-n) signing, fraud proofs and the challenge window are not built. `checkpointedAt`
  is stored so tiered export finality can be added without a migration.
- `summary` is a verifier-signed projection (level, job, location) for cheap reads; the chain does not prove it.
- No onchain Merkle-proof verification yet; it depends on the engine's tree format.
- Unique-item supply 1 is enforced by the engine and verifier, not by the items contract. The items contract should
  also cap supply for unique ids.
