# lok-engine

First slice of the Bellgrave lok engine. It sits next to `contracts/lok-log` and must reproduce the golden vectors pinned in `test/Golden.t.sol` and recomputed by `test/golden/verify.mjs`.

KEK is deposit-only from Robinhood L2 (not earnable). `DepositKek` credits KEK already in the vault; it is not a mint. Transfers, bids, and settlement move balances the character already holds. No transfer tax and no auction fee are specified, so amounts move flat. The game server loads this crate as wasm (`pkg/lok_engine.wasm`) and persists one hash chain per character. The client exchange sits on the Provisioner.

## What is implemented

1. **State and events.** Character state is a `BTreeMap` so commitment order is sorted, not insertion order. `Input` / `Outcome` are the apply types. Each character has their own hash chain from their genesis root. A transfer or auction is the same payload on every affected character's log, and each log advances its own index. `WithdrawKek` decreases spendable KEK (escrowed bids are not spendable) and does not submit an onchain withdrawal. A lone `Engine` applies balance events that name that character; list/bid/cancel/settle need the shared listing book, so `World` appends those onto the character chains.
2. **Canonical encoding.** `abi.encode` word layout (32-byte big-endian, dynamic tail offset) and `abi.encodePacked` for item ids, hashed with keccak256. Same rules the contracts use.
3. **Genesis, then Spawn.** `genesis_root(tokenId, startingJob) = keccak256(abi.encode(GENESIS_TAG, tokenId, startingJob))` with `GENESIS_TAG = keccak256("LOK_GENESIS_V1")`. That anchor is the chain head before any events. `Spawn` is the first log event and fills the sheet the contract's `initCharacter` summary describes: level 1, the starting job, no subjob, location 0.
4. **Hash-chained log.** Entry `i` hashes as `keccak256(abi.encode(prev, index, eventId))`. `prev` for index 0 is the genesis root. `lok-replay` replays a JSON log and **stops at the first bad hash** (exit 1) without applying that event or anything after it.

## State root

Leaves are `keccak256(abi.encode(uint8 tag, uint256 keyData, uint256 value))` in `BTreeMap` order. The root is a binary Merkle tree of those leaves: pair with `keccak256(left || right)`, duplicate the last leaf when a level is odd. An empty map hashes to `keccak256("")`. The genesis anchor is **not** this root; it is the pre-Spawn commitment the contract stores in `stateRoot`.

Summary bits match `CharacterCheckpoint`: `level(16) | job(8) << 16 | subjob(8) << 24 | jobXp(32) << 32 | subjobXp(32) << 64 | location(16) << 96 | unspentPoints(16) << 112`.

## Checkpoint body

`checkpoint_body_hash` is `keccak256(abi.encode(Checkpoint))` for the struct in `CharacterCheckpoint.sol`, including the `exports` tail. EIP-712 digest helper uses domain name `CharacterCheckpoint`, version `1`.

## Replay log

```json
{
  "tokenId": "1",
  "startingJob": 3,
  "entries": [
    {
      "hash": "0x…",
      "input": { "type": "spawn", "tokenId": "1", "startingJob": 3 }
    }
  ]
}
```

```
lok-replay log.json
```

Exit 0 prints the head, state root, and summary. Exit 1 is a bad hash. Exit 2 is a parse error or a rejected input (after its hash checked out).

## Tests

`cargo test` fails if the genesis root, item ids (`iron_sword` / 42 and `iron_ore`), or checkpoint body hash drift from the Solidity pins. The digest from `verify.mjs` is pinned too (chain id 31337, verifying contract `0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9`).

## Loot: ItemDrop and LootDrop

