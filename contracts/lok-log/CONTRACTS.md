# Locked product decisions

These decisions are locked for the lok-log package.

## Current lock (gold + ETH via EEZ; log is game-only)

- **Two units, two homes.**
  - **Gold** — in-game only (log counter). Training, crafting, respec, NPC shops. No token, no vault, no player-to-player gold send in v1.
  - **ETH** — auction house, PvP bounties, and any real-value player payment. Lives on **chain** (EEZ sync `value` into first-party escrow). **Not** a spendable balance on the character log.
- **The log does not manage funds.** No player deposit into a game vault, no log-credited settlement balance for AH/PvP, no `lok/deposit` / withdraw / claim / send-ETH play path. Historical `DepositKek` / `SendKek` / bid-escrow-on-log events stay for **replay only**. After the wipe, new play does not credit settlement ETH onto `Key::Kek` for spending.
- **AH payment is EEZ-only.** Buyers pay native ETH (unwrap WETH on the home chain when needed) through **[eez-core-protocol](https://github.com/eez-association/eez-core-protocol)** sync calls into first-party [`AhEscrow.sol`](src/AhEscrow.sol). There is **no deposit fallback**. On fill, the server appends log `chainFill` (item inbox only). Chains outside the EEZ zone cannot pay until they join the zone (or the player moves ETH onto a zone chain themselves — outside our vault). See [`docs/eez-ah-research.md`](../../docs/eez-ah-research.md).
- **What the log still governs:** character identity, levels, abilities, gold, items (including AH **item** escrow and inbox), harvest/craft/loot counters, mirrors of on-chain fills (item credit/debit), and **PvP bounty mirrors** (`pvpBountyOpen` / `pvpBountyCancel` / `pvpKill`). The client cannot invent custody.
- **PvP bounties are on-chain xDAI, mirrored on the log.** Players escrow a fixed **1 xDAI** (1×10¹⁸ wei) head-bounty into first-party `PvpBounty` escrow. The log records open / cancel / kill with `txHash`+`logIndex` and tracks which characters have an open bounty for replay. It never credits or debits settlement value/`Key::Kek`. A kill clears only the victim's open bounty; the slayer is paid on-chain. Area level caps (e.g. Ash Pit L30) are server combat rules, not log events.
- **Gold** never converts directly to ETH. The route is item → AH (chain pay) → ETH to seller.
- **Gold day is server-trusted.** `GoldEarn` / `GoldSell` carry a server-stamped `day` (UTC days since epoch). The engine rejects `day == 0`, a day lower than the character's last earn day (`StaleDay`), and any day above `GOLD_MAX_DAY` (100000), so one bad stamp cannot lock a character's later earns. A replayer cannot check the day against wall time, though: a server that stamps a higher day resets the daily caps early. Daily caps therefore only bind an honest server clock. Binding the day to something verifiable (block timestamp in the checkpoint, or a signed day beacon) is open.
- **NPC buy-back price is server-trusted.** `GoldSell` credits whatever `amount` the server passes; only the `npc_sell` daily cap bounds it. A per-item NPC price table in the engine (`amount <= price(item) * qty`) is the planned fix (E5 budget sheet) so a replayer can reject an over-paid sell.
- **EEZ caveats are binding.** Upstream is early-stage and unaudited. Upstream `src/periphery/` is test-only. Game-facing escrow is first-party.
- **New events only.** Do not change the meaning or serialization of any existing event. Fresh log + anvil wipe on the batched redeploy; bump `LOCAL_RULESET_HASH` and the wasm pin together.
- **AH fee:** still undecided. If a fee ships, it is in ETH on-chain and this file must be updated before merge.
- **Known MVP limits** stay as the package README already states: no k-of-n signer threshold, no fraud proofs, no on-chain Merkle proof yet, and unique-item supply of 1 is not enforced in the items contract.

Design: [`docs/economy-weth-eez.md`](../../docs/economy-weth-eez.md) · EEZ AH: [`docs/eez-ah-research.md`](../../docs/eez-ah-research.md).

## Superseded (KEK vault / deposit era — replay only)

- KEK deposit-only from Robinhood, trainer/craft via `spendKek`, `KekVault` caps/delays, inbound nonces, client had no invent-deposit — that was the fund-custody play path.
- **Removed as product:** park-then-play vault, log settlement balance for AH, deposit fallback for “other chains.”

Do not reinterpret those events. Do not reintroduce a player vault deposit for AH or PvP.

---

This directory is a standalone Foundry project. It is not a pnpm workspace package. The game (`apps/*`, `packages/*`) does not compile these Solidity files.
