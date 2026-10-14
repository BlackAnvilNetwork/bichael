import { getItem, npcSellTotalGold, npcSellUnitGold } from "@bellgrave/items";
import { ahFeeSplit, type InventorySlot, type LokItemBalance } from "@bellgrave/protocol";
import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { ItemCatalogDetails, ItemTipHost, UsedInRecipes } from "./itemTip";
import { send } from "./net";
import { settlementExampleAsk, settlementSymbol } from "./settlement-label";
import { useGame } from "./state";

type Near = { id: string; name: string };

type Cell = {
  key: string;
  tokenId: number;
  name: string;
  bagAmount: number;
  starter: boolean;
  logAmount: string | null;
};

function itemName(tokenId: number): string {
  return getItem(tokenId)?.name ?? "Item " + tokenId;
}

function cellsOf(inventory: InventorySlot[], logItems: LokItemBalance[]): Cell[] {
  const cells: Cell[] = [];
  const seenLog = new Set<number>();
  for (const row of inventory) {
    const log = logItems.find((item) => item.tokenId === row.tokenId);
    if (log && !row.starter) seenLog.add(row.tokenId);
    cells.push({
      key: "bag-" + row.tokenId + (row.starter ? "-starter" : ""),
      tokenId: row.tokenId,
      name: itemName(row.tokenId),
      bagAmount: row.amount,
      starter: !!row.starter,
      logAmount: !row.starter && log ? log.amount : null,
    });
  }
  for (const row of logItems) {
    if (seenLog.has(row.tokenId)) continue;
    cells.push({
      key: "log-" + row.tokenId,
      tokenId: row.tokenId,
      name: itemName(row.tokenId),
      bagAmount: 0,
      starter: false,
      logAmount: row.amount,
    });
  }
  cells.sort((a, b) => a.name.localeCompare(b.name) || a.tokenId - b.tokenId);
  return cells;
}

type Props = {
  inventory: InventorySlot[];
  logItems: LokItemBalance[];
  inbox: LokItemBalance[];
  others: Near[];
};

