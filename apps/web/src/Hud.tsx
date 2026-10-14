import {
  JOBS,
  JOB_IDS,
  SUBJOB_UNLOCK_LEVEL,
  abilityCategory,
  abilityIconUrl,
  abilityLabel,
  abilityMp,
  abilityNeedsTarget,
  abilityRecastMs,
  abilityTooltip,
  categoryTabsDual,
  isAbilityId,
  isJobId,
  isTimAbilityId,
  type AbilityId as CombatAbilityId,
  type JobId,
} from "@bellgrave/combat";
import { clearPendingMint, mintCharacterWithWallet } from "./character-mint";
import { ITEM, normalizeCharacterName, characterNameKey, explorerTxUrl } from "@bellgrave/config";
import { getItem } from "@bellgrave/items";
import type { AbilityId, UnitSnapshot } from "@bellgrave/protocol";
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { AbilityIcon } from "./AbilityIcon";
import { chromaKeyIconUrl } from "./chroma";
import { CraftingPanel } from "./CraftingPanel";
import { ExplorerPanel } from "./ExplorerPanel";
import { LokPanel } from "./LokPanel";
import { PartyPanel } from "./PartyPanel";
import { EquipPanel } from "./EquipPanel";
import { SkillTreePanel } from "./SkillTreePanel";
import {
  UI_COLOR_OPTIONS,
  UI_FONT_OPTIONS,
  UI_FONT_STACKS,
  UI_LAYOUT_OPTIONS,
  UI_SETTINGS_KEY,
  layoutUsesArcadeControls,
  loadUiSettings,
  persistAndApplyUiSettings,
  type UiColorId,
  type UiFontId,
  type UiLayoutId,
  type UiSettings,
} from "./uiSettings";
import { MobileArcadeControls } from "./MobileArcadeControls";
import { AshPitPanel, AshPitSlainBanner } from "./AshPitPanel";
import { clearVirtualStick } from "./moveInput";
import {
  HOTBAR_DRAG_MIME,
  HOTBAR_ROW_LEN,
  HOTBAR_SLOT_COUNT,
  HOTBAR_SLOT_MIME,
  assignHotbarSlot,
  clearHotbarSlot,
  loadHotbar,
  saveHotbar,
  swapHotbarSlots,
  type HotbarSlots,
} from "./hotbar";
import { useAppKit, useAppKitAccount, useAppKitState } from "@reown/appkit/react";
import { appKitConfigured } from "./appkit-config";
import {
  checkCharacterNameAvailable,
  isServerAuthed,
  loginWithWalletConnect,
  logoutToMenu,
  send,
  walletConnectLoginAvailable,
} from "./net";
import { stopZoneMusic } from "./zoneMusic";
import { useGame } from "./state";
// NpcInteractMenu mounts world-anchored under the NPC in WorldScene.

const HOTBAR_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;
const HOTBAR_SHIFT_KEYS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S0"] as const;

/** Live slots for keybinds (updated by Hud). */
let liveHotbarSlots: HotbarSlots = Array.from({ length: HOTBAR_SLOT_COUNT }, () => null);

/** Map Digit* key codes → hotbar index (0–9), works with Shift held. */
export function hotbarIndexFromCode(code: string): number | null {
  const m = /^Digit([0-9])$/.exec(code);
  if (!m) return null;
  const d = m[1]!;
  return d === "0" ? 9 : Number(d) - 1;
}

function abilityTargetId(id: AbilityId, selected: string | null): string | undefined {
  if (!isAbilityId(id)) return undefined;
  if (abilityNeedsTarget(id)) return selected ?? "mob-guard-1";
  return undefined;
}

function hudAbilityTip(id: CombatAbilityId): { title: string; body: string; meta: string } {
  const raw = abilityTooltip(id);
  if (typeof raw === "object" && raw !== null && "title" in raw) {
    return raw;
  }
  const label = abilityLabel(id);
  const metaBits: string[] = [];
  const mp = abilityMp(id);
  const recast = abilityRecastMs(id);
  if (mp > 0) metaBits.push(`MP ${mp}`);
  if (recast > 0) {
    const s = recast / 1000;
    metaBits.push(s >= 60 ? `Recast ${Math.round(s / 60)}m` : `Recast ${s}s`);
  }
  const body = typeof raw === "string" ? raw : label;
  return { title: label, body, meta: metaBits.join(" · ") };
}

function abilityBuffActive(id: CombatAbilityId, me: UnitSnapshot, now: number): boolean {
  const b = me.buffs;
  if (id === "flux") return b.flux;
  if (id === "aether") return b.aether;
  if (id === "rest") return me.anim === "rest";
  if (id === "bulwark") return b.bulwarkUntil > now;
  if (id === "sentinel") return b.sentinelUntil > now;
  if (id === "cover") return b.coverUntil > now;
  if (id === "fealty") return b.fealtyUntil > now;
  if (id === "rampart") return b.rampartUntil > now;
  if (id === "guardian") return b.guardianUntil > now;
  if (id.startsWith("kn_protect")) return b.protectUntil > now;
  if (id.startsWith("kn_shell")) return b.shellUntil > now;
  if (id === "ghost_step") return b.ghostStepUntil > now;
  if (id === "backblade") return b.backbladeUntil > now;
  if (id === "kill_edge") return b.killEdgeUntil > now;
  if (id === "shadow_pass") return b.shadowPassUntil > now;
  if (id === "dust_runner") return b.moveUntil > now && b.movePct >= 0.5;
  if (id === "solace_rite") return b.solaceRite;
  if (id === "misery_rite") return b.miseryRite;
  if (id === "divine_seal") return b.divineSealReady;
  if (id === "asylum") return b.asylumUntil > now;
  if (
    id === "cl_cure" ||
    id === "cl_cure_ii" ||
    id === "cl_cure_iii" ||
    id === "cl_cure_iv" ||
    id === "cl_cure_v" ||
    id === "cl_curaga" ||
    id === "cl_curaga_ii" ||
    id === "cl_curaga_iii"
  ) {
    return b.healAbsorbUntil > now;
  }
  if (id === "cl_regen" || id === "cl_regen_ii" || id === "cl_regen_iii") {
    return b.regenUntil > now;
  }
  if (id === "killing_storm") return b.killingStormUntil > now;
  if (id === "berserk") return b.berserkUntil > now;
  if (id === "warcry") return b.warcryUntil > now;
  if (id === "defender") return b.defenderUntil > now;
  if (id === "aggressor") return b.aggressorUntil > now;
  if (id === "restraint") return b.restraintUntil > now;
  if (id === "blood_rage") return b.bloodRageUntil > now;
  if (id === "brazen_rush") return b.brazenRushUntil > now;
  if (id === "arcane_flood") return b.arcaneFloodUntil > now;
  if (id === "elemental_seal") return b.elementalSealUntil > now;
  if (id === "mana_wall") return b.manaWallUntil > now;
  if (id === "manawell") return b.manawellReady;
  if (id === "cascade") return b.cascadeUntil > now;
  if (id === "focal_neve") return b.focalNeveUntil > now;
  if (id === "spellblade") return b.spellbladeUntil > now;
  if (id === "focus_weave") return b.focusWeave;
  if (id === "bm_flame_edge" || id === "bm_frost_edge" || id === "bm_thunder_edge") {
    return b.enSpellUntil > now;
  }
  if (id.startsWith("bm_protect") || id === "bm_protect") return b.protectUntil > now;
  if (id.startsWith("bm_shell") || id === "bm_shell") return b.shellUntil > now;
  if (id === "bm_phalanx") return b.phalanxUntil > now;
  if (id === "bm_stoneskin") return b.stoneskinUntil > now;
  if (id === "bm_refresh" || id === "bm_refresh_ii" || id === "bm_refreshga") {
    return b.refreshUntil > now;
  }
  if (id === "bm_haste") return b.hasteUntil > now;
  if (
    id === "quicken" ||
    id === "quicken_ii" ||
    id === "tempo" ||
    id === "tempo_ii" ||
    id === "allegro" ||
    id === "allegro_ii" ||
    id === "haste" ||
    id === "hastega" ||
    id === "overclock"
  ) {
    return b.hasteUntil > now;
  }
  return false;
}

