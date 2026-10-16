/**
 * Merge Harvest, LootDrop, and GoldEarn rows that share a character (and
 * material, item, or gold source) inside one game tick. The engine still
 * sees one event per key; the amounts add.
 */

export type CoalescedHarvest = {
  op: "harvest";
  tokenId: string;
  materialId: string;
  amount: string;
};

export type CoalescedLoot = {
  op: "lootDrop";
  tokenId: string;
  itemId: string;
  amount: string;
  killId: string;
  batchId: number;
};

export type CoalescedGold = {
  op: "goldEarn";
  tokenId: string;
  source: string;
  amount: string;
  day: number;
};

export type CoalescedEvent = CoalescedHarvest | CoalescedLoot | CoalescedGold;

const AMOUNT = /^[1-9][0-9]{0,77}$/;

function addAmount(prev: string, next: string): string | null {
  if (!AMOUNT.test(prev) || !AMOUNT.test(next)) return null;
  return (BigInt(prev) + BigInt(next)).toString();
}

export class TickCoalesce {
  private rows = new Map<string, CoalescedEvent>();

  get size(): number {
    return this.rows.size;
  }

  add(row: CoalescedEvent): { ok: true } | { ok: false; error: string } {
    if (!row.tokenId) return { ok: false, error: "Missing character." };
    if (!AMOUNT.test(row.amount)) return { ok: false, error: "Bad amount." };
    const key = keyOf(row);
    if (!key) return { ok: false, error: "Bad " + row.op + " fields." };
    const prev = this.rows.get(key);
    if (!prev) {
      this.rows.set(key, row);
      return { ok: true };
    }
    const amount = addAmount(prev.amount, row.amount);
    if (amount == null) return { ok: false, error: "Bad amount." };
    this.rows.set(key, { ...prev, amount });
    return { ok: true };
  }

  drain(): CoalescedEvent[] {
    const out = [...this.rows.values()];
    this.rows.clear();
    return out;
  }
}

function keyOf(row: CoalescedEvent): string | null {
  if (row.op === "harvest") {
    if (!row.materialId) return null;
    return "harvest|" + row.tokenId + "|" + row.materialId;
  }
  if (row.op === "lootDrop") {
    if (!/^[1-9][0-9]{0,77}$/.test(row.itemId)) return null;
    if (!/^[1-9][0-9]{0,77}$/.test(row.killId)) return null;
    if (!Number.isSafeInteger(row.batchId) || row.batchId < 0) return null;
    return "loot|" + row.tokenId + "|" + row.itemId + "|" + row.killId + "|" + String(row.batchId);
  }
  if (!row.source || !Number.isSafeInteger(row.day) || row.day < 0) return null;
  return "gold|" + row.tokenId + "|" + row.source + "|" + String(row.day);
}