`lootDrop` is the loot counter. Like `harvest` it counts and never credits items or KEK; mob loot is logged with it. `itemDrop` is closed for new appends (`ClosedMint`). `itemDrop` entries already on a log at `seq <= HISTORICAL_ITEM_DROP_MAX_SEQ` (174, the last seq of the quarantined pre-#206 live log) replay as the item credit they were when written. A logged `itemDrop` past that seq is refused on replay too, so it cannot mint. Committed entries are never rewritten into `lootDrop`; that would change their hashes. `tests/historical_item_drop.rs` replays fixtures copied from that log.

## Wasm pin

`apps/server/src/lok-vault.ts` pins the sha256 of `pkg/lok_engine.wasm` as `LOCAL_RULESET_WASM_SHA256` next to `LOCAL_RULESET_HASH`, and `apps/server/src/lok-ruleset-pin.test.ts` fails when they disagree. After an engine change, run `node scripts/check-wasm-pin.mjs --install` (rebuilds, copies into `pkg/`, prints the digest), update the pin, and off-local propose a new ruleset hash. `node scripts/check-wasm-pin.mjs` rebuilds and diffs against `pkg/` without installing. A rebuild is byte-identical only on the same toolchain and host paths.

## Per-character logs

`World` is the API the game server calls. It does not talk to the chain.

| Call | Event | Written onto |
|---|---|---|
| `append_spawn` | `spawn` | that character |
| `append_deposit_kek` | `depositKek` (vault deposit already happened; not a mint; `nonce` is the next inbound id) | that character |
| `append_withdraw_kek` | `withdrawKek` (spendable only; not an onchain withdrawal) | that character |
| `append_spend_kek` | `spendKek` (spendable only; in-game price; not `kekOut`; not a mint) | that character |
| `append_import_item` | `importItem` (same per-character inbound nonce sequence as `depositKek`) | that character |
| `append_export_item` | `exportItem` (spendable balance only) | that character |
| `append_send_item` | `sendItem` | sender and recipient |
| `append_send_kek` | `sendKek` | sender and recipient |
| `append_list` | `list` | seller |
| `append_bid` | `bid` | bidder and the previous high bidder, if any |
| `append_cancel` | `cancel` | seller and the high bidder, if any |
| `append_settle` | `settle` | seller and winner |

The payload (and therefore `event_id`) is the same on every log that carries the event. `entry_hash` is `keccak256(abi.encode(prev, index, eventId))` with **that log's** previous head and index, so the links differ. `seq` in the JSON is replay order and is not part of the hash. A character checkpoint covers only that character's span: `fromIndex` / `toIndex` / `logHash` are that chain.

`commit_span` records the committed prefix (`logIndex`). `rebase` drops only that character's uncommitted tail and replays what remains, so another character's committed copy of the trade is not removed.

Reads: `kek_balance` (spendable), `solvency_kek` (spendable + escrowed bids), `item_balance`, `listing`, `listings`. `apply` is the same append path with an `Input`.

Listing escrows the item out of the seller's spendable balance, so that quantity cannot be transferred, exported, or listed again. A bid escrows that much KEK. A strictly higher bid unlocks the previous bid first. Cancel is seller-only: the item returns and the high bid unlocks. Settle pays the seller the high bid and gives the item to the winner, with nothing left in escrow. Sender and recipient must already be spawned. Sending to yourself fails. A short balance, including a withdraw or spend that would take escrowed KEK, fails closed and is not appended. `spendKek` debits spendable KEK and does not mint. It is not `kekOut`.

`lok-replay` of a document with `"type": "characters"` replays those chains and still stops at the first bad hash (exit 1) before applying it or anything after it. An empty legacy `{"type":"world","entries":[]}` file still opens. A non-empty legacy world log is refused, because that single chain cannot be split into per-character checkpoints.

```json
{
  "type": "characters",
  "characters": [
    {
      "tokenId": "1",
      "startingJob": 3,
      "entries": [
        { "seq": 0, "hash": "0x…", "input": { "type": "spawn", "tokenId": "1", "startingJob": 3 } },
        { "seq": 2, "hash": "0x…", "input": { "type": "sendKek", "from": "1", "to": "2", "amount": "4" } }
      ]
    },
    {
      "tokenId": "2",
      "startingJob": 1,
      "entries": [
        { "seq": 1, "hash": "0x…", "input": { "type": "spawn", "tokenId": "2", "startingJob": 1 } },
        { "seq": 2, "hash": "0x…", "input": { "type": "sendKek", "from": "1", "to": "2", "amount": "4" } }
      ]
    }
  ]
}
```

## Left for the next slice

Ruleset evaluation, XP / abilities / equipment inputs, Merkle proofs for the state root, and watching `KekVault` before appending `depositKek`. `checkpoint_span` drafts a per-character body (including `kekOut` from `WithdrawKek` in the span, and `inboundConsumed` equal to how many `depositKek` / `importItem` events that character's log has applied up to `toIndex`) but does not submit it. Those two events carry the chain inbound nonce and are accepted only in order, once. Replaying a nonce does not credit. The server appends them only for a custody nonce it has already recorded; the game client cannot. There is no client `lok/deposit`. Player `lok/import` does not move bag items, and `lok/withdrawKek` is refused until a vault withdrawal is queued, so it cannot burn in-game KEK; the engine `WithdrawKek` op remains for that queue. No KekVault watcher is wired. The server does not follow Robinhood L2 unless `LOK_CHAIN_RPC` is set, and even then it does not submit or index chain transactions.