function jobHasHotbar(job: JobId): boolean {
  return JOBS[job]?.playable === true;
}

/** Every playable job gets the ability book + hotbar drag UX (same as TIM). */
function jobHasSpellbook(job: JobId): boolean {
  return JOBS[job]?.playable === true;
}

function dualHasSpellbook(main: JobId, sub: JobId | null | undefined): boolean {
  return jobHasSpellbook(main) || (sub != null && jobHasSpellbook(sub));
}

function castAbility(id: AbilityId) {
  const selected = useGame.getState().selectedTarget;
  send({ type: "ability", id, targetId: abilityTargetId(id, selected) });
}

function logClass(line: string): string {
  const l = line.toLowerCase();
  if (
    l.includes("flux") ||
    l.includes("aether") ||
    l.includes("quicken") ||
    l.includes("tempo") ||
    l.includes("allegro") ||
    l.includes("haste") ||
    l.includes("slow") ||
    l.includes("gravity") ||
    l.includes("cure") ||
    l.includes("rest") ||
    l.includes("metronome") ||
    l.includes("seal") ||
    l.includes("distortion") ||
    l.includes("petrif") ||
    l.includes("earth + time") ||
    l.includes("bulwark") ||
    l.includes("provoke") ||
    l.includes("flash") ||
    l.includes("sentinel") ||
    l.includes("rampart") ||
    l.includes("banish") ||
    l.includes("holy") ||
    l.includes("shield bash")
  ) {
    return "hud-log-line magic";
  }
  if (l.includes("hit") || l.includes("engaged") || l.includes("defeated") || l.includes("critical")) {
    return "hud-log-line combat";
  }
  if (
    l.includes("level up") ||
    l.includes("restored") ||
    l.includes("claimed") ||
    l.includes("welcome") ||
    l.includes("job changed") ||
    l.includes("+")
  ) {
    return "hud-log-line good";
  }
  if (l.includes("error") || l.includes("not enough") || l.includes("fall") || l.includes("hits you")) {
    return "hud-log-line bad";
  }
  return "hud-log-line system";
}

