# Black Anvil contracts (package still @bellgrave / lok-log) (post-MVP)

MVP inventory and potion burns are **mock** (server-side inventory decrement).

Planned V1 surface (Robinhood Chain, ERC-4337):

| Contract | Role |
| --- | --- |
| `BellgraveItems` | ERC-1155 gear + consumables |
| `BellgraveBurnRelay` | Account-abstraction friendly consumable burn |
| `BellgraveMarketplace` | Escrow buy/sell (equip stays offchain) |

Do not implement here until Alchemy/AA keys and chain RPC are wired in `apps/web`.

## lok-log (Foundry)

The event-sourced character log (checkpoints, rulesets, vault/escrow) is in `contracts/lok-log/`. It is a standalone Foundry package, not part of the pnpm workspace, and the game packages do not compile it. Locked product decisions are in `contracts/lok-log/CONTRACTS.md` (gold + WETH via EEZ; KEK path is replay-only). Design: `docs/economy-weth-eez.md`.
