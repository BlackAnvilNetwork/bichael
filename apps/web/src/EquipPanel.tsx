import {
  JOBS,
  attackFromStats,
  magicAttackMul,
  playerDefense,
  deriveCharacterAttributes,
  isJobId,
  meleeUsesWeaponAttack,
  skillPointsSpentOnTree,
  xpToNextLevel,
  type AttrKey,
} from "@bellgrave/combat";
import {
  aggregateEquipmentStats,
  getItem,
  itemIcon,
  itemName,
  type EquipSlot,
} from "@bellgrave/items";
import { formatJobs, formatPrimaryEffects } from "./itemTip";
import type { SnapshotMessage, UnitSnapshot } from "@bellgrave/protocol";
import { useMemo } from "react";
import { send } from "./net";
import { statTooltip } from "./statTooltips";

function formatSigned(v: number): string {
  return `${v > 0 ? "+" : ""}${v}`;
}

function isMatKind(kind: string | undefined): boolean {
  return kind === "base" || kind === "intermediate" || kind === "filler" || kind === "bait";
}

type BagRow = { tokenId: number; amount: number; starter?: boolean };

type SlotDef = { id: EquipSlot; label: string };

/** Catalog-backed paperdoll slots. Equip from the bag; click a filled slot to remove it. */
const SLOTS: SlotDef[] = [
  { id: "main", label: "Main" },
  { id: "sub", label: "Sub" },
  { id: "grip", label: "Grip" },
  { id: "ranged", label: "Ranged" },
  { id: "ammo", label: "Ammo" },
  { id: "head", label: "Head" },
  { id: "earring", label: "Earring" },
  { id: "body", label: "Body" },
  { id: "hands", label: "Hands" },
  { id: "ring", label: "Ring" },
  { id: "legs", label: "Legs" },
  { id: "feet", label: "Feet" },
];

const STAT_ORDER = [
  ["STR", "str"],
  ["DEX", "dex"],
  ["VIT", "vit"],
  ["AGI", "agi"],
  ["INT", "int"],
  ["MND", "mnd"],
] as const;

type Props = {
  you: SnapshotMessage["you"];
  me: UnitSnapshot;
  onClose: () => void;
};

