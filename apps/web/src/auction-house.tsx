import { CATALOG, EQUIP_SLOTS, getItem, type EquipSlot, type ItemDef, type ItemKind } from "@bellgrave/items";
import { compareAsks, MAX_QUANTITY_FILLS, planQuantityFills, type AskQuote, type LokListingView, type QuantityPlan } from "@bellgrave/protocol";
import { useState } from "react";
import { ItemCatalogDetails, ItemTipHost } from "./itemTip";
import { send } from "./net";

const WEEK_SEC = 7 * 24 * 60 * 60;

const KIND_TREE: { kind: ItemKind; label: string; slots: boolean }[] = [
  { kind: "base", label: "Materials", slots: false },
  { kind: "intermediate", label: "Components", slots: false },
  { kind: "consumable", label: "Consumables", slots: false },
  { kind: "bait", label: "Bait", slots: false },
  { kind: "filler", label: "Filler", slots: false },
  { kind: "equipment", label: "Equipment", slots: true },
];

const SLOT_LABEL: Record<EquipSlot, string> = {
  head: "Head",
  body: "Body",
  hands: "Hands",
  legs: "Legs",
  feet: "Feet",
  ring: "Ring",
  earring: "Earring",
  main: "Main hand",
  sub: "Off hand",
  grip: "Grip",
  ranged: "Ranged",
  ammo: "Ammo",
};

function itemName(tokenId: number): string {
  return getItem(tokenId)?.name ?? "Item " + tokenId;
}

function quoteOf(row: LokListingView): AskQuote {
  return {
    id: row.id,
    seller: row.seller,
    itemId: row.itemId,
    amount: row.amount,
    minPrice: row.minPrice,
    listedAt: row.listedAt,
    book: row.book,
  };
}

function asInt(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function formatUnit(price: bigint, amount: bigint): string {
  if (amount <= 0n) return price.toString();
  const whole = price / amount;
  const rem = price % amount;
  if (rem === 0n) return whole.toString();
  const frac = (rem * 100n) / amount;
  const digits = frac.toString().padStart(2, "0").replace(/0+$/, "");
  return whole.toString() + "." + digits;
}

function lowestUnit(rows: LokListingView[]): string {
  let best: { price: bigint; amount: bigint } | null = null;
  for (const row of rows) {
    const price = asInt(row.minPrice);
    const amount = asInt(row.amount);
    if (price == null || amount == null || price <= 0n || amount <= 0n) continue;
    if (!best || price * best.amount < best.price * amount) best = { price, amount };
  }
  return best ? formatUnit(best.price, best.amount) : "0";
}

function sumAmount(rows: LokListingView[]): string {
  let total = 0n;
  for (const row of rows) {
    const amount = asInt(row.amount);
    if (amount != null) total += amount;
  }
  return total.toString();
}

function sumPrices(fills: { price: string }[]): string {
  let total = 0n;
  for (const fill of fills) {
    const price = asInt(fill.price);
    if (price != null) total += price;
  }
  return total.toString();
}

type Commodity = {
  itemId: number;
  name: string;
  total: string;
  unit: string;
  rows: LokListingView[];
};

function matchesCategory(def: ItemDef, selected: string): boolean {
  if (selected.startsWith("slot:")) return def.kind === "equipment" && def.slot === selected.slice(5);
  if (selected.startsWith("kind:")) return def.kind === selected.slice(5);
  return false;
}

function bookByItem(listings: LokListingView[]): Map<number, LokListingView[]> {
  const groups = new Map<number, LokListingView[]>();
  for (const row of listings) {
    if (!row.book) continue;
    const list = groups.get(row.itemId) ?? [];
    list.push(row);
    groups.set(row.itemId, list);
  }
  return groups;
}

function commodityOf(def: ItemDef, rows: LokListingView[]): Commodity {
  const ordered = rows.slice().sort((a, b) => compareAsks(quoteOf(a), quoteOf(b)));
  const buyable = ordered.filter((row) => !row.yours);
  const priced = buyable.length > 0 ? buyable : ordered;
  const unit = lowestUnit(priced);
  return {
    itemId: def.id,
    name: def.name,
    total: sumAmount(ordered),
    unit: unit === "0" ? "none" : unit,
    rows: ordered,
  };
}

/** Full content catalog, enriched with asks already on the client. Search never hits the chain. */
function commodities(listings: LokListingView[], query: string, selected: string | null): Commodity[] {
  const q = query.trim().toLowerCase();
  const groups = bookByItem(listings);
  const out: Commodity[] = [];
  for (const def of CATALOG) {
    if (q) {
      if (!def.name.toLowerCase().includes(q)) continue;
    } else if (!selected || !matchesCategory(def, selected)) {
      continue;
    }
    out.push(commodityOf(def, groups.get(def.id) ?? []));
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.itemId - b.itemId);
  return out;
}

function commodityById(listings: LokListingView[], itemId: number): Commodity | null {
  const def = getItem(itemId);
  if (!def) return null;
  const rows = listings.filter((row) => row.book && row.itemId === itemId);
  return commodityOf(def, rows);
}

function categoryCount(selected: string, query: string): number {
  const q = query.trim().toLowerCase();
  let count = 0;
  for (const def of CATALOG) {
    if (!matchesCategory(def, selected)) continue;
    if (q && !def.name.toLowerCase().includes(q)) continue;
    count += 1;
  }
  return count;
}

function buyNote(plan: QuantityPlan, qty: number): string {
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1_000_000) return "Enter how many to buy.";
  if (plan.fills.length === 0) return "No ask you can buy. Your own listings are skipped.";
  const total = sumPrices(plan.fills);
  const over = BigInt(plan.filled) > BigInt(qty) ? " The last stack is taken whole at its own ask." : "";
  const short = plan.capped
    ? " One buy fills at most " + MAX_QUANTITY_FILLS + " asks, so this click stops after " + plan.filled + ". Buy again for the rest."
    : plan.short
      ? " The book runs out after " + plan.filled + "."
      : "";
  return "Total " + total + " KEK across " + plan.fills.length + " asks. Each ask is charged its own price, not a blended rate." + over + short;
}

