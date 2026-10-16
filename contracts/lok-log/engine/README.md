# lok-engine

First slice of the Bellgrave lok engine. It sits next to `contracts/lok-log` and must reproduce the golden vectors pinned in `test/Golden.t.sol` and recomputed by `test/golden/verify.mjs`.

In-game **gold** is a separate log balance (`GoldEarn` / `GoldSpend` / `GoldSell`) with daily earn caps. It is not vault-backed. Historical **KEK** events stay for replay; new AH/PvP settlement targets WETH via EEZ (see `docs/economy-weth-eez.md`). The game server loads this crate as wasm (`pkg/lok_engine.wasm`) and persists one hash chain per character.

## What is implemented

1. **State and events.** Character state is a `BTreeMap` so commitment order is sorted, not insertion order. `Input` / `Outcome` are the apply types. Each character has their own hash chain from their genesis root. A transfer or auction is the same payload on every affected character's log, and each log advances its own index. `WithdrawKek` decreases spendable KEK (escrowed bids are not spendable) and does not submit an onchain withdrawal. A lone `Engine` applies balance events that name that character; list/bid/cancel/settle need the shared listing book, so `World` appends those onto the character chains.
2. **Canonical encoding.** `abi.encode` word layout (32-byte big-endian, dynamic tail offset) and `abi.encodePacked` for item ids, hashed with keccak256. Same rules the contracts use.
3. **Genesis, then Spawn.** `genesis_root(tokenId, startingJob) = keccak256(abi.encode(GENESIS_TAG, tokenId, startingJob))` with `GENESIS_TAG = keccak256("LOK_GENESIS_V1")`. That anchor is the chain head before any events. `Spawn` is the first log event and fills the sheet the contract's `initCharacter` summary describes: level 1, the starting job, no subjob, location 0.
4. **Hash-chained log.** Entry `i` hashes as `keccak256(abi.encode(prev, index, eventId, rulesetHash))`. `prev` for index 0 is the genesis root. `rulesetHash` is 32 bytes and is always in the preimage; thirty-two zero bytes still differ from a link that stopped at `eventId`. `lok-replay` replays a JSON log and **stops at the first bad hash** (exit 1) without applying that event or anything after it.

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

`lootDrop` is the loot counter. Like `harvest` it counts and never credits items or KEK. A new drop is accepted only when the same batch contains the kill it names. A kill from an earlier batch does not count. An already-logged `lootDrop` omits that kill, so its event id stays the three-field preimage and still replays. `itemDrop` is `ClosedMint` on append and on replay. `seq` is not in the entry hash, so a low seq does not credit items. A log that still contains `itemDrop` does not open; clear it. Rewriting a committed `itemDrop` into `lootDrop` would change its hash. `tests/historical_item_drop.rs` keeps the pre-#206 fixtures and expects them to be refused. `PvpKill` is an on-chain bounty mirror and does not justify a drop.

## Wasm pin

`apps/server/src/lok-vault.ts` pins the sha256 of `pkg/lok_engine.wasm` as `LOCAL_RULESET_WASM_SHA256` next to `LOCAL_RULESET_HASH`, and `apps/server/src/lok-ruleset-pin.test.ts` fails when they disagree. After an engine change, run `node scripts/check-wasm-pin.mjs --install` (rebuilds, copies into `pkg/`, prints the digest), update the pin, and off-local propose a new ruleset hash. `node scripts/check-wasm-pin.mjs` rebuilds and diffs against `pkg/` without installing. A rebuild is byte-identical only on the same toolchain and host paths.

## Per-character logs

`World` is the API the game server calls. It does not talk to the chain.

| Call | Event | Written onto |
|---|---|---|
| `append_spawn` | `spawn` | that character |
| `append_gold_earn` | `goldEarn` (server day + daily caps) | that character |
| `append_gold_spend` | `goldSpend` (trainer / craft / respec sinks) | that character |
| `append_gold_sell` | `goldSell` (NPC buy-back; burns items, credits gold) | that character |
| `append_import_item` | `importItem` (per-character inbound nonce) | that character |
| `append_bag_export` | `bagExport` (back to the bag; not a checkpoint mint) | that character |
| `append_export_item` | `exportItem` (chain withdrawal; packed into checkpoint exports) | that character |
| `append_send_item` | `sendItem` | sender and recipient |
| `append_list` | `list` (item escrow; no KEK bid) | seller |
| `append_cancel` | `cancel` | seller |
| `append_ask` | `ask` | seller |
| `append_chain_fill` | `chainFill` (item to inbox; ETH stays on AhEscrow) | buyer |

The payload (and therefore `event_id`) is the same on every log that carries the event. `entry_hash` is `keccak256(abi.encode(prev, index, eventId, rulesetHash))` with **that log's** previous head, index, and the ruleset hash in force when the entry was appended, so the links differ. `seq` in the JSON is replay order and is not part of the hash. A character checkpoint covers only that character's span: `fromIndex` / `toIndex` / `logHash` are that chain.

`commit_span` records the committed prefix (`logIndex`). `rebase` drops only that character's uncommitted tail and replays what remains, so another character's committed copy of the trade is not removed.

Reads: `gold_balance`, `item_balance`, `listing`, `listings`. `apply` is the same append path with an `Input`.

A bag export debits spendable items and is not included in checkpoint `exports`. `exportItem` is the chain withdrawal: the same debit, and the span's checkpoint lists it for ERC-1155 minting when exports are enabled. Listing escrows the item out of the seller's spendable balance, so that quantity cannot be transferred, exported, or listed again. Cancel is seller-only and returns the item. A KEK bid, settle, fill, or buy is refused and is not appended. Live payment is an AhEscrow `chainFill`, which puts the stack in the buyer's inbox and does not move gold. Sender and recipient must already be spawned. Sending to yourself fails. A short balance fails closed and is not appended.

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
        { "seq": 2, "hash": "0x…", "input": { "type": "sendItem", "from": "1", "to": "2", "itemId": "7", "amount": "4" } }
      ]
    },
    {
      "tokenId": "2",
      "startingJob": 1,
      "entries": [
        { "seq": 1, "hash": "0x…", "input": { "type": "spawn", "tokenId": "2", "startingJob": 1 } },
        { "seq": 2, "hash": "0x…", "input": { "type": "sendItem", "from": "1", "to": "2", "itemId": "7", "amount": "4" } }
      ]
    }
  ]
}
```

## Left for the next slice

Ruleset evaluation, XP / abilities / equipment inputs, and Merkle proofs for the state root. `checkpoint_span` drafts a per-character body (`inboundConsumed` equals how many `importItem` events that character's log has applied up to `toIndex`) but does not submit it. There is no `kekOut`. Item imports carry the chain inbound nonce and are accepted only in order, once. Replaying a nonce does not credit. The server appends them only for a custody nonce it has already recorded; the game client cannot. KEK custody ops are retired and are not appended. The server does not submit or index chain transactions unless `LOK_CHAIN_RPC` is set, and even then it does not follow a KEK vault.
