# Black Anvil rebrand

Product name is **Black Anvil** (formerly Bellgrave / Legend of KEK).

## Deliberately left with old names

These stay so log replay, deployed contracts, and workspace tooling keep working:

| Kind | Examples |
|------|----------|
| npm / workspace packages | `bellgrave`, `@bellgrave/web`, `@bellgrave/server`, `@bellgrave/combat`, `@bellgrave/config`, `@bellgrave/protocol`, `@bellgrave/items` |
| On-chain / Foundry | `MockKEK`, `KEK_TOKEN`, contract type names, `lok-log` package path |
| Engine / log ops | `DepositKek`, `withdrawKek`, `Key::Kek`, event schemas, wasm ruleset hashes |
| Client storage / events | `bellgrave.uiSettings`, `bellgrave.wallet*`, `bellgrave:toggle-*` CustomEvents |
| World content ids | Zone/POI strings such as **Citadel of KEK**, Bellmarsh (setting names, not product brand) |
| Historical docs / auction copy | “legacy KEK” token-era warnings; dry-run deploy notes |

User-facing UI strings, page title/meta, AppKit metadata, README/docs titles, and mint-claim **display** message text were updated to Black Anvil (client + server mint-claim must stay in sync).