type Props = { listings: LokListingView[]; buyer: string };

export function AuctionBook({ listings, buyer }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [equipmentOpen, setEquipmentOpen] = useState(true);
  const [buyingId, setBuyingId] = useState<number | null>(null);
  const [qtyText, setQtyText] = useState("1");
  const lines = commodities(listings, query, selected);
  const buying = buyingId == null ? null : commodityById(listings, buyingId);
  const qty = Number(qtyText);
  const plan =
    buying && Number.isSafeInteger(qty) && qty >= 1 && qty <= 1_000_000
      ? planQuantityFills(buying.rows.map(quoteOf), buyer, buying.itemId, qty)
      : { fills: [], filled: "0", short: true };
  const yours = listings.filter((row) => row.yours || row.highBidder === buyer);
  const searching = query.trim().length > 0;

  return (
    <div className="prov-market">
      <label className="prov-search">
        <span className="cmd-section-label">Auction</span>
        <input
          value={query}
          placeholder="Search item names"
          aria-label="Search item names"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="prov-split">
        <div className="prov-tree" role="tree" aria-label="Item categories">
          {KIND_TREE.map((node) => {
            const id = "kind:" + node.kind;
            const count = categoryCount(id, query);
            return (
              <div key={node.kind}>
                <div className="prov-branch">
                  {node.slots && (
                    <button
                      type="button"
                      className="prov-chev"
                      aria-expanded={equipmentOpen}
                      onClick={() => setEquipmentOpen((open) => !open)}
                    >
                      {equipmentOpen ? "-" : "+"}
                    </button>
                  )}
                  <button
                    type="button"
                    role="treeitem"
                    className={selected === id && !searching ? "prov-node on" : "prov-node"}
                    onClick={() => setSelected(id)}
                  >
                    {node.label}
                    <span className="prov-count">{count}</span>
                  </button>
                </div>
                {node.slots && equipmentOpen && (
                  <div className="prov-children">
                    {EQUIP_SLOTS.map((slot) => {
                      const slotId = "slot:" + slot;
                      const slotCount = categoryCount(slotId, query);
                      return (
                        <button
                          key={slot}
                          type="button"
                          role="treeitem"
                          className={selected === slotId && !searching ? "prov-node on" : "prov-node"}
                          onClick={() => setSelected(slotId)}
                        >
                          {SLOT_LABEL[slot]}
                          <span className="prov-count">{slotCount}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="prov-book" aria-label="Commodities">
          {!searching && !selected && <p className="lok-note">Choose a category.</p>}
          {(searching || selected) && lines.length === 0 && <p className="lok-note">No items match.</p>}
          {lines.map((line) => (
            <ItemTipHost key={line.itemId} tokenId={line.itemId} active={buyingId == null}>
              <button
                type="button"
                className="prov-commodity"
                onClick={() => {
                  setBuyingId(line.itemId);
                  setQtyText("1");
                }}
              >
                <span className="prov-name">{line.name}</span>
                <span className="prov-qty">{line.total} listed</span>
                <span className="prov-ask">{line.unit === "none" ? "none" : line.unit + " KEK each"}</span>
              </button>
            </ItemTipHost>
          ))}
        </div>
      </div>
      {buying && (
        <div className="prov-dialog" role="dialog" aria-label={"Buy " + buying.name}>
          <div className="prov-dialog-head">
            <div>
              <div className="cmd-kicker">Commodity</div>
              <div className="item-panel-details">
                <ItemCatalogDetails tokenId={buying.itemId} />
              </div>
            </div>
            <button type="button" className="cmd-close-btn" onClick={() => setBuyingId(null)}>
              Close
            </button>
          </div>
          <p className="lok-note">How many do you want to buy?</p>
          <div className="lok-row">
            <button
              type="button"
              className="cmd-pill-tab"
              onClick={() => setQtyText(String(Math.max(1, (Number.isFinite(qty) ? qty : 1) - 1)))}
            >
              -
            </button>
            <input
              value={qtyText}
              aria-label="Quantity to buy"
              onChange={(e) => setQtyText(e.target.value)}
            />
            <button
              type="button"
              className="cmd-pill-tab"
              onClick={() => setQtyText(String(Math.min(1_000_000, (Number.isFinite(qty) ? qty : 0) + 1)))}
            >
              +
            </button>
          </div>
          <ul className="prov-fills">
            {plan.fills.slice(0, 8).map((fill) => (
              <li key={fill.id}>
                x{fill.amount} at {fill.price} KEK
              </li>
            ))}
            {plan.fills.length > 8 && <li>plus {plan.fills.length - 8} more asks, cheapest first</li>}
          </ul>
          <p className="lok-note">{buyNote(plan, qty)}</p>
          <button
            type="button"
            className="boot-primary"
            disabled={plan.fills.length === 0}
            onClick={() => {
              if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1_000_000 || plan.fills.length === 0) return;
              send({ type: "lok/buy", itemId: buying.itemId, qty });
              setBuyingId(null);
            }}
          >
            Confirm purchase
          </button>
          <YourAsks rows={buying.rows.filter((row) => row.yours)} />
        </div>
      )}
      <div className="cmd-section-label">Your listings</div>
      {yours.length === 0 && <p className="lok-note">You have nothing listed.</p>}
      {yours.length > 0 && <YourAsks rows={yours} showSettle />}
    </div>
  );
}

function YourAsks({ rows, showSettle }: { rows: LokListingView[]; showSettle?: boolean }) {
  if (rows.length === 0) return <p className="lok-note">None of these asks are yours.</p>;
  const now = Date.now() / 1000;
  return (
    <div className="prov-yours">
      {rows.map((row) => (
        <div className="prov-yours-line" key={row.id}>
          <span>
            {itemName(row.itemId)} x{row.amount}
            {row.book ? " ask " + row.minPrice + " KEK" : " legacy"}
          </span>
          {row.yours && (
            <button type="button" className="cmd-pill-tab" onClick={() => send({ type: "lok/cancel", listingId: row.id })}>
              Cancel
            </button>
          )}
          {row.book && row.yours && row.listedAt > 0 && now >= row.listedAt + WEEK_SEC && (
            <button type="button" className="cmd-pill-tab" onClick={() => send({ type: "lok/reclaim", listingId: row.id })}>
              Reclaim
            </button>
          )}
          {showSettle && !row.book && row.highBidder && (
            <button type="button" className="cmd-pill-tab" onClick={() => send({ type: "lok/settle", listingId: row.id })}>
              Settle
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
