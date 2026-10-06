/** Read-only projection of the order-book fill. Settlement stays the existing buy. */

/**
 * Whole asks one quantity-buy message may fill on the server
 * (MAX_FILLS_PER_BUY_MESSAGE in apps/server/src/lok-world.ts, a locked rule).
 * The plan uses the same cap so the UI total matches what one click buys.
 */
export const MAX_QUANTITY_FILLS = 32;

export type AskQuote = {
  id: string;
  seller: string;
  itemId: number;
  amount: string;
  minPrice: string;
  listedAt: number;
  book: boolean;
};

export type PlannedFill = {
  id: string;
  seller: string;
  amount: string;
  price: string;
};

export type QuantityPlan = {
  fills: PlannedFill[];
  filled: string;
  short: boolean;
  /** True when the per-message fill cap, not the book, stopped the plan. */
  capped?: boolean;
};

function dec(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Cheapest ask, then oldest, then lowest id.
 * Same order as the engine's choose_ask_capped. Does not append.
 */
export function compareAsks(a: AskQuote, b: AskQuote): number {
  const ap = dec(a.minPrice);
  const bp = dec(b.minPrice);
  if (ap == null || bp == null) {
    if (ap == null && bp == null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return ap == null ? 1 : -1;
  }
  if (ap < bp) return -1;
  if (ap > bp) return 1;
  if (a.listedAt !== b.listedAt) return a.listedAt - b.listedAt;
  const ai = dec(a.id);
  const bi = dec(b.id);
  if (ai == null || bi == null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

/**
 * Whole asks only. Stops once the item count is met, or when the book of asks
 * this buyer can fill runs out. A stack larger than the remainder is included
 * whole at its own ask. The buyer's own asks are skipped. No blended price.
 */
export function planQuantityFills(
  asks: AskQuote[],
  buyer: string,
  itemId: number,
  qty: number,
  maxFills: number = MAX_QUANTITY_FILLS,
): QuantityPlan {
  if (!Number.isSafeInteger(qty) || qty < 1) return { fills: [], filled: "0", short: true };
  const ordered = asks
    .filter((ask) => {
      if (!ask.book || ask.itemId !== itemId || ask.seller === buyer) return false;
      const price = dec(ask.minPrice);
      const amount = dec(ask.amount);
      return price != null && price > 0n && amount != null && amount > 0n;
    })
    .sort(compareAsks);
  const fills: PlannedFill[] = [];
  let filled = 0n;
  const want = BigInt(qty);
  let capped = false;
  for (const ask of ordered) {
    if (filled >= want) break;
    if (fills.length >= maxFills) {
      capped = true;
      break;
    }
    const amount = dec(ask.amount);
    if (amount == null || amount <= 0n) continue;
    fills.push({ id: ask.id, seller: ask.seller, amount: ask.amount, price: ask.minPrice });
    filled += amount;
  }
  return { fills, filled: filled.toString(), short: filled < want, ...(capped ? { capped: true } : {}) };
}
