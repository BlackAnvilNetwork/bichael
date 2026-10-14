import { useState } from "react";
import type { PvpBountyClientConfig } from "@bellgrave/protocol";
import { useGame } from "./state";
import { send } from "./net";
import { placePvpBountyWithWallet } from "./pvp-place";

function pvpEscrow(): PvpBountyClientConfig | null {
  const snap = useGame.getState().snapshot;
  return snap?.you?.pvp?.escrow ?? snap?.you?.lok?.pvpBounty ?? null;
}

function pvpTokenId(): string | null {
  const tid = useGame.getState().snapshot?.you?.lok?.tokenId;
  return tid && /^[1-9][0-9]{0,77}$/.test(tid) ? tid : null;
}

/** Place on-chain when live escrow is wired, then Join with placeTxHash. */
export async function joinAshPit(areaId = "ash_pit"): Promise<void> {
  const g = useGame.getState();
  g.setPvpSlainPrompt(null);
  const marked = !!g.snapshot?.you?.pvp?.bountyOpen;
  const escrow = pvpEscrow();
  if (marked || !escrow || escrow.synthetic) {
    send({ type: "pvp/join", areaId });
    return;
  }
  const tokenId = pvpTokenId();
  if (!tokenId) {
    g.pushLog("Your character is not on the log yet.");
    return;
  }
  g.pushLog("Placing 1 xDAI head-bounty…");
  const placed = await placePvpBountyWithWallet({ escrow, tokenId });
  if (!placed.ok) {
    g.pushLog(placed.error);
    return;
  }
  send({ type: "pvp/join", areaId, placeTxHash: placed.hash });
}

/** Compact Ash Pit join / leave / rejoin controls. */
export function AshPitPanel({ onClose }: { onClose: () => void }) {
  const snapshot = useGame((s) => s.snapshot);
  const slain = useGame((s) => s.pvpSlainPrompt);
  const pvp = snapshot?.you?.pvp;
  const marked = !!pvp?.bountyOpen;
  const inPit = pvp?.areaId === "ash_pit";
  const blurb = pvp?.ashPit?.blurb ?? "1 xDAI bounty. Level 30 / support 15.";
  const cap = pvp?.levelCap ?? pvp?.ashPit?.levelCap ?? 30;
  const escrow = pvp?.escrow ?? snapshot?.you?.lok?.pvpBounty;
  const live = !!escrow && !escrow.synthetic;
  const [busy, setBusy] = useState(false);

  return (
    <div className="cmd-panel ash-pit-panel" role="dialog" aria-label="Ash Pit">
      <div className="cmd-panel-head">
        <div>
          <div className="cmd-kicker">Black Anvil PvP</div>
          <div className="cmd-panel-title">Ash Pit</div>
          <div className="cmd-panel-sub">{blurb}</div>
        </div>
        <button type="button" className="cmd-close-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="ash-pit-status">
        {marked
          ? inPit
            ? `Marked · fighting under L${cap} cap`
            : "Marked · return to the pit or Leave to reclaim"
          : slain
            ? `${slain.slayerName} took your bounty — Join again anytime`
            : live
              ? "Not marked — Join pays 1 xDAI on-chain, then enters"
              : "Not marked — Join to enter and place your bounty"}
      </p>
      <div className="ash-pit-actions">
        <button
          type="button"
          className="hud-cmd-btn selected"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void joinAshPit("ash_pit").finally(() => setBusy(false));
          }}
        >
          {busy ? "Placing…" : marked ? "Return to Pit" : "Join Ash Pit"}
        </button>
        <button
          type="button"
          className="hud-cmd-btn"
          disabled={!marked || busy}
          onClick={() => send({ type: "pvp/leave" })}
        >
          Leave
        </button>
      </div>
    </div>
  );
}

/** Banner after a bounty loss — one-click rejoin. */
export function AshPitSlainBanner() {
  const slain = useGame((s) => s.pvpSlainPrompt);
  const [busy, setBusy] = useState(false);
  if (!slain) return null;
  return (
    <div className="ash-pit-slain-banner" role="status">
      <span>
        <strong>{slain.slayerName}</strong> claimed your bounty. Rejoin for another fight?
      </span>
      <button
        type="button"
        className="hud-cmd-btn selected"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void joinAshPit(slain.areaId || "ash_pit").finally(() => setBusy(false));
        }}
      >
        {busy ? "Placing…" : "Join again"}
      </button>
      <button
        type="button"
        className="hud-cmd-btn"
        onClick={() => useGame.getState().setPvpSlainPrompt(null)}
      >
        Dismiss
      </button>
    </div>
  );
}