function SkillButton({
  id,
  keyLabel,
  now,
  recasts,
  me,
  tipPlacement = "above",
  draggable = true,
  hotbarIndex,
  onHotbarDrop,
}: {
  id: CombatAbilityId;
  keyLabel?: string;
  now: number;
  recasts: Partial<Record<AbilityId, number>>;
  me: UnitSnapshot;
  tipPlacement?: "above" | "left";
  /** Spellbook / hotbar drag source. */
  draggable?: boolean;
  /** When set, this button is a hotbar slot (drop target + optional rearrange). */
  hotbarIndex?: number;
  onHotbarDrop?: (slotIndex: number, abilityId: CombatAbilityId | null, fromSlot: number | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tip = hudAbilityTip(id);
  const until = recasts[id] ?? 0;
  const cdLeftMs = Math.max(0, until - now);
  const onCd = cdLeftMs > 0;
  const cdSec = Math.ceil(cdLeftMs / 1000);
  const totalMs = abilityRecastMs(id);
  const cdPct = onCd && totalMs > 0 ? Math.min(1, cdLeftMs / totalMs) : 0;
  const fluxOn = id === "flux" && me.buffs.flux;
  const aetherOn = id === "aether" && me.buffs.aether;
  const restOn = id === "rest" && me.anim === "rest";
  const hasteOn = abilityBuffActive(id, me, now) && isTimAbilityId(id) && id !== "flux" && id !== "aether";
  const knightBuffOn = abilityBuffActive(id, me, now) && !isTimAbilityId(id);
  const active = fluxOn || aetherOn || restOn || hasteOn || knightBuffOn;

  const onDragStart = (e: DragEvent) => {
    if (!draggable) return;
    e.dataTransfer.setData(HOTBAR_DRAG_MIME, id);
    e.dataTransfer.effectAllowed = hotbarIndex != null ? "move" : "copy";
    if (hotbarIndex != null) {
      e.dataTransfer.setData(HOTBAR_SLOT_MIME, String(hotbarIndex));
    }
  };

  const onDragOver = (e: DragEvent) => {
    if (hotbarIndex == null || !onHotbarDrop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(HOTBAR_SLOT_MIME) ? "move" : "copy";
  };

  const onDrop = (e: DragEvent) => {
    if (hotbarIndex == null || !onHotbarDrop) return;
    e.preventDefault();
    e.stopPropagation();
    const fromRaw = e.dataTransfer.getData(HOTBAR_SLOT_MIME);
    const fromSlot = fromRaw !== "" ? Number(fromRaw) : null;
    const ability = e.dataTransfer.getData(HOTBAR_DRAG_MIME);
    if (fromSlot != null && !Number.isNaN(fromSlot)) {
      onHotbarDrop(hotbarIndex, null, fromSlot);
      return;
    }
    if (isAbilityId(ability)) onHotbarDrop(hotbarIndex, ability, null);
  };

  const dismissTip = () => {
    wrapRef.current?.classList.add("tip-dismissed");
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) ae.blur();
  };
  const clearTipDismiss = () => {
    wrapRef.current?.classList.remove("tip-dismissed");
  };

  return (
    <div
      ref={wrapRef}
      className={`skill-wrap tip-${tipPlacement}`}
      onPointerLeave={clearTipDismiss}
      onPointerEnter={clearTipDismiss}
    >
      <button
        type="button"
        draggable={draggable && id !== "rest"}
        className={[
          "skill-slot",
          active ? "active" : "",
          fluxOn ? "flux-on" : "",
          aetherOn ? "aether-on" : "",
          hasteOn ? "quicken-on" : "",
          onCd ? "on-cd" : "",
          hotbarIndex != null ? "hotbar-slot" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={`${tip.title}. ${tip.body}${hotbarIndex != null ? " Drag to rearrange." : ""}`}
        onClick={() => {
          castAbility(id);
          dismissTip();
        }}
        onContextMenu={
          hotbarIndex != null && onHotbarDrop
            ? (e) => {
                e.preventDefault();
                onHotbarDrop(hotbarIndex, null, -1); // -1 = clear
                dismissTip();
              }
            : undefined
        }
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {keyLabel != null && <span className="skill-key">{keyLabel}</span>}
        <AbilityIcon id={id} />
        <span className="skill-name">{abilityLabel(id)}</span>
        {onCd && (
          <span className="skill-cd" style={{ ["--cd" as string]: String(cdPct) }} aria-label={`${cdSec}s cooldown`}>
            <span className="skill-cd-veil" />
            <span className="skill-cd-num">{cdSec}</span>
          </span>
        )}
      </button>
      <div className="skill-tip" role="tooltip">
        <div className="skill-tip-title">{tip.title}</div>
        <div className="skill-tip-body">{tip.body}</div>
        <div className="skill-tip-meta">{tip.meta}</div>
        {hotbarIndex != null && (
          <div className="skill-tip-meta" style={{ marginTop: 4 }}>
            Drag to move · Right-click to clear
          </div>
        )}
        {onCd && <div className="skill-tip-cd">Ready in {cdSec}s</div>}
      </div>
    </div>
  );
}

/** Build a floating skill-slot element used as the HTML5 drag image. */
function makeSkillDragGhost(id: CombatAbilityId): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "skill-slot skill-drag-ghost";
  const img = document.createElement("img");
  img.className = "skill-icon";
  img.src = abilityIconUrl(id);
  img.alt = "";
  img.draggable = false;
  void chromaKeyIconUrl(abilityIconUrl(id)).then((url) => {
    img.src = url;
  });
  const name = document.createElement("span");
  name.className = "skill-name";
  name.textContent = abilityLabel(id);
  ghost.appendChild(img);
  ghost.appendChild(name);
  ghost.style.position = "absolute";
  ghost.style.top = "-1000px";
  ghost.style.left = "-1000px";
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "9999";
  document.body.appendChild(ghost);
  return ghost;
}

/** Spellbook list row — list in the book; drag preview is a hotbar-style button. */
function SpellbookRow({
  id,
  now,
  recasts,
  me,
}: {
  id: CombatAbilityId;
  now: number;
  recasts: Partial<Record<AbilityId, number>>;
  me: UnitSnapshot;
}) {
  const tip = hudAbilityTip(id);
  const until = recasts[id] ?? 0;
  const cdLeftMs = Math.max(0, until - now);
  const onCd = cdLeftMs > 0;
  const cdSec = Math.ceil(cdLeftMs / 1000);
  const fluxOn = id === "flux" && me.buffs.flux;
  const aetherOn = id === "aether" && me.buffs.aether;
  const restOn = id === "rest" && me.anim === "rest";
  const hasteOn = abilityBuffActive(id, me, now) && isTimAbilityId(id) && id !== "flux" && id !== "aether";
  const knightBuffOn = abilityBuffActive(id, me, now) && !isTimAbilityId(id);
  const active = fluxOn || aetherOn || restOn || hasteOn || knightBuffOn;
  const ghostRef = useRef<HTMLElement | null>(null);

  const onDragStart = (e: DragEvent) => {
    if (id === "rest") {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(HOTBAR_DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "copy";
    const ghost = makeSkillDragGhost(id);
    ghostRef.current = ghost;
    e.dataTransfer.setDragImage(ghost, 34, 34);
  };

  const onDragEnd = () => {
    ghostRef.current?.remove();
    ghostRef.current = null;
  };

  return (
    <button
      type="button"
      draggable={id !== "rest"}
      className={[
        "spellbook-row",
        active ? "active" : "",
        fluxOn ? "flux-on" : "",
        aetherOn ? "aether-on" : "",
        onCd ? "on-cd" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={`${tip.title}. ${tip.body}. Drag onto hotbar.`}
      title={`${tip.body}\n${tip.meta}`}
      onClick={() => castAbility(id)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="spellbook-row-glyph">
        <AbilityIcon id={id} />
      </span>
      <span className="spellbook-row-main">
        <span className="spellbook-row-name">{abilityLabel(id)}</span>
        <span className="spellbook-row-blurb">{tip.body}</span>
      </span>
      <span className="spellbook-row-meta">
        {onCd ? <span className="spellbook-row-cd">{cdSec}s</span> : null}
        <span className="spellbook-row-stats">{tip.meta}</span>
      </span>
    </button>
  );
}

function EmptyHotbarSlot({
  keyLabel,
  slotIndex,
  onHotbarDrop,
}: {
  keyLabel: string;
  slotIndex: number;
  onHotbarDrop: (slotIndex: number, abilityId: CombatAbilityId | null, fromSlot: number | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dismissTip = () => {
    wrapRef.current?.classList.add("tip-dismissed");
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) ae.blur();
  };
  const clearTipDismiss = () => {
    wrapRef.current?.classList.remove("tip-dismissed");
  };

  return (
    <div
      ref={wrapRef}
      className="skill-wrap tip-above"
      onPointerLeave={clearTipDismiss}
      onPointerEnter={clearTipDismiss}
    >
      <button
        type="button"
        className="skill-slot hotbar-slot empty"
        aria-label={`Empty hotbar slot ${keyLabel}. Drop an ability here.`}
        onClick={dismissTip}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes(HOTBAR_SLOT_MIME) ? "move" : "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const fromRaw = e.dataTransfer.getData(HOTBAR_SLOT_MIME);
          const fromSlot = fromRaw !== "" ? Number(fromRaw) : null;
          const ability = e.dataTransfer.getData(HOTBAR_DRAG_MIME);
          if (fromSlot != null && !Number.isNaN(fromSlot)) {
            onHotbarDrop(slotIndex, null, fromSlot);
            dismissTip();
            return;
          }
          if (isAbilityId(ability)) onHotbarDrop(slotIndex, ability, null);
          dismissTip();
        }}
      >
        <span className="skill-key">{keyLabel}</span>
        <span className="skill-glyph empty-glyph">·</span>
      </button>
      <div className="skill-tip" role="tooltip">
        <div className="skill-tip-title">Empty slot</div>
        <div className="skill-tip-body">Drag an ability from the spellbook (or another hotbar slot) onto here.</div>
        <div className="skill-tip-meta">Key {keyLabel}</div>
      </div>
    </div>
  );
}

export function Hud() {
  const snapshot = useGame((s) => s.snapshot);
  const logs = useGame((s) => s.logs);
  const connected = useGame((s) => s.connected);
  const phase = useGame((s) => s.phase);
  const wallet = useGame((s) => s.wallet);
  const selectedTarget = useGame((s) => s.selectedTarget);
  const npcDialog = useGame((s) => s.npcDialog);
  /** Prefer id lookup — avoid `s.me()` in selector (new call every select). */
  const me = useGame((s) => {
    const w = s.wallet;
    const snap = s.snapshot;
    if (!w || !snap) return null;
    return snap.units.find((u) => u.id.toLowerCase() === w.toLowerCase() && u.kind === "player") ?? null;
  });
  const [bagOpen, setBagOpen] = useState(false);
  const [craftOpen, setCraftOpen] = useState(false);
  const [lokOpen, setLokOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [partyOpen, setPartyOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [ashPitOpen, setAshPitOpen] = useState(false);
  const [uiSettings, setUiSettings] = useState<UiSettings>(() => loadUiSettings());
  const [menuFocus, setMenuFocus] = useState<string>("character");
  const [bookTab, setBookTab] = useState<string>("time");
  const [now, setNow] = useState(() => Date.now());
  const [hotbarSlots, setHotbarSlots] = useState<HotbarSlots>(() =>
    Array.from({ length: HOTBAR_SLOT_COUNT }, () => null),
  );
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onToggle = () => setBagOpen((v) => !v);
    const onBook = () => setBookOpen((v) => !v);
    const onCraft = () => setCraftOpen((v) => !v);
    const onLok = () => setLokOpen((v) => !v);
    window.addEventListener("bellgrave:toggle-bag", onToggle);
    window.addEventListener("bellgrave:toggle-spellbook", onBook);
    window.addEventListener("bellgrave:toggle-craft", onCraft);
    window.addEventListener("bellgrave:toggle-lok", onLok);
    return () => {
      window.removeEventListener("bellgrave:toggle-bag", onToggle);
      window.removeEventListener("bellgrave:toggle-spellbook", onBook);
      window.removeEventListener("bellgrave:toggle-craft", onCraft);
      window.removeEventListener("bellgrave:toggle-lok", onLok);
    };
  }, []);

  useEffect(() => {
    if (npcDialog?.craftOpen) setCraftOpen(true);
  }, [npcDialog?.craftOpen, npcDialog?.npcId]);

  useEffect(() => {
    if (npcDialog?.lokOpen) setLokOpen(true);
  }, [npcDialog?.lokOpen, npcDialog?.npcId]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (phase !== "play") return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (!layoutUsesArcadeControls(uiSettings.layout)) clearVirtualStick();
  }, [uiSettings.layout]);

  // Re-sync from localStorage when entering play / when another tab changes settings.
  // Keeps Mobile sticks visible after remounts and across refresh.
  useEffect(() => {
    if (phase !== "play") return;
    setUiSettings(loadUiSettings());
    const onStorage = (e: StorageEvent) => {
      if (e.key === UI_SETTINGS_KEY || e.key === null) setUiSettings(loadUiSettings());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [phase]);

  const bookIds = useMemo(() => {
    if (!snapshot || !dualHasSpellbook(snapshot.you.job, snapshot.you.subjob)) {
      return [] as CombatAbilityId[];
    }
    return (snapshot.you.unlocked as CombatAbilityId[]).filter((id) => isAbilityId(id));
  }, [snapshot]);

  // Load / refresh custom hotbar when wallet, job, subjob, or unlock set changes.
  // Do NOT depend on full `snapshot` — it changes every WS tick and would thrash setState.
  const unlockKey = bookIds.join(",");
  const jobKey = snapshot?.you.job ?? "";
  const subKey = snapshot?.you.subjob ?? "";
  useEffect(() => {
    if (!jobKey || !jobHasHotbar(jobKey)) {
      setHotbarSlots((prev) => {
        if (prev.every((s) => s == null)) return prev;
        const empty = Array.from({ length: HOTBAR_SLOT_COUNT }, () => null) as HotbarSlots;
        liveHotbarSlots = empty;
        return empty;
      });
      return;
    }
    const snap = useGame.getState().snapshot;
    if (!snap) return;
    const unlocked = snap.you.unlocked as CombatAbilityId[];
    const sub = snap.you.subjob && isJobId(snap.you.subjob) ? snap.you.subjob : null;
    const next = loadHotbar(wallet, snap.you.job, unlocked, sub);
    setHotbarSlots((prev) => {
      if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
      liveHotbarSlots = next;
      return next;
    });
  }, [wallet, jobKey, unlockKey, subKey]);

  useEffect(() => {
    liveHotbarSlots = hotbarSlots;
  }, [hotbarSlots]);

  const handleHotbarDrop = (
    slotIndex: number,
    abilityId: CombatAbilityId | null,
    fromSlot: number | null,
  ) => {
    if (!snapshot || !jobHasHotbar(snapshot.you.job)) return;
    const sub =
      snapshot.you.subjob && isJobId(snapshot.you.subjob) ? snapshot.you.subjob : null;
    setHotbarSlots((prev) => {
      let next: HotbarSlots;
      if (fromSlot === -1) {
        next = clearHotbarSlot(prev, slotIndex);
      } else if (fromSlot != null) {
        next = swapHotbarSlots(prev, fromSlot, slotIndex);
      } else if (abilityId) {
        next = assignHotbarSlot(prev, slotIndex, abilityId);
      } else {
        return prev;
      }
      saveHotbar(wallet, snapshot.you.job, next, sub);
      liveHotbarSlots = next;
      return next;
    });
  };

  const hotbarRow1 = hotbarSlots.slice(0, HOTBAR_ROW_LEN);
  const hotbarRow2 = hotbarSlots.slice(HOTBAR_ROW_LEN, HOTBAR_SLOT_COUNT);
  const restUnlocked = (snapshot?.you.unlocked ?? []).includes("rest");

  const bookByCategory = useMemo(() => {
    const map = new Map<string, CombatAbilityId[]>();
    for (const id of bookIds) {
      const cat = abilityCategory(id);
      const list = map.get(cat);
      if (list) list.push(id);
      else map.set(cat, [id]);
    }
    return map;
  }, [bookIds]);

  const bookTabs = useMemo(() => {
    if (!snapshot) return [];
    const sub =
      snapshot.you.subjob && isJobId(snapshot.you.subjob) ? snapshot.you.subjob : null;
    const tabs = categoryTabsDual(snapshot.you.job, sub);
    return tabs.filter((t) => (bookByCategory.get(t.id)?.length ?? 0) > 0);
  }, [bookByCategory, snapshot]);

  const activeBookTab =
    bookTabs.find((t) => t.id === bookTab)?.id ?? bookTabs[0]?.id ?? "time";
  const tabIds = bookByCategory.get(activeBookTab) ?? [];

  if (phase !== "play" || !snapshot || !me) return null;
  const you = snapshot.you;
  const potions = you.inventory.reduce((n, i) => n + (i.tokenId === ITEM.POTION ? i.amount : 0), 0);
  const shortWallet = wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "";
  const hpPct = (me.hp / me.maxHp) * 100;
  const mpPct = me.maxMp ? (me.mp / me.maxMp) * 100 : 0;
  const tpPct = Math.min(100, (me.tp / 3000) * 100);
  const recasts = you.recasts ?? {};
  const jobName = JOBS[you.job]?.name ?? you.job;
  const subName =
    you.subjob && you.subLevel > 0
      ? ` / ${JOBS[you.subjob]?.name ?? you.subjob} L${you.subLevel}`
      : "";

  const posX = me.x.toFixed(1);
  const posY = me.y.toFixed(1);
  const posZ = me.z.toFixed(1);

  const mobileLayout = layoutUsesArcadeControls(uiSettings.layout);

  return (
    <div
      className={`hud-root${mobileLayout ? " hud-layout-mobile" : ""}`}
      data-ui-layout={uiSettings.layout}
    >
      <div className="hud-chrome">
        <div className="hud-corner-left">
          <div className="hud-vitals-dock">
          <div className="hud-identity">
            {you.name} · Lv.{you.level} · <span className="job">{jobName}{subName}</span>
            {!connected && <span className="offline"> · OFFLINE</span>}
            <span className="wallet">{shortWallet}</span>
          </div>
          <div className="hud-vitals">
            <div className="vital">
              <span className="vital-label">HP</span>
              <div className="vital-bar hp">
                <i style={{ width: `${hpPct}%` }} />
              </div>
              <span className="vital-num">
                {me.hp}/{me.maxHp}
              </span>
            </div>
            <div className="vital">
              <span className="vital-label">MP</span>
              <div className="vital-bar mp">
                <i style={{ width: `${mpPct}%` }} />
              </div>
              <span className="vital-num">
                {me.mp}/{me.maxMp}
              </span>
            </div>
            <div className="vital">
              <span className="vital-label">TP</span>
              <div className="vital-bar tp">
                <i style={{ width: `${tpPct}%` }} />
              </div>
              <span className="vital-num">{me.tp}</span>
            </div>
          </div>
          </div>
          <div className="hud-pos" aria-label={`World position X ${posX}, Y ${posY}, Z ${posZ}`}>
            X {posX}&nbsp;&nbsp;Y {posY}&nbsp;&nbsp;Z {posZ}
          </div>
        </div>

        <div className="hud-menu-dock" role="menu" aria-label="Commands">
          <div className="hud-commands-kicker">Black Anvil</div>
          <div className="hud-commands-header">Commands</div>
          {dualHasSpellbook(you.job, you.subjob) && (
            <button
              type="button"
              role="menuitem"
              className={`hud-cmd-btn${menuFocus === "spellbook" ? " selected" : ""}`}
              onMouseEnter={() => setMenuFocus("spellbook")}
              onFocus={() => setMenuFocus("spellbook")}
              onClick={() => {
                setMenuFocus("spellbook");
                setBookOpen((v) => !v);
              }}
            >
              Spellbook
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={`hud-cmd-btn${menuFocus === "character" ? " selected" : ""}`}
            onMouseEnter={() => setMenuFocus("character")}
            onFocus={() => setMenuFocus("character")}
            onClick={() => {
              setMenuFocus("character");
              setBagOpen((v) => !v);
            }}
          >
            Character
          </button>
          <button
            type="button"
            role="menuitem"
            className={`hud-cmd-btn${menuFocus === "crafting" ? " selected" : ""}`}
            onMouseEnter={() => setMenuFocus("crafting")}
            onFocus={() => setMenuFocus("crafting")}
            onClick={() => {
              setMenuFocus("crafting");
              setCraftOpen((v) => !v);
            }}
          >
            Crafting
          </button>
          <button
            type="button"
            role="menuitem"
            className={`hud-cmd-btn${menuFocus === "skills" ? " selected" : ""}`}
            title="Master skill tree — 1 point per level + 100 from post-max EXP"
            onMouseEnter={() => setMenuFocus("skills")}
            onFocus={() => setMenuFocus("skills")}
            onClick={() => {
              setMenuFocus("skills");
              setTreeOpen((v) => !v);
            }}
          >
            Skills
          </button>
          <button
            type="button"
            role="menuitem"
            className={`hud-cmd-btn${menuFocus === "party" ? " selected" : ""}`}
            onMouseEnter={() => setMenuFocus("party")}
            onFocus={() => setMenuFocus("party")}
            onClick={() => {
              setMenuFocus("party");
              setPartyOpen((v) => !v);
            }}
          >
            Party
          </button>
          <button
            type="button"
            role="menuitem"
            className={`hud-cmd-btn${menuFocus === "ashpit" ? " selected" : ""}${
              you.pvp?.bountyOpen ? " ash-pit-marked" : ""
            }`}
            title="Ash Pit — PvP bounty arena (L30)"
            onMouseEnter={() => setMenuFocus("ashpit")}
            onFocus={() => setMenuFocus("ashpit")}
            onClick={() => {
              setMenuFocus("ashpit");
              setAshPitOpen((v) => !v);
            }}
          >
            Ash Pit{you.pvp?.bountyOpen ? " · ★" : ""}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`hud-cmd-btn${menuFocus === "explorer" ? " selected" : ""}`}
            onMouseEnter={() => setMenuFocus("explorer")}
            onFocus={() => setMenuFocus("explorer")}
            onClick={() => {
              setMenuFocus("explorer");
              setExplorerOpen((v) => !v);
            }}
          >
            Explorer
          </button>
          <button
            type="button"
            role="menuitem"
            className={`hud-cmd-btn${menuFocus === "settings" ? " selected" : ""}`}
            onMouseEnter={() => setMenuFocus("settings")}
            onFocus={() => setMenuFocus("settings")}
            onClick={() => {
              setMenuFocus("settings");
              setSettingsOpen((v) => !v);
            }}
          >
            Settings
          </button>
          {import.meta.env.DEV && (
          <button
            type="button"
            role="menuitem"
            className={`hud-cmd-btn hud-cmd-status${menuFocus === "maxlv" ? " selected" : ""}`}
            title="Dev: set level 75 and learn all Time Mage spells"
            onMouseEnter={() => setMenuFocus("maxlv")}
            onFocus={() => setMenuFocus("maxlv")}
            onClick={() => {
              setMenuFocus("maxlv");
              send({ type: "debug/maxlevel" });
            }}
          >
            Max Lv
          </button>
          )}
        </div>
      </div>

      {bagOpen && <EquipPanel you={you} me={me} onClose={() => setBagOpen(false)} />}
      {craftOpen && <CraftingPanel you={you} onClose={() => setCraftOpen(false)} />}
      {lokOpen && <LokPanel you={you} onClose={() => setLokOpen(false)} />}
      {treeOpen && <SkillTreePanel onClose={() => setTreeOpen(false)} />}
      {!partyOpen && snapshot?.partyInvite && (
        <div className="party-invite-toast" role="status">
          <span>
            <strong>{snapshot.partyInvite.fromName}</strong> invited you to a party.
          </span>
          <button type="button" className="hud-cmd-btn selected" onClick={() => send({ type: "party/accept" })}>
            Accept
          </button>
          <button type="button" className="hud-cmd-btn" onClick={() => send({ type: "party/decline" })}>
            Decline
          </button>
          <button type="button" className="hud-cmd-btn" onClick={() => setPartyOpen(true)}>
            Party
          </button>
        </div>
      )}
      {explorerOpen && <ExplorerPanel onClose={() => setExplorerOpen(false)} />}
      {ashPitOpen && <AshPitPanel onClose={() => setAshPitOpen(false)} />}
      <AshPitSlainBanner />
      {partyOpen && wallet && (
        <PartyPanel
          party={snapshot?.party ?? null}
          invite={snapshot?.partyInvite ?? null}
          selectedTarget={selectedTarget}
          myWallet={wallet}
          onClose={() => setPartyOpen(false)}
        />
      )}
      {settingsOpen && (
        <div className="settings-panel">
          <div className="settings-panel-head">
            <div>
              <div className="settings-kicker">Hud appearance</div>
              <div className="settings-panel-title">Settings</div>
              <div className="settings-panel-sub">Color, font &amp; layout for the HUD</div>
            </div>
            <button type="button" className="cmd-close-btn" onClick={() => setSettingsOpen(false)}>
              Close
            </button>
          </div>
          <div className="settings-section settings-card">
            <div className="settings-section-label">Layout</div>
            <div className="settings-panel-sub" style={{ marginBottom: 8 }}>
              Mobile adds arcade sticks and moves hotkeys nearby for touch play.
            </div>
            <div className="cmd-seg" role="listbox" aria-label="UI layout">
              {UI_LAYOUT_OPTIONS.map((opt) => {
                const active = uiSettings.layout === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={active ? "on" : undefined}
                    title={opt.hint}
                    onClick={() => {
                      const next = { ...uiSettings, layout: opt.id as UiLayoutId };
                      setUiSettings(next);
                      persistAndApplyUiSettings(next);
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-section settings-card">
            <div className="settings-section-label">Color</div>
            <div className="settings-option-grid" role="listbox" aria-label="UI color">
              {UI_COLOR_OPTIONS.map((opt) => {
                const active = uiSettings.color === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`settings-option${active ? " active" : ""}`}
                    onClick={() => {
                      const next = { ...uiSettings, color: opt.id as UiColorId };
                      setUiSettings(next);
                      persistAndApplyUiSettings(next);
                    }}
                  >
                    <span className="settings-swatch" style={{ background: opt.swatch }} />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-section settings-card">
            <div className="settings-section-label">Font</div>
            <div className="settings-option-grid" role="listbox" aria-label="UI font">
              {UI_FONT_OPTIONS.map((opt) => {
                const active = uiSettings.font === opt.id;
                const fontFamily = UI_FONT_STACKS[opt.id];
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`settings-option${active ? " active" : ""}`}
                    style={{ fontFamily }}
                    onClick={() => {
                      const next = { ...uiSettings, font: opt.id as UiFontId };
                      setUiSettings(next);
                      persistAndApplyUiSettings(next);
                    }}
                  >
                    {opt.label}
                    <span className="settings-font-sample" style={{ fontFamily }}>
                      {opt.sample}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-section settings-card settings-session">
            <div className="settings-section-label">Session</div>
            <button
              type="button"
              className="settings-logout"
              onClick={() => {
                stopZoneMusic();
                logoutToMenu();
              }}
            >
              Logout to menu
            </button>
          </div>
        </div>
      )}

      {bookOpen && dualHasSpellbook(you.job, you.subjob) && (
        <div className="spellbook-panel">
          <div className="spellbook-head">
            <div>
              <div className="cmd-kicker">Abilities</div>
              <div>Spellbook</div>
              <div className="spellbook-sub">
                {bookIds.length} unlocked
                {you.subjob && you.subLevel > 0
                  ? ` · ${JOBS[you.job]?.name} + ${JOBS[you.subjob]?.name} L${you.subLevel}`
                  : ""}{" "}
                · drag onto hotbar
              </div>
            </div>
            <button type="button" className="cmd-close-btn" onClick={() => setBookOpen(false)}>
              Close
            </button>
          </div>
          {bookTabs.length > 0 && (
            <div className="spellbook-tabs" role="tablist" aria-label="Ability categories">
              {bookTabs.map((t) => {
                const count = bookByCategory.get(t.id)?.length ?? 0;
                const selected = t.id === activeBookTab;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`spellbook-tab${selected ? " active" : ""}`}
                    onClick={() => setBookTab(t.id)}
                  >
                    {t.label}
                    <span className="spellbook-tab-count">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="spellbook-list mmo-scroll" role="tabpanel">
            {bookIds.length === 0 && (
              <p className="spellbook-empty">
                No abilities yet — buy from the Trainer (west tent).
              </p>
            )}
            {tabIds.map((id) => (
              <SpellbookRow key={id} id={id} now={now} recasts={recasts} me={me} />
            ))}
          </div>
        </div>
      )}

      <div style={{ flex: 1 }} />

      <div className="hud-bottom">
        {mobileLayout ? (
          <MobileArcadeControls
            potions={potions}
            onCastSlot={(index) => {
              const id = hotbarAbilityAt(index, 0);
              if (id) castAbility(id);
            }}
            onCastRest={() => {
              if (restUnlocked) castAbility("rest");
            }}
            onPotion={() => send({ type: "item/use", tokenId: ITEM.POTION })}
          />
        ) : (
          <div className="hud-hotbar-stack">
            {hotbarRow1.map((id, i) =>
              id ? (
                <SkillButton
                  key={`r0-${i}`}
                  id={id}
                  keyLabel={HOTBAR_KEYS[i]}
                  now={now}
                  recasts={recasts}
                  me={me}
                  hotbarIndex={i}
                  onHotbarDrop={handleHotbarDrop}
                />
              ) : (
                <EmptyHotbarSlot
                  key={`r0-${i}`}
                  keyLabel={HOTBAR_KEYS[i]!}
                  slotIndex={i}
                  onHotbarDrop={handleHotbarDrop}
                />
              ),
            )}
            <div className="hud-hotbar-utility">
              {restUnlocked ? (
                <SkillButton id="rest" keyLabel="R" now={now} recasts={recasts} me={me} draggable={false} />
              ) : (
                <div className="skill-wrap" aria-hidden>
                  <div className="skill-slot empty" style={{ visibility: "hidden" }} />
                </div>
              )}
              <div
                className="skill-wrap tip-above"
                onPointerLeave={(e) => e.currentTarget.classList.remove("tip-dismissed")}
                onPointerEnter={(e) => e.currentTarget.classList.remove("tip-dismissed")}
              >
                <button
                  type="button"
                  className="skill-slot potion"
                  aria-label="Potion. Restore HP. Key Q."
                  onClick={(e) => {
                    send({ type: "item/use", tokenId: ITEM.POTION });
                    e.currentTarget.closest(".skill-wrap")?.classList.add("tip-dismissed");
                    e.currentTarget.blur();
                  }}
                >
                    <span className="skill-key">Q</span>
                    <AbilityIcon id="potion" />
                    <span className="skill-name">Potion×{potions}</span>
                </button>
                <div className="skill-tip" role="tooltip">
                  <div className="skill-tip-title">Potion</div>
                  <div className="skill-tip-body">
                    Drink to restore {getItem(ITEM.POTION)?.consume?.hp ?? 70} HP. Keep a stack for emergencies.
                  </div>
                  <div className="skill-tip-meta">Item · Key Q · ×{potions}</div>
                </div>
              </div>
            </div>
            {hotbarRow2.map((id, i) => {
              const slotIndex = HOTBAR_ROW_LEN + i;
              return id ? (
                <SkillButton
                  key={`r1-${i}`}
                  id={id}
                  keyLabel={HOTBAR_SHIFT_KEYS[i]}
                  now={now}
                  recasts={recasts}
                  me={me}
                  hotbarIndex={slotIndex}
                  onHotbarDrop={handleHotbarDrop}
                />
              ) : (
                <EmptyHotbarSlot
                  key={`r1-${i}`}
                  keyLabel={HOTBAR_SHIFT_KEYS[i]!}
                  slotIndex={slotIndex}
                  onHotbarDrop={handleHotbarDrop}
                />
              );
            })}
            <div className="hud-hotbar-utility hud-hotbar-utility-spacer" aria-hidden>
              <div className="skill-wrap">
                <div className="skill-slot" />
              </div>
              <div className="skill-wrap">
                <div className="skill-slot" />
              </div>
            </div>
          </div>
        )}

        <div className="hud-log-frame">
          <div className="hud-log-head">
            <span>Combat Log</span>
            <span className="hud-log-hints">
              {mobileLayout
                ? "Sticks · Face 1–8 · Flick Skills stick · R Rest · Q Potion · K Book · B Character"
                : "WASD · Drag book→bar · 1–0 · Shift+1–0 · R Rest · Q Potion · K Book · B Character · C Craft"}
            </span>
          </div>
          <div className="hud-log-body mmo-scroll">
            {logs.map((l, i) => (
              <div key={`${i}-${l.slice(0, 24)}`} className={logClass(l)}>
                {l}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        </div>
      </div>
    </div>
  );
}

function WalletConnectButton() {
  // AppKit hooks require createAppKit (appkit-config). When unset, fall back without hooks.
  if (appKitConfigured()) return <AppKitConnectButton />;
  return <FallbackConnectButton />;
}

/**
 * Docs path (https://docs.reown.com/appkit/overview): useAppKit().open for the
 * pre-built modal (EIP-6963 / WalletConnect / Coinbase). Login+sign runs once
 * useAppKitAccount reports connected (open() alone only shows the modal).
 */
function AppKitConnectButton() {
  const pushLog = useGame((s) => s.pushLog);
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const { open: modalOpen } = useAppKitState();
  const [busy, setBusy] = useState(false);
  const loginStarted = useRef(false);

  useEffect(() => {
    if (!busy || !isConnected || !address || loginStarted.current) return;
    loginStarted.current = true;
    // Modal already open via useAppKit — do not call connectWithAppKit / raw WC QR.
    void loginWithWalletConnect({ appKitAlreadyOpen: true }).then((res) => {
      setBusy(false);
      loginStarted.current = false;
      if (!res.ok) pushLog("Wallet: " + res.error);
      else pushLog("Wallet: " + res.address.slice(0, 6) + "…" + res.address.slice(-4));
    });
  }, [busy, isConnected, address, pushLog]);

  // User dismissed the modal without connecting.
  useEffect(() => {
    if (busy && !modalOpen && !isConnected && !loginStarted.current) {
      setBusy(false);
    }
  }, [busy, modalOpen, isConnected]);

  return (
    <button
      type="button"
      className="boot-primary"
      disabled={busy}
      style={{ marginTop: "0.75rem", width: "100%" }}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        loginStarted.current = false;
        void open({ view: "Connect" }).catch((err: unknown) => {
          setBusy(false);
          pushLog("Wallet: " + (err instanceof Error ? err.message : String(err)));
        });
      }}
    >
      {busy ? "Opening wallet…" : "Connect Wallet"}
    </button>
  );
}

function FallbackConnectButton() {
  const pushLog = useGame((s) => s.pushLog);
  const [busy, setBusy] = useState(false);
  if (!walletConnectLoginAvailable()) {
    return (
      <button
        type="button"
        className="boot-primary"
        disabled
        style={{ marginTop: "0.75rem", width: "100%", opacity: 0.75 }}
        title="Set VITE_WALLETCONNECT_PROJECT_ID (Reown) in apps/web/.env.local, or install a browser wallet"
      >
        Connect Wallet (set Reown project ID or install MetaMask)
      </button>
    );
  }
  return (
    <button
      type="button"
      className="boot-primary"
      disabled={busy}
      style={{ marginTop: "0.75rem", width: "100%" }}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void loginWithWalletConnect().then((res) => {
          setBusy(false);
          if (!res.ok) pushLog("Wallet: " + res.error);
          else pushLog("Wallet: " + res.address.slice(0, 6) + "…" + res.address.slice(-4));
        });
      }}
    >
      {busy ? "Opening wallet…" : "Connect Wallet"}
    </button>
  );
}

export function BootScreens() {
  const phase = useGame((s) => s.phase);
  const connected = useGame((s) => s.connected);
  const hasCharacter = useGame((s) => s.hasCharacter);
  const characterPreview = useGame((s) => s.characterPreview);
  const snapshot = useGame((s) => s.snapshot);

  if (phase === "play" && snapshot) return null;

  return (
    <div className="boot-screen">
      <div className="boot-frame">
        <div className="boot-card">
          <h1 className="boot-brand">
            <img
              className="boot-brand-banner"
              src="/ui/black-anvil/slices/a1-title-banner.png"
              alt="Black Anvil"
            />
            <span className="boot-brand-fallback">Black Anvil</span>
          </h1>
          {!connected || phase === "boot" || phase === "auth" ? (
            <>
              <p className="boot-sub">
                {!connected
                  ? "Connecting to server…"
                  : phase === "auth"
                    ? "Connect a wallet to sign in."
                    : "Signing in…"}
              </p>
              <WalletConnectButton />
            </>
          ) : phase === "create" ? (
            <>
              <WalletConnectButton />
              <CreatePanel />
            </>
          ) : phase === "select" || hasCharacter ? (
            <>
              <WalletConnectButton />
              <SelectPanel preview={characterPreview} />
            </>
          ) : (
            <>
              <WalletConnectButton />
              <CreatePanel />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function appearanceLabel(g: string | undefined): string {
  if (g === "female") return "Female";
  if (g === "pepeka") return "Pepeka";
  return "Male";
}

function appearancePortrait(g: string | undefined): string {
  if (g === "female") return "/ui/boot/boot-portrait-female.png";
  if (g === "pepeka") return "/ui/boot/boot-portrait-pepeka.png";
  return "/ui/boot/boot-portrait-male.png";
}

function SelectPanel({
  preview,
}: {
  preview: {
    id?: string;
    name: string;
    job: JobId;
    level: number;
    gender?: "male" | "female" | "pepeka";
  } | null;
}) {
  const characters = useGame((s) => s.characters);
  const selectedCharId = useGame((s) => s.selectedCharId);
  const list =
    characters.length > 0
      ? characters
      : preview
        ? [
            {
              id: preview.id ?? "active",
              name: preview.name,
              job: preview.job,
              level: preview.level,
              gender: ("gender" in preview && preview.gender) || "male",
            },
          ]
        : [];
  const selected = list.find((c) => c.id === selectedCharId) ?? list[0] ?? null;

  return (
    <div className="boot-panel">
      <p className="boot-sub">Choose your adventurer</p>
      {list.length > 0 ? (
        <div className="boot-roster">
          {list.map((c) => {
            const jobName = JOBS[c.job]?.name ?? c.job;
            const active = selected?.id === c.id;
            const g = "gender" in c ? c.gender : "male";
            return (
              <button
                key={c.id}
                type="button"
                className={["boot-char-slot", active ? "selected" : ""].filter(Boolean).join(" ")}
                onClick={() => {
                  useGame.getState().setSelectedCharId(c.id);
                  useGame.getState().setCharacterPreview(c);
                }}
              >
                <img
                  className="boot-char-portrait"
                  src={appearancePortrait(g)}
                  alt=""
                  width={72}
                  height={72}
                />
                <div className="boot-char-meta">
                  <div className="boot-char-name">{c.name}</div>
                  <div className="boot-char-detail">
                    Lv.{c.level} {jobName} · {appearanceLabel(g)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="boot-sub">Loading character…</p>
      )}
      <button
        type="button"
        className="boot-primary"
        disabled={!selected}
        onClick={() => {
          useGame.getState().setPendingCreateEnter(false);
          useGame.getState().setPhase("play");
          send({ type: "char/enter", characterId: selected?.id });
        }}
      >
        Enter Black Anvil
      </button>
      <button
        type="button"
        className="boot-secondary"
        onClick={() => {
          useGame.getState().setPendingCreateEnter(false);
          useGame.getState().clearSnapshot();
          useGame.getState().setPhase("create");
        }}
      >
        Create new character
      </button>
    </div>
  );
}

type Appearance = "male" | "female" | "pepeka";

function CreatePanel() {
  const [job, setJob] = useState<JobId>("time_mage");
  const [gender, setGender] = useState<Appearance>("male");
  const [creating, setCreating] = useState(false);
  const characters = useGame((s) => s.characters);
  const pushLog = useGame((s) => s.pushLog);
  const mintCfg = useGame((s) => s.characterMint ?? s.snapshot?.you?.lok?.characterMint ?? null);
  const playableJobs = (Object.keys(JOBS) as JobId[]).filter((j) => JOBS[j].playable);

  return (
    <form
      className="boot-panel"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (creating) return;
        const fd = new FormData(e.currentTarget);
        const rawName = String(fd.get("name") || "Chrona");
        // M-C: same name rules as the server, before any payment.
        const named = normalizeCharacterName(rawName);
        if (!named.ok) {
          pushLog(named.error);
          return;
        }
        const name = named.name;
        if (characters.some((c) => characterNameKey(c.name) === named.key)) {
          pushLog("That name is already on your roster. Pick another.");
          return;
        }
        const jobIndex = JOB_IDS.indexOf(job);
        useGame.getState().setPendingCreateEnter(true);
        setCreating(true);

        const finish = (extra?: {
          tokenId?: string;
          mintWallet?: string;
          mintNonce?: string;
          mintExpiry?: number;
          mintSignature?: string;
          mintChainId?: number;
          mintCharId?: string;
        }) => {
          send({
            type: "char/create",
            name,
            job,
            gender,
            ...(extra?.tokenId ? { tokenId: extra.tokenId } : {}),
            ...(extra?.mintWallet ? { mintWallet: extra.mintWallet } : {}),
            ...(extra?.mintNonce ? { mintNonce: extra.mintNonce } : {}),
            ...(extra?.mintExpiry != null ? { mintExpiry: extra.mintExpiry } : {}),
            ...(extra?.mintSignature ? { mintSignature: extra.mintSignature } : {}),
            ...(extra?.mintChainId != null ? { mintChainId: extra.mintChainId } : {}),
            ...(extra?.mintCharId ? { mintCharId: extra.mintCharId } : {}),
          });
          window.setTimeout(() => send({ type: "claim/starter" }), 100);
          setCreating(false);
        };

        if (!isServerAuthed()) {
          pushLog("Sign in before creating a character.");
          useGame.getState().setPendingCreateEnter(false);
          setCreating(false);
          return;
        }
        void checkCharacterNameAvailable(name).then((avail) => {
          if (!avail.ok) {
            pushLog(avail.error);
            useGame.getState().setPendingCreateEnter(false);
            setCreating(false);
            return;
          }

          if (!mintCfg) {
            finish();
            return;
          }

          // Mint-first: pay native settlement fee, then create the log char bound to that NFT id.
          const gameWallet = useGame.getState().wallet;
          if (!gameWallet) {
            pushLog("Authenticate before creating a character.");
            useGame.getState().setPendingCreateEnter(false);
            setCreating(false);
            return;
          }
          if (mintCfg.devFaucet) send({ type: "dev/faucet" });
          window.setTimeout(() => {
            void mintCharacterWithWallet({
              mint: mintCfg,
              job: jobIndex < 0 ? 0 : jobIndex,
              gameWallet,
              charId: name,
              allowReuse: true,
            }).then((res) => {
              if (!res.ok) {
                pushLog("Character mint: " + res.error);
                useGame.getState().setPendingCreateEnter(false);
                setCreating(false);
                return;
              }
              {
                const unit = mintCfg.currency?.symbol ?? "xDAI";
                const txLink =
                  !res.reused && res.hash && res.hash !== "reuse"
                    ? explorerTxUrl(mintCfg.chainId, res.hash)
                    : "";
                pushLog(
                  (res.reused
                    ? "Reusing already-paid NFT #"
                    : "Paid character mint fee (native " +
                        unit +
                        "). Creating log identity for NFT #") +
                    res.tokenId +
                    "…" +
                    (txLink ? " " + txLink : ""),
                );
              }
              finish({
                tokenId: res.tokenId,
                mintWallet: res.payer,
                ...(res.mintSignature
                  ? {
                      mintNonce: res.mintNonce,
                      mintExpiry: res.mintExpiry,
                      mintSignature: res.mintSignature,
                      mintChainId: mintCfg.chainId,
                      mintCharId: res.charId,
                    }
                  : {}),
              });
              // M-F: also clear if the roster later shows this token (auth refresh / late snapshot).
              window.setTimeout(() => {
                const roster = useGame.getState().characters;
                if (
                  roster.some(
                    (c) => c.tokenId === res.tokenId || characterNameKey(c.name) === named.key,
                  )
                ) {
                  clearPendingMint(gameWallet);
                }
              }, 1500);
            });
          }, mintCfg.devFaucet ? 800 : 0);
        });
      }}
    >
      <p className="boot-sub">Create your adventurer</p>
      {mintCfg ? (
        <p className="boot-sub">
          Character NFT mint fee: {(Number(mintCfg.mintFee) / 1e18).toFixed(4)}{" "}
          {mintCfg.currency?.symbol ??
            (mintCfg.chainId === 100 || mintCfg.chainId === 10200 ? "xDAI" : "ETH")}{" "}
          (native, paid from your
          wallet before the character is created)
          {mintCfg.devFaucet ? ". Local faucet can fund the burner on anvil 31337." : ""}.
        </p>
      ) : null}
      <label className="boot-label">
        Character name
        <input name="name" defaultValue="Chrona" maxLength={16} className="boot-input" />
      </label>

      <div className="boot-section">
        <div className="boot-label">Appearance</div>
        <div className="boot-appearances" role="group" aria-label="Appearance">
          {(
            [
              { id: "male" as const, label: "Male", src: "/ui/boot/boot-portrait-male.png" },
              { id: "female" as const, label: "Female", src: "/ui/boot/boot-portrait-female.png" },
              { id: "pepeka" as const, label: "Pepeka", src: "/ui/boot/boot-portrait-pepeka.png" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={["boot-appearance", gender === opt.id ? "selected" : ""]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setGender(opt.id)}
            >
              <img src={opt.src} alt="" width={96} height={96} />
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      <label className="boot-label">
        Main job
        <div className="boot-job-scroll">
          <select
            className="boot-job-select"
            value={job}
            onChange={(e) => setJob(e.target.value as JobId)}
            aria-label="Main job"
          >
            {playableJobs.map((j) => (
              <option key={j} value={j}>
                {JOBS[j].name}
              </option>
            ))}
          </select>
        </div>
      </label>
      <p className="boot-hint">
        Lv.{SUBJOB_UNLOCK_LEVEL}+ unlocks a support job (half main level). Your sprite stays main.
      </p>
      <button type="submit" className="boot-primary">
        Create {JOBS[job]?.name ?? "Adventurer"} · Claim starter
      </button>
      {characters.length > 0 && (
        <button
          type="button"
          className="boot-secondary"
          onClick={() => useGame.getState().setPhase("select")}
        >
          Back to character select
        </button>
      )}
    </form>
  );
}

/** Exported for App keybinds — row 0 = 1–0, row 1 = Shift+1–0. */
export function hotbarAbilityAt(index: number, row = 0): AbilityId | null {
  return liveHotbarSlots[row * HOTBAR_ROW_LEN + index] ?? null;
}

export { castAbility, HOTBAR_KEYS };
