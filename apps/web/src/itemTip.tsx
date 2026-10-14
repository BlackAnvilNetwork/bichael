import {
  CRAFT_SKILL_LABEL,
  getItem,
  itemIcon,
  scaleGearStat,
  usedInRecipes,
  type ItemDef,
  type ItemStats,
  type UsedInRecipe,
} from "@bellgrave/items";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useGame } from "./state";

const JOB_ABBR: Record<string, string> = {
  knight: "KNT",
  rogue: "ROG",
  cleric: "CLR",
  sorcerer: "SOR",
  fighter: "FTR",
  battlemage: "BMG",
  tim: "TM",
  time_mage: "TM",
};

const PRIMARY_STAT_KEYS = [
  "def",
  "atk",
  "mab",
  "mdb",
  "acc",
  "eva",
  "hp",
  "mp",
  "regen",
  "healPotency",
] as const;

const STAT_LABEL: Record<string, string> = {
  def: "DEF",
  atk: "ATK",
  mab: "MAB",
  mdb: "MDB",
  acc: "ACC",
  eva: "EVA",
  hp: "HP",
  mp: "MP",
  regen: "Regen",
  healPotency: "Healing Potency",
  str: "STR",
  dex: "DEX",
  vit: "VIT",
  agi: "AGI",
  int: "INT",
  mnd: "MND",
};

function formatSigned(v: number): string {
  return `${v > 0 ? "+" : ""}${v}`;
}

/** Same primary line the equipment bag already shows. Missing stats stay blank. */
export function formatPrimaryEffects(stats: ItemStats | undefined, consumeHp?: number): string {
  if ((!stats || !Object.keys(stats).length) && consumeHp == null) return "";
  const entries = { ...(stats ?? {}) } as Record<string, number>;
  let primaryKey: string | undefined;
  let primaryVal: number | undefined;

  for (const k of PRIMARY_STAT_KEYS) {
    if (typeof entries[k] === "number") {
      primaryKey = k;
      primaryVal = entries[k];
      delete entries[k];
      break;
    }
  }
  if (primaryKey == null && consumeHp != null) {
    primaryKey = "hp";
    primaryVal = consumeHp;
  }

  const effects = Object.entries(entries)
    .map(([k, v]) => `${STAT_LABEL[k] ?? k.toUpperCase()} ${formatSigned(v)}`)
    .join(" / ");

  if (primaryKey == null) return effects;
  const head = `${STAT_LABEL[primaryKey] ?? primaryKey.toUpperCase()}: ${primaryVal}`;
  return effects ? `${head} / ${effects}` : head;
}

/**
 * Format stats scaled by player level vs item level (#103).
 * Shows "STAT: scaled" when level < iLv, with optional "(full at Lv.X)" hint.
 */
export function formatScaledStats(
  stats: ItemStats | undefined,
  playerLevel: number,
  itemIlvl: number,
): string {
  if (!stats || !Object.keys(stats).length) return "";
  const scaled = playerLevel < itemIlvl;
  const entries: string[] = [];

  for (const k of PRIMARY_STAT_KEYS) {
    const raw = stats[k];
    if (typeof raw !== "number") continue;
    const val = scaled ? scaleGearStat(raw, playerLevel, itemIlvl) : raw;
    entries.push(`${STAT_LABEL[k] ?? k.toUpperCase()}: ${val}`);
  }

  const attrKeys = ["str", "dex", "vit", "agi", "int", "mnd"] as const;
  for (const k of attrKeys) {
    const raw = stats[k];
    if (typeof raw !== "number") continue;
    const val = scaled ? scaleGearStat(raw, playerLevel, itemIlvl) : raw;
    entries.push(`${STAT_LABEL[k] ?? k.toUpperCase()} ${formatSigned(val)}`);
  }

  return entries.join(" / ");
}

export function formatJobs(jobRestrict: ItemDef["jobRestrict"]): string {
  if (!jobRestrict) return "";
  if (jobRestrict === "all") return "All jobs";
  return jobRestrict.map((j) => JOB_ABBR[j] ?? j.toUpperCase()).join(" / ");
}

type Anchor = { top: number; left: number; bottom: number };

function tipStyle(anchor: Anchor): CSSProperties {
  const width = 240;
  const gap = 8;
  let left = anchor.left;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  if (left > maxLeft) left = maxLeft;
  if (left < 8) left = 8;
  const placeAbove = anchor.top >= window.innerHeight - anchor.bottom;
  return {
    position: "fixed",
    left,
    width,
    top: placeAbove ? undefined : anchor.bottom + gap,
    bottom: placeAbove ? window.innerHeight - anchor.top + gap : undefined,
    opacity: 1,
    visibility: "visible",
    pointerEvents: "none",
    zIndex: 80,
  };
}

/** Icon, name, stats, item level, and jobs. Omitted fields are not rendered. */
export function ItemCatalogDetails({ tokenId }: { tokenId: number }) {
  const def = getItem(tokenId);
  const name = def?.name ?? "Item " + tokenId;
  const rarity = def?.rarity;
  const title = rarity ? `${name} [${rarity}]` : name;
  const statsLine = formatPrimaryEffects(def?.stats, def?.consume?.hp);
  const jobsLine = formatJobs(def?.jobRestrict);
  const ilevel = def?.craftLevel;
  return (
    <>
      <img
        src={itemIcon(tokenId)}
        alt=""
        width={36}
        height={36}
        className="equip-item-icon item-hover-icon"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.opacity = "0.25";
        }}
      />
      <div className="item-hover-copy">
        <div className="skill-tip-title">{title}</div>
        {statsLine ? <div className="equip-item-stats">{statsLine}</div> : null}
        {(ilevel != null || jobsLine) && (
          <div className="equip-item-meta">
            {ilevel != null && <span className="equip-item-ilevel">iLv. {ilevel}</span>}
            {jobsLine ? <span className="equip-item-jobs">{jobsLine}</span> : null}
          </div>
        )}
      </div>
    </>
  );
}

