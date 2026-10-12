# @bellgrave/items

Item catalog for Black Anvil (formerly Legend of Kek / Bellgrave): stats, descriptions, icon paths, craft metadata.

**Source of truth:** `docs/legend-of-kek-item-manifest.xlsx`

## On-chain ids (Gnosis Items.sol)

Craft/recipes keep catalog **small-int `id` + kebab `slug`**. Settlement ERC-1155 ids are content-addressed:

- fungible: `chainFungibleId(slug)` ≡ `ItemIds.fungible(slug)`
- unique: `chainUniqueId(slug, instanceId)` ≡ `ItemIds.unique(slug, n)`

Register new exportable types with `Items.registerFungible(slug, …)` — **no contract redeploy**. Log replay / checkpoint / watchers treat `itemId` as opaque `uint256`.

```bash
pnpm --filter @bellgrave/items test
```

## Regen

```bash
py -3 scripts/build-item-catalog.py
py -3 scripts/bake-item-icons.py
```


Icons are **painted PNGs** (96×96, magenta-keyed) under `apps/web/public/icons/items/{slug}.png`.

## Stats

NQ budgets from craft level (`B = floor(lv/5)+1`). HQ = ceil(NQ × 1.25) via `hqStats()`.

Equipment combat stats are generated in `scripts/build-item-catalog.py` (`build_stats`).
Scaling is keyed to **chainmail** (rare body, craftLevel 10): `{str:5, dex:5, agi:5, def:10}`
→ combat power 25. Crafted NQ body combat (def + role attrs) tracks ~`5*B`
(below chainmail at B=3, catches up ~B=5 / lv20, ~87 at B=21 / lv100). Other armor
slots are fractions of body DEF; weapons scale offense with B. Per-slug
`STAT_OVERRIDES` win after `build_stats` (chainmail stays hand-tuned).
