import { getItem } from "@bellgrave/items";
import type { SnapshotMessage } from "@bellgrave/protocol";
import { useState } from "react";
import { send } from "./net";
import { useGame } from "./state";

type Props = {
  you: SnapshotMessage["you"];
  onClose: () => void;
};

function itemName(tokenId: number): string {
  return getItem(tokenId)?.name ?? "Item " + tokenId;
}

export function LokPanel({ you, onClose }: Props) {
  const units = useGame((s) => s.snapshot?.units ?? []);
  const lok = you.lok;
  const [toId, setToId] = useState("");
  const [kek, setKek] = useState("1");
  const [minPrice, setMinPrice] = useState("");
  const [bid, setBid] = useState<Record<string, string>>({});
  const weekSec = 7 * 24 * 60 * 60;
  const others = units.filter(
    (u) => u.kind === "player" && !!u.characterId && u.characterId !== you.characterId,
  );
  const selected = others.find((u) => u.characterId === toId);

  if (!lok) {
    return (
      <div className="cmd-panel lok-panel">
        <div className="cmd-panel-head">
          <div>
            <div className="cmd-kicker">Ledger</div>
            <div className="cmd-panel-title">Exchange</div>
          </div>
          <button type="button" onClick={onClose} className="cmd-close-btn">
            Close
          </button>
        </div>
        <p>The log is not on this snapshot yet.</p>
      </div>
    );
  }

  const wait =
    lok.withdrawDelaySec == null
      ? "the vault delay"
      : lok.withdrawDelaySec % 3600 === 0
        ? lok.withdrawDelaySec / 3600 + " hours"
        : lok.withdrawDelaySec + " seconds";
  const chainNote =
    lok.chain === "engine-only"
      ? "No chain endpoint is configured. Deposit and withdraw are refused, and no in-game KEK is burned."
      : lok.chain === "watching"
        ? "Deposits move local MockKEK into the vault. A withdrawal is queued for " + wait + " and is not paid out early. Spendable KEK is debited only after the queue exists."
        : "A chain endpoint is set, but this server is not watching the vault yet. Withdraw does not burn in-game KEK.";

  return (
    <div className="cmd-panel lok-panel">
      <div className="cmd-panel-head">
        <div>
          <div className="cmd-kicker">Provisioner</div>
          <div className="cmd-panel-title">Exchange</div>
          <div className="cmd-panel-sub">Log custody · no fee · KEK {lok.kek}</div>
        </div>
        <button type="button" onClick={onClose} className="cmd-close-btn">
          Close
        </button>
      </div>
      <p className="lok-note">{chainNote}</p>

      <div className="cmd-section-label">Send to</div>
      <div className="lok-row">
        {others.length === 0 && (
          <p className="lok-note">No other character is nearby. Pick someone in range. Names cannot be typed.</p>
        )}
        {selected && <span className="lok-note">Sending to {selected.name}</span>}
        {others.map((u) => (
          <button
            key={u.characterId}
            type="button"
            className={u.characterId === toId ? "boot-primary" : "cmd-pill-tab"}
            onClick={() => setToId(u.characterId ?? "")}
          >
            {u.name}
          </button>
        ))}
      </div>
      <div className="lok-row">
        <input value={kek} onChange={(e) => setKek(e.target.value)} />
        <button
          type="button"
          className="boot-primary"
          disabled={!toId}
          onClick={() => toId && send({ type: "lok/sendKek", to: toId, amount: kek })}
        >
          Send KEK
        </button>
        <button
          type="button"
          className="boot-primary"
          onClick={() => send({ type: "lok/deposit", amount: kek })}
        >
          Deposit KEK
        </button>
        <button
          type="button"
          className="cmd-pill-tab"
          onClick={() => send({ type: "lok/withdrawKek", amount: kek })}
        >
          Queue withdrawal
        </button>
      </div>
      <div className="cmd-section-label">Vault queue ? {wait}</div>
      {lok.queues.length === 0 && <p className="lok-note">No withdrawal is queued.</p>}
      {lok.queues.map((row) => (
        <div className="lok-row" key={row.id}>
          <span>
            #{row.id} {row.amount} KEK ? claimable {new Date(row.availableAt * 1000).toLocaleString()}
          </span>
          <button type="button" className="cmd-pill-tab" onClick={() => send({ type: "lok/claimKek", id: row.id })}>
            Claim
          </button>
        </div>
      ))}

            <div className="cmd-section-label">Bag ? import</div>
      {you.inventory.length === 0 && <p className="lok-note">Bag is empty.</p>}
      {you.inventory.map((row) => (
        <div className="lok-row" key={"bag-" + row.tokenId + (row.starter ? "-starter" : "")}>
          <span>
            {itemName(row.tokenId)} x{row.amount}
            {row.starter ? " (starter)" : ""}
          </span>
          <button
            type="button"
            className="cmd-pill-tab"
            disabled={!!row.starter}
            title={row.starter ? "Starter gear cannot be imported, listed, traded, or exported." : undefined}
            onClick={() => send({ type: "lok/import", tokenId: row.tokenId, amount: row.amount })}
          >
            Import
          </button>
          <button
            type="button"
            className="cmd-pill-tab"
            onClick={() => send({ type: "item/discard", tokenId: row.tokenId, starter: !!row.starter })}
          >
            Discard
          </button>
        </div>
      ))}

      <div className="lok-row">
        <input value={minPrice} placeholder="Minimum KEK" onChange={(e) => setMinPrice(e.target.value)} />
        <span className="lok-note">Minimum price for the next list. A bid buys the cheapest ask and pays what was bid.</span>
      </div>
      <div className="cmd-section-label">Log · send, list, export</div>
      {lok.items.length === 0 && <p className="lok-note">Nothing spendable on the log.</p>}
      {lok.items.map((row) => (
        <div className="lok-row" key={"log-" + row.tokenId}>
          <span>
            {itemName(row.tokenId)} x{row.amount}
          </span>
          <button
            type="button"
            className="cmd-pill-tab"
            disabled={!toId}
            onClick={() =>
              toId && send({ type: "lok/sendItem", to: toId, tokenId: row.tokenId, amount: Number(row.amount) })
            }
          >
            Send
          </button>
          <button
            type="button"
            className="cmd-pill-tab"
            onClick={() =>
              send({ type: "lok/list", tokenId: row.tokenId, amount: Number(row.amount), minPrice })
            }
          >
            List
          </button>
          <button
            type="button"
            className="cmd-pill-tab"
            onClick={() => send({ type: "lok/export", tokenId: row.tokenId, amount: Number(row.amount) })}
          >
            Export
          </button>
        </div>
      ))}

      <div className="cmd-section-label">Inbox</div>
      {(lok.inbox ?? []).length === 0 && <p className="lok-note">Nothing is waiting at the Provisioner.</p>}
      {(lok.inbox ?? []).map((row) => (
        <div className="lok-row" key={"inbox-" + row.tokenId}>
          <span>
            {itemName(row.tokenId)} x{row.amount}
          </span>
          <button
            type="button"
            className="cmd-pill-tab"
            onClick={() => send({ type: "lok/takeInbox", tokenId: row.tokenId, amount: Number(row.amount) })}
          >
            Take
          </button>
        </div>
      ))}

      <div className="cmd-section-label">Auction</div>
      {lok.listings.length === 0 && <p className="lok-note">No listings.</p>}
      {lok.listings.map((row) => (
        <div className="lok-row" key={row.id}>
          <span>
            #{row.id} {itemName(row.itemId)} x{row.amount}{row.book ? " min " + row.minPrice : ""} · {row.sellerName} · bid {row.highBid}
            {row.highBidderName ? " by " + row.highBidderName : ""}
          </span>
          <input
            value={bid[row.id] ?? ""}
            placeholder="KEK"
            onChange={(e) => setBid({ ...bid, [row.id]: e.target.value })}
          />
          <button
            type="button"
            className="cmd-pill-tab"
            onClick={() => send({ type: "lok/bid", itemId: row.itemId, amount: bid[row.id] ?? "" })}
          >
            {row.book ? "Buy lowest" : "Bid"}
          </button>
          {row.yours && (
            <button type="button" className="cmd-pill-tab" onClick={() => send({ type: "lok/cancel", listingId: row.id })}>
              Cancel
            </button>
          )}
          {row.book && row.yours && row.listedAt > 0 && Date.now() / 1000 >= row.listedAt + weekSec && (
            <button type="button" className="cmd-pill-tab" onClick={() => send({ type: "lok/reclaim", listingId: row.id })}>
              Reclaim
            </button>
          )}
          {!row.book && row.highBidder && (
            <button type="button" className="cmd-pill-tab" onClick={() => send({ type: "lok/settle", listingId: row.id })}>
              Settle
            </button>
          )}
        </div>
      ))}
    </div>
  );
}