export function EquipPanel({ you, me, onClose }: Props) {
  const job = isJobId(you.job) ? you.job : "time_mage";
  const sub = you.subjob && isJobId(you.subjob) ? you.subjob : null;
  const derived = deriveCharacterAttributes(
    job,
    you.level,
    sub,
    you.skillUnlocked ?? [],
    you.freeStats ?? {},
  );
  const gearStats = aggregateEquipmentStats(you.equip);
  const stats = {
    str: derived.total.str + (gearStats.str ?? 0),
    dex: derived.total.dex + (gearStats.dex ?? 0),
    vit: derived.total.vit + (gearStats.vit ?? 0),
    agi: derived.total.agi + (gearStats.agi ?? 0),
    int: derived.total.int + (gearStats.int ?? 0),
    mnd: derived.total.mnd + (gearStats.mnd ?? 0),
  };
  const weaponBonus = you.equip.main ? (gearStats.atk ?? 10) : 0;
  const weaponAttack = meleeUsesWeaponAttack(job);
  const stance = weaponAttack ? "none" : me.buffs.flux ? "flux" : me.buffs.aether ? "aether" : "none";
  const attack =
    attackFromStats(stats, stance, weaponBonus, weaponAttack ? { physical: true } : undefined) +
    derived.tree.atk;
  // Same helpers the server uses for mob hits and spell damage (#52).
  const defense = playerDefense(stats.vit, gearStats.def ?? 0);
  const gearMab = gearStats.mab ?? 0;
  const spellBonusPct = Math.round((magicAttackMul(gearMab) - 1) * 100);
  const freeLeft = you.freeStatPoints ?? 0;
  const freeStats = derived.free;
  const treeSpent = skillPointsSpentOnTree(you.skillUnlocked ?? [], job, sub);
  const treeBonusEntries = Object.entries(derived.tree).filter(([, value]) => value !== 0);
  const now = Date.now();
  const tpPct = Math.min(100, Math.floor((me.tp / 3000) * 100));
  const xpNeed = xpToNextLevel(you.level);
  const xpHave = Math.max(0, you.xp);
  const xpLeft = Math.max(0, xpNeed - xpHave);
  const jobName = JOBS[you.job]?.name ?? you.job;
  const stanceLabel =
    job === "knight"
      ? me.buffs.bulwarkUntil > now
        ? " · Bulwark"
        : me.buffs.sentinelUntil > now
          ? " · Sentinel"
          : me.buffs.rampartUntil > now
            ? " · Rampart"
            : ""
      : job === "rogue" && me.buffs.ghostStepUntil > now
        ? " · Ghost Step"
        : job === "fighter" && me.buffs.killingStormUntil > now
          ? " · Killing Storm"
          : job === "fighter" && me.buffs.berserkUntil > now
            ? " · Berserk"
            : job === "fighter" && me.buffs.warcryUntil > now
              ? " · Warcry"
              : me.buffs.flux
                ? " · Flux"
                : me.buffs.aether
                  ? " · Aether"
                  : "";

  const gearRows = useMemo(() => {
    const gear: BagRow[] = [];
    for (const i of you.inventory) {
      if (!isMatKind(getItem(i.tokenId)?.kind)) gear.push(i);
    }
    return gear;
  }, [you.inventory]);

  return (
    <div className="cmd-panel equip-panel">
      <div className="cmd-panel-head">
        <div>
          <div className="cmd-kicker">Character</div>
          <div className="cmd-panel-title">{you.name}</div>
          <div className="cmd-panel-sub">
            Lv.{you.level} {jobName}
            {sub ? ` / ${JOBS[sub]?.name ?? sub} L${you.subLevel || Math.floor(you.level / 2)}` : ""}
            {stanceLabel}
          </div>
        </div>
        <button type="button" onClick={onClose} className="cmd-close-btn">
          Close
        </button>
      </div>

      <div className="equip-columns">
        <div className="equip-col">
          <Row label="HP" value={`${me.hp} / ${me.maxHp}`} />
          <Row label="MP" value={`${me.mp} / ${me.maxMp}`} />
          <Row label="TP" value={`${tpPct}%`} />
          <Row label="Dust" value={String(you.dust)} />
          <Row label="XP" value={`${xpHave} / ${xpNeed}`} hint={`${xpLeft} to next`} />

          <div className="cmd-section-label">
            Attributes
            {freeLeft > 0 && (
              <span className="equip-free-hint">{freeLeft} free pt{freeLeft === 1 ? "" : "s"}</span>
            )}
          </div>
          <div className="equip-attr-legend" aria-hidden="true">
            base · tree · free · gear
          </div>
          {STAT_ORDER.map(([label, key]) => {
            const bonus = freeStats[key] ?? 0;
            return (
              <StatRow
                key={key}
                label={label}
                tip={statTooltip(job, key)}
                value={stats[key]}
                freeBonus={bonus}
                breakdown={`base ${derived.base[key]} · tree ${formatSigned(derived.tree[key])} · free ${formatSigned(bonus)} · gear ${formatSigned(gearStats[key] ?? 0)}`}
                canInc={freeLeft > 0}
                canDec={bonus > 0}
                onInc={() => send({ type: "skill/freestat", attr: key as AttrKey, delta: 1 })}
                onDec={() => send({ type: "skill/freestat", attr: key as AttrKey, delta: -1 })}
              />
            );
          })}

          <div className="cmd-section-label">Skill Tree</div>
          <Row label="SP" value={`${you.skillPoints ?? 0} available`} hint={`${treeSpent} spent`} />
          <Row
            label="Nodes"
            value={String((you.skillUnlocked ?? []).length)}
            hint={
              treeBonusEntries.length
                ? treeBonusEntries
                    .map(([key, value]) => `${key.toUpperCase()} ${formatSigned(value)}`)
                    .join(" / ")
                : "No stat bonuses"
            }
          />

          <div className="cmd-section-label">Combat</div>
          <Row
            label="Attack"
            value={String(attack)}
            hint={
              job === "time_mage"
                ? me.buffs.flux
                  ? "MND (Flux)"
                  : me.buffs.aether
                    ? "Suppressed (Aether)"
                    : "STR x0.1"
                : job === "sorcerer" || job === "cleric"
                  ? "STR + staff"
                  : "STR + weapon"
            }
          />
          <Row
            label="Defense"
            value={String(defense)}
            hint={(gearStats.def ?? 0) > 0 ? `gear +${gearStats.def}` : undefined}
          />
          {spellBonusPct > 0 && (
            <Row label="Spell damage" value={`+${spellBonusPct}%`} hint={`gear MAB ${gearMab}`} />
          )}
        </div>

        <div className="equip-block">
          <div className="equip-col">
            <div className="cmd-section-label">Equipment</div>
            <div className="equip-bag-list">
              {gearRows.length === 0 && <div className="craft-empty">No gear or consumables</div>}
              {gearRows.map((i) => (
                <BagItemRow key={i.tokenId + (i.starter ? "-starter" : "")} item={i} you={you} showActions />
              ))}
            </div>
          </div>

          <div className="equip-col">
            <div className="cmd-section-label">Paperdoll</div>
            <div className="equip-grid">
              {SLOTS.map((slot) => (
                <EquipCell key={slot.id} slot={slot} you={you} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BagItemRow({
  item,
  you,
  showActions,
}: {
  item: BagRow;
  you: SnapshotMessage["you"];
  showActions: boolean;
}) {
  const def = getItem(item.tokenId);
  const statsLine = formatPrimaryEffects(def?.stats, def?.consume?.hp);
  const jobsLine = formatJobs(def?.jobRestrict);
  const ilevel = def?.craftLevel;
  const actions = showActions ? bagItemActions(item, you) : null;
  const equipped = Object.values(you.equip).includes(item.tokenId);

  return (
    <div className={`equip-bag-card${equipped ? " equipped" : ""}`}>
      <img
        src={itemIcon(item.tokenId)}
        alt=""
        width={48}
        height={48}
        className="equip-item-icon"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.opacity = "0.25";
        }}
      />
      <div className="equip-bag-card-body">
        <div className="equip-item-name">
          {itemName(item.tokenId)}{item.starter ? " (starter)" : ""}
          <span className="equip-item-qty"> x{item.amount}</span>
        </div>
        {statsLine ? <div className="equip-item-stats">{statsLine}</div> : null}
        {(ilevel != null || jobsLine) && (
          <div className="equip-item-meta">
            {ilevel != null && <span className="equip-item-ilevel">iLv. {ilevel}</span>}
            {jobsLine ? <span className="equip-item-jobs">{jobsLine}</span> : null}
          </div>
        )}
      </div>
      {actions}
    </div>
  );
}

function itemJobKey(job: string): string {
  if (job === "time_mage") return "tim";
  if (job === "battle_mage") return "battlemage";
  return job;
}

function bagItemActions(item: BagRow, you: SnapshotMessage["you"]) {
  const tokenId = item.tokenId;
  const def = getItem(tokenId);
  const btns: { key: string; label: string; onClick: () => void; disabled?: boolean; title?: string }[] = [];

  if (def?.kind === "equipment" && def.slot) {
    const slot = def.slot;
    const equipped = you.equip[slot] === tokenId;
    const jobs = def.jobRestrict;
    const jobAllowed =
      !jobs ||
      jobs === "all" ||
      jobs.includes(itemJobKey(you.job) as never) ||
      (!!you.subjob && jobs.includes(itemJobKey(you.subjob) as never));
    const main = you.equip.main ? getItem(you.equip.main) : undefined;
    const handBlocked = (slot === "sub" && main?.twoHand) || (slot === "grip" && !main?.twoHand);
    const reason = !jobAllowed
      ? "Your main/support job cannot equip this item"
      : handBlocked
        ? slot === "sub"
          ? "Unequip the two-handed weapon first"
          : "A grip requires a two-handed weapon"
        : undefined;
    btns.push({
      key: `equip-${slot}`,
      label: equipped ? "Unequip" : `Equip ${slot}`,
      disabled: !equipped && !!reason,
      title: reason,
      onClick: () => send({ type: "equip", slot, tokenId: equipped ? null : tokenId }),
    });
  }
  if (def?.kind === "consumable" && def.consume) {
    btns.push({
      key: "use",
      label: "Use",
      onClick: () => send({ type: "item/use", tokenId }),
    });
  }
  btns.push({
    key: "discard",
    label: "Discard",
    title: item.starter ? "Starter gear cannot be sold or exported. Discard destroys it." : "Destroy this stack",
    onClick: () => send({ type: "item/discard", tokenId, starter: !!item.starter }),
  });
  if (!btns.length) return null;
  return (
    <div className="equip-bag-card-actions">
      {btns.map((b) => (
        <button
          key={b.key}
          type="button"
          className="cmd-mini-btn"
          onClick={b.onClick}
          disabled={b.disabled}
          title={b.title}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

function StatRow({
  label,
  tip,
  value,
  freeBonus,
  breakdown,
  canInc,
  canDec,
  onInc,
  onDec,
}: {
  label: string;
  tip: string;
  value: number;
  freeBonus: number;
  breakdown: string;
  canInc: boolean;
  canDec: boolean;
  onInc: () => void;
  onDec: () => void;
}) {
  const tipId = `stat-tip-${label}`;
  return (
    <div className="equip-stat-row equip-attr-row">
      <button type="button" className="label equip-stat-label" aria-describedby={tipId}>
        {label}
      </button>
      <div id={tipId} className="skill-tip equip-stat-tip" role="tooltip">
        <div className="skill-tip-title">{label}</div>
        <div className="skill-tip-body">{tip}</div>
      </div>
      <span className="value">{value}</span>
      {freeBonus > 0 && <span className="equip-free-bonus">+{freeBonus}</span>}
      <span className="equip-arrow-group">
        <button
          type="button"
          className="equip-arrow-btn"
          style={{ opacity: canInc ? 1 : 0.3 }}
          disabled={!canInc}
          title={canInc ? `Add 1 ${label}` : "No free points"}
          onClick={onInc}
          aria-label={`Increase ${label}`}
        >
          ▲
        </button>
        <button
          type="button"
          className="equip-arrow-btn"
          style={{ opacity: canDec ? 1 : 0.3 }}
          disabled={!canDec}
          title={canDec ? `Remove 1 ${label}` : `No free points on ${label}`}
          onClick={onDec}
          aria-label={`Decrease ${label}`}
        >
          ▼
        </button>
      </span>
      <span className="equip-attr-breakdown" title={breakdown}>
        {breakdown}
      </span>
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="equip-stat-row">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function EquipCell({
  slot,
  you,
}: {
  slot: SlotDef;
  you: SnapshotMessage["you"];
}) {
  const equipped = you.equip[slot.id];

  return (
    <button
      type="button"
      title={equipped ? `${itemName(equipped)} (click to unequip)` : `${slot.label} — empty`}
      onClick={() => equipped && send({ type: "equip", slot: slot.id, tokenId: null })}
      disabled={!equipped}
      className={`equip-cell live${equipped ? " filled" : ""}`}
    >
      <div className="equip-cell-label">{slot.label}</div>
      <div className="equip-cell-icon">
        {equipped ? (
          <img src={itemIcon(equipped)} alt="" width={28} height={28} className="equip-item-icon" />
        ) : (
          "—"
        )}
      </div>
    </button>
  );
}