export function ProvisionerBag({ inventory, logItems, inbox, others }: Props) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [inboxKey, setInboxKey] = useState<number | null>(null);
  const [toId, setToId] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [sellQty, setSellQty] = useState("1");
  const ahEscrow = useGame((s) => s.snapshot?.you?.lok?.ahEscrow ?? null);
  const unit = settlementSymbol(ahEscrow?.currency, ahEscrow?.chainId);
  const exampleAsk = settlementExampleAsk(ahEscrow?.currency, ahEscrow?.chainId);
  const cells = cellsOf(inventory, logItems);
  const selected = others.find((unit) => unit.id === toId);
  let minPriceWei: string | null = null;
  const trimmed = minPrice.trim();
  if (trimmed) {
    try {
      const wei = parseEther(trimmed);
      if (wei > 0n) minPriceWei = wei.toString();
    } catch {
      minPriceWei = null;
    }
  }
  const priceOk = minPriceWei !== null;
  const listFeeNote = (() => {
    if (!minPriceWei) return null;
    try {
      const { feeWei, sellerNetWei } = ahFeeSplit(BigInt(minPriceWei));
      return (
        "1% marketplace fee (" +
        formatEther(feeWei) +
        " " +
        unit +
        ") — you receive " +
        formatEther(sellerNetWei) +
        " " +
        unit +
        " if this ask fills (paid to the character NFT owner)."
      );
    } catch {
      return null;
    }
  })();

  return (
    <div className="prov-hold">
      <div className="cmd-section-label">Send to</div>
      <div className="lok-row">
        {others.length === 0 && (
          <p className="lok-note">No other character is nearby. Pick someone in range. Names cannot be typed.</p>
        )}
        {selected && <span className="lok-note">Sending to {selected.name}</span>}
        {others.map((unit) => (
          <button
            key={unit.id}
            type="button"
            className={unit.id === toId ? "boot-primary" : "cmd-pill-tab"}
            onClick={() => setToId(unit.id)}
          >
            {unit.name}
          </button>
        ))}
      </div>

      <div className="cmd-section-label">Bag</div>
      {cells.length === 0 && <p className="lok-note">Bag is empty.</p>}
      <div className="prov-grid">
        {cells.map((cell) => {
          const open = openKey === cell.key;
          const qty =
            (cell.bagAmount > 0 ? "bag " + cell.bagAmount : "") +
            (cell.logAmount ? (cell.bagAmount > 0 ? " / " : "") + "log " + cell.logAmount : "");
          return (
            <div className="prov-cell-wrap" key={cell.key}>
              <ItemTipHost tokenId={cell.tokenId} active={!open}>
                <button
                  type="button"
                  className={open ? "prov-cell on" : "prov-cell"}
                  onClick={() => setOpenKey(open ? null : cell.key)}
                >
                  <span className="prov-cell-name">{cell.name}</span>
                  <span className="prov-cell-qty">
                    {qty}
                    {cell.starter ? " starter" : ""}
                  </span>
                </button>
              </ItemTipHost>
              {open && (
                <div className="prov-pop" role="menu" aria-label={cell.name}>
                  <div className="item-panel-details">
                    <ItemCatalogDetails tokenId={cell.tokenId} />
                  </div>
                  <UsedInRecipes tokenId={cell.tokenId} />
                  <button
                    type="button"
                    className="cmd-pill-tab"
                    disabled={cell.bagAmount < 1 || cell.starter}
                    title={cell.starter ? "Starter gear cannot be imported, listed, traded, or exported." : undefined}
                    onClick={() => send({ type: "lok/import", tokenId: cell.tokenId, amount: cell.bagAmount })}
                  >
                    Import
                  </button>
                  <input
                    value={minPrice}
                    placeholder={"Minimum " + unit + " (e.g. " + exampleAsk + ")"}
                    aria-label="Minimum ask"
                    onChange={(e) => setMinPrice(e.target.value)}
                  />
                  {listFeeNote && <p className="lok-note">{listFeeNote}</p>}
                  <button
                    type="button"
                    className="cmd-pill-tab"
                    disabled={!cell.logAmount || !priceOk}
                    title={
                      priceOk
                        ? "List the log stack at this minimum (1% fee on fill)."
                        : "Enter a minimum " + unit + " amount greater than 0."
                    }
                    onClick={() => {
                      if (!cell.logAmount || !minPriceWei) return;
                      // Seller payout is ownerOf(character) on fill — never client-supplied.
                      send({
                        type: "lok/list",
                        tokenId: cell.tokenId,
                        amount: Number(cell.logAmount),
                        minPrice: minPriceWei,
                      });
                    }}
                  >
                    List on Market
                  </button>
                  <button
                    type="button"
                    className="cmd-pill-tab"
                    disabled={!cell.logAmount || !toId}
                    onClick={() => {
                      if (!cell.logAmount || !toId) return;
                      send({
                        type: "lok/sendItem",
                        to: toId,
                        tokenId: cell.tokenId,
                        amount: Number(cell.logAmount),
                      });
                    }}
                  >
                    Send
                  </button>
                  <input
                    value={sellQty}
                    placeholder="Qty"
                    aria-label="Sell quantity"
                    inputMode="numeric"
                    onChange={(e) => setSellQty(e.target.value.replace(/[^0-9]/g, ""))}
                  />
                  <button
                    type="button"
                    className="cmd-pill-tab"
                    disabled={!cell.logAmount}
                    title={
                      (() => {
                        const max = Number(cell.logAmount || 0);
                        const qty = Math.min(max, Math.max(1, Number(sellQty) || 1));
                        const unit = npcSellUnitGold(cell.tokenId);
                        const total = npcSellTotalGold(cell.tokenId, qty);
                        if (unit == null || total == null) return "No NPC buyback price.";
                        return "Sell " + qty + " for " + total + " gold (" + unit + " each). Confirms before sending.";
                      })()
                    }
                    onClick={() => {
                      if (!cell.logAmount) return;
                      const max = Number(cell.logAmount);
                      const qty = Math.min(max, Math.max(1, Number(sellQty) || 1));
                      const total = npcSellTotalGold(cell.tokenId, qty);
                      if (total == null) return;
                      const ok = window.confirm(
                        "Sell " +
                          cell.name +
                          " x" +
                          qty +
                          " to the Provisioner for " +
                          total +
                          " gold? This cannot be undone.",
                      );
                      if (!ok) return;
                      send({
                        type: "lok/npcSell",
                        tokenId: cell.tokenId,
                        amount: qty,
                      });
                    }}
                  >
                    Sell for gold
                  </button>
                  <button
                    type="button"
                    className="cmd-pill-tab"
                    disabled={cell.bagAmount < 1}
                    onClick={() => send({ type: "item/discard", tokenId: cell.tokenId, starter: cell.starter })}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="cmd-pill-tab"
                    disabled={!cell.logAmount}
                    onClick={() => {
                      if (!cell.logAmount) return;
                      send({ type: "lok/export", tokenId: cell.tokenId, amount: Number(cell.logAmount) });
                    }}
                  >
                    Export
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cmd-section-label">Inbox</div>
      {inbox.length === 0 && <p className="lok-note">Nothing is waiting at the Provisioner.</p>}
      <div className="prov-grid">
        {inbox.map((row) => {
          const open = inboxKey === row.tokenId;
          return (
            <div className="prov-cell-wrap" key={"inbox-" + row.tokenId}>
              <ItemTipHost tokenId={row.tokenId} active={!open}>
                <button
                  type="button"
                  className={open ? "prov-cell on" : "prov-cell"}
                  onClick={() => setInboxKey(open ? null : row.tokenId)}
                >
                  <span className="prov-cell-name">{itemName(row.tokenId)}</span>
                  <span className="prov-cell-qty">x{row.amount}</span>
                </button>
              </ItemTipHost>
              {open && (
                <div className="prov-pop" role="menu" aria-label={"Take " + itemName(row.tokenId)}>
                  <div className="item-panel-details">
                    <ItemCatalogDetails tokenId={row.tokenId} />
                  </div>
                  <UsedInRecipes tokenId={row.tokenId} />
                  <button
                    type="button"
                    className="cmd-pill-tab"
                    onClick={() => send({ type: "lok/takeInbox", tokenId: row.tokenId, amount: Number(row.amount) })}
                  >
                    Take
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
