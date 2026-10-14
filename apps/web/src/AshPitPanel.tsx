import { useGame } from "./state";
import { send } from "./net";

/** Compact Ash Pit join / leave / rejoin controls. */
export function AshPitPanel({ onClose }: { onClose: () => void }) {
  const snapshot = useGame((s) => s.snapshot);
  const slain = useGame((s) => s.pvpSlainPrompt);
  const pvp = snapshot?.you?.pvp;
  const marked = !!pvp?.bountyOpen;
  const inPit = pvp?.areaId === "ash_pit";
  const blurb = pvp?.ashPit?.blurb ?? "1 xDAI bounty. Level 30 / support 15.";
  const cap = pvp?.levelCap ?? pvp?.ashPit?.levelCap ?? 30;

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
            : "Not marked — Join to enter and place your bounty"}
      </p>
      <div className="ash-pit-actions">
        <button
          type="button"
          className="hud-cmd-btn selected"
          onClick={() => {
            send({ type: "pvp/join", areaId: "ash_pit" });
            useGame.getState().setPvpSlainPrompt(null);
          }}
        >
          {marked ? "Return to Pit" : "Join Ash Pit"}
        </button>
        <button
          type="button"
          className="hud-cmd-btn"
          disabled={!marked}
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
  if (!slain) return null;
  return (
    <div className="ash-pit-slain-banner" role="status">
      <span>
        <strong>{slain.slayerName}</strong> claimed your bounty. Rejoin for another fight?
      </span>
      <button
        type="button"
        className="hud-cmd-btn selected"
        onClick={() => {
          send({ type: "pvp/join", areaId: slain.areaId || "ash_pit" });
          useGame.getState().setPvpSlainPrompt(null);
        }}
      >
        Join again
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