/** Hover (and keyboard focus) detail for a catalog item. Omitted fields are not rendered. */
export function ItemTipHost({
  tokenId,
  className,
  active = true,
  children,
}: {
  tokenId: number;
  className?: string;
  active?: boolean;
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    if (!anchor) return;
    const hide = () => setAnchor(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [anchor]);

  const show = active && anchor != null;

  return (
    <div
      className={className ? "item-tip-host " + className : "item-tip-host"}
      onPointerEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAnchor({ top: r.top, left: r.left, bottom: r.bottom });
      }}
      onPointerLeave={() => setAnchor(null)}
      onFocusCapture={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAnchor({ top: r.top, left: r.left, bottom: r.bottom });
      }}
      onBlurCapture={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setAnchor(null);
      }}
    >
      {children}
      {show &&
        createPortal(
          <div className="skill-tip item-hover-tip" role="tooltip" style={tipStyle(anchor)}>
            <ItemCatalogDetails tokenId={tokenId} />
            <UsedInRecipes tokenId={tokenId} compact />
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Tooltip shows this many recipe results, then "+N more". */
const USED_IN_TIP_LIMIT = 3;
/** Detail view renders this many rows before "Show all". */
const USED_IN_DETAIL_LIMIT = 12;

/** Recipes using this item, with live have/need from the player's bag and gathered materials. */
function useUsedIn(tokenId: number): UsedInRecipe[] {
  const inventory = useGame((s) => s.snapshot?.you?.inventory);
  const baseMats = useGame((s) => s.snapshot?.you?.baseMats);
  const craftSkills = useGame((s) => s.snapshot?.you?.craftSkills);
  const slug = getItem(tokenId)?.slug;
  return useMemo(
    () => (slug ? usedInRecipes(slug, inventory ?? [], baseMats ?? {}, craftSkills ?? {}) : []),
    [slug, inventory, baseMats, craftSkills],
  );
}

function resultLabel(row: UsedInRecipe): string {
  return row.outputQty > 1 ? row.def.name + " x" + row.outputQty : row.def.name;
}

/**
 * "Used in" crafting recipes for a material or component (#211). Read-only.
 * `compact` is the hover summary; otherwise every recipe with ingredients and have/need.
 * Renders nothing for items no recipe uses.
 */
export function UsedInRecipes({ tokenId, compact = false }: { tokenId: number; compact?: boolean }) {
  const rows = useUsedIn(tokenId);
  const [showAll, setShowAll] = useState(false);
  if (rows.length === 0) return null;

  if (compact) {
    const shown = rows.slice(0, USED_IN_TIP_LIMIT);
    const more = rows.length - shown.length;
    return (
      <div className="used-in used-in--tip">
        <div className="used-in-label">Used in</div>
        {shown.map((row) => (
          <div key={row.def.id} className={row.haveAllMaterials ? "used-in-tip-line ready" : "used-in-tip-line"}>
            {row.haveAllMaterials ? <span className="used-in-ready" aria-label="You have every ingredient">{"\u2713 "}</span> : null}
            {resultLabel(row)}
          </div>
        ))}
        {more > 0 && <div className="used-in-more">+{more} more</div>}
      </div>
    );
  }

  const shown = showAll ? rows : rows.slice(0, USED_IN_DETAIL_LIMIT);
  return (
    <div className="used-in used-in--detail" aria-label="Recipes that use this item">
      <div className="used-in-label">
        Used in {rows.length} recipe{rows.length === 1 ? "" : "s"}
      </div>
      <div className="used-in-list">
        {shown.map((row) => (
          <div key={row.def.id} className={row.haveAllMaterials ? "used-in-row ready" : "used-in-row"}>
            <img
              src={itemIcon(row.def.id)}
              alt=""
              width={24}
              height={24}
              className="used-in-icon"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.opacity = "0.25";
              }}
            />
            <div className="used-in-body">
              <div className="used-in-name">
                {row.haveAllMaterials ? <span className="used-in-ready" aria-label="You have every ingredient">{"\u2713 "}</span> : null}
                {resultLabel(row)}
              </div>
              <div className="used-in-skill" style={{ color: row.skillLevel >= row.needLevel ? undefined : "#d4a070" }}>
                {CRAFT_SKILL_LABEL[row.craftSkill]} Lv.{row.needLevel}
                {row.skillLevel < row.needLevel ? " (you " + row.skillLevel + ")" : ""}
              </div>
              <div className="used-in-mats">
                {row.groups.map((g, gi) => (
                  <span key={gi} className="used-in-group">
                    {g.options.map((m, mi) => (
                      <span key={m.slug}>
                        {mi > 0 ? <span className="used-in-or"> or </span> : null}
                        <span className={m.ok ? "used-in-have ok" : "used-in-have"}>
                          {m.name} {m.have}/{m.qty}
                        </span>
                      </span>
                    ))}
                    {gi < row.groups.length - 1 ? <span className="used-in-sep"> {"\u00b7"} </span> : null}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      {rows.length > shown.length && (
        <button type="button" className="cmd-pill-tab used-in-all" onClick={() => setShowAll(true)}>
          Show all {rows.length}
        </button>
      )}
    </div>
  );
}
