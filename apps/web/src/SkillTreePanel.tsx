import {
  JOBS,
  JOB_IDS,
  SKILL_HUBS,
  SKILL_NODES,
  SKILL_POINTS_CAP,
  SKILL_PRESTIGE_CAP,
  canUnlockSkillNode,
  freeSkillHubs,
  skillHubForJob,
  skillPointsEarned,
  skillNodeCost,
  skillPointsSpentOnTree,
  type JobId,
  type SkillNode,
} from "@bellgrave/combat";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import { send } from "./net";
import { skillTreeRenderSet, type SkillTreeFocus } from "./skillTreeRender";
import { useGame } from "./state";

const JOB_COLOR: Record<JobId, string> = {
  time_mage: "#2f8f84",
  knight: "#9a8f7a",
  rogue: "#7a5088",
  cleric: "#8ab0d8",
  sorcerer: "#6a5aa8",
  fighter: "#a04838",
  battle_mage: "#4a8a7a",
};

const VIEW_W = 5200;
const VIEW_H = 5200;
const VIEW_OX = -VIEW_W / 2;
const VIEW_OY = -VIEW_H / 2;

/** Visual weight: small minor / medium notable / large keystone hub. */
function nodeRadius(n: SkillNode): number {
  if (n.hub) return 26;
  if (n.id.startsWith("nexus_")) return 14;
  if (n.rarity === "gem") return 13;
  if (n.rarity === "rare") return 11;
  if (n.rarity === "uncommon") return 8.5;
  return 5.5;
}

function nodeWeightClass(n: SkillNode): string {
  if (n.hub) return "weight-keystone";
  if (n.id.startsWith("nexus_") || n.rarity === "gem" || n.rarity === "rare") return "weight-notable";
  if (n.rarity === "uncommon") return "weight-minor-plus";
  return "weight-minor";
}

type Props = { onClose: () => void };

function formatBonus(k: string, v: number): string {
  if (k === "hastePct" || k === "crit" || k === "movePct" || k === "physDt" || k === "magDt") {
    return `+${(v * 100).toFixed(1)}%`;
  }
  return `+${v}`;
}

function bonusLabel(k: string): string {
  const map: Record<string, string> = {
    str: "STR",
    dex: "DEX",
    vit: "VIT",
    agi: "AGI",
    int: "INT",
    mnd: "MND",
    maxHp: "Max HP",
    maxMp: "Max MP",
    restHp: "Rest HP",
    restMp: "Rest MP",
    atk: "Attack",
    acc: "Accuracy",
    hastePct: "Haste",
    crit: "Crit",
    physDt: "Phys resist",
    magDt: "Magic resist",
    movePct: "Move speed",
  };
  return map[k] ?? k;
}

export function SkillTreePanel({ onClose }: Props) {
  const you = useGame((s) => s.snapshot?.you);
  const mapRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(0.42);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(
    null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<SkillTreeFocus>("path");
  const [district, setDistrict] = useState<JobId | "all">("all");

  const nodes = useMemo(() => Object.values(SKILL_NODES), []);
  const unlocked = useMemo(() => new Set(you?.skillUnlocked ?? []), [you?.skillUnlocked]);
  const hubId = you ? skillHubForJob(you.job) : null;
  const subHubId = you?.subjob ? skillHubForJob(you.subjob) : null;
  const freeHubs = useMemo(
    () => new Set(you ? freeSkillHubs(you.job, you.subjob, you.skillUnlocked) : []),
    [you?.job, you?.subjob, you?.skillUnlocked],
  );
  const spent = you ? skillPointsSpentOnTree(you.skillUnlocked, you.job, you.subjob) : 0;
  const earned = you ? skillPointsEarned(you.level, you.skillPrestige) : 0;
  const remaining =
    you && typeof you.skillPoints === "number"
      ? Math.max(0, you.skillPoints)
      : Math.max(0, earned - spent);
  const selectedNode = selected ? SKILL_NODES[selected] : null;

  const districts = useMemo(() => {
    return JOB_IDS.map((job) => {
      const hub = SKILL_NODES[SKILL_HUBS[job]]!;
      const owned = nodes.filter((n) => n.job === job && unlocked.has(n.id)).length;
      const total = nodes.filter((n) => n.job === job && !n.id.startsWith("nexus_")).length;
      return { job, hub, owned, total, color: JOB_COLOR[job] };
    });
  }, [nodes, unlocked]);

  const rendered = useMemo(
    () => skillTreeRenderSet(nodes, focus, district),
    [nodes, focus, district],
  );

  const flyTo = (x: number, y: number, z = 0.95) => {
    const el = mapRef.current;
    const w = el?.clientWidth ?? 800;
    const h = el?.clientHeight ?? 520;
    setZoom(z);
    setPan({ x: w / 2 - x * z, y: h / 2 - y * z });
  };

  // Open / main-job change: center on main heart. Never recenter when only support changes.
  useEffect(() => {
    if (!hubId) return;
    const hub = SKILL_NODES[hubId];
    if (!hub) return;
    requestAnimationFrame(() => flyTo(hub.x, hub.y, 0.92));
    setSelected(hubId);
    setDistrict(you?.job ?? "all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubId]);

  if (!you) return null;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // Don't start a pan when pressing a node — pointer capture would eat the click.
    const t = e.target as Element | null;
    if (t?.closest?.(".st-node")) return;
    drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y, moved: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    setPan({ x: drag.current.panX + dx, y: drag.current.panY + dy });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const el = mapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldX = (mx - pan.x) / zoom;
    const worldY = (my - pan.y) / zoom;
    const next = Math.min(1.85, Math.max(0.18, zoom * (e.deltaY > 0 ? 0.9 : 1.12)));
    setZoom(next);
    setPan({ x: mx - worldX * next, y: my - worldY * next });
  };

  const selectNode = (id: string) => {
    setSelected(id);
  };

  const lod = zoom < 0.32 ? "far" : zoom < 0.7 ? "mid" : "near";

  return (
    <div className="skill-tree-overlay">
      <div className="skill-tree-panel skill-tree-panel--map">
        <header className="skill-tree-head">
          <div className="skill-tree-head-main">
            <div className="cmd-kicker">Mastery</div>
            <div className="skill-tree-title">Master Skill Tree</div>
            <div className="skill-tree-meter" title="Points available / lifetime cap">
              <div className="skill-tree-meter-fill" style={{ width: `${(remaining / Math.max(1, earned)) * 100}%` }} />
              <span>
                {remaining} banked · {spent} spent · {earned}/{SKILL_POINTS_CAP}
                {you.level >= 75 ? ` · echoes ${you.skillPrestige}/${SKILL_PRESTIGE_CAP}` : ""}
              </span>
            </div>
          </div>
          <div className="skill-tree-head-actions">
            <div className="skill-tree-focus">
              {(
                [
                  ["path", "My path"],
                  ["district", "District"],
                  ["all", "All nodes"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={focus === id ? "on" : ""}
                  onClick={() => setFocus(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button type="button" className="cmd-close-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="skill-tree-workspace">
          <nav className="skill-tree-districts" aria-label="Job districts">
            <p className="skill-tree-nav-label">Districts</p>
            <button
              type="button"
              className={district === "all" ? "skill-tree-district on" : "skill-tree-district"}
              onClick={() => {
                setDistrict("all");
                if (hubId) {
                  const h = SKILL_NODES[hubId]!;
                  flyTo(h.x, h.y, 0.22);
                }
              }}
            >
              <i style={{ background: "#8a8070" }} />
              <span>Whole web</span>
              <small>overview</small>
            </button>
            {districts.map((d) => (
              <button
                key={d.job}
                type="button"
                className={[
                  "skill-tree-district",
                  district === d.job ? "on" : "",
                  d.job === you.job ? "home" : "",
                  d.job === you.subjob ? "support" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  setDistrict(d.job);
                  setFocus("district");
                  flyTo(d.hub.x, d.hub.y, 0.95);
                  setSelected(d.hub.id);
                }}
              >
                <i style={{ background: d.color }} />
                <span>{JOBS[d.job].name}</span>
                <small>
                  {d.owned}/{d.total}
                  {d.job === you.job ? " · main" : ""}
                  {d.job === you.subjob ? " · support" : ""}
                </small>
              </button>
            ))}
          </nav>

          <div
            ref={mapRef}
            className="skill-tree-map"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onWheel={onWheel}
          >
            <svg className="skill-tree-svg">
              <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                {/* District plates — roomy islands with empty space between */}
                {districts.map((d) => (
                  <g key={`plate-${d.job}`} opacity={district === "all" || district === d.job ? 1 : 0.18}>
                    <circle
                      cx={d.hub.x}
                      cy={d.hub.y}
                      r={420}
                      fill={d.color}
                      opacity={0.055}
                    />
                    <circle
                      cx={d.hub.x}
                      cy={d.hub.y}
                      r={420}
                      fill="none"
                      stroke={d.color}
                      strokeWidth={2.5}
                      opacity={0.2}
                      strokeDasharray="8 14"
                    />
                    {lod !== "near" && (
                      <text
                        x={d.hub.x}
                        y={d.hub.y - 455}
                        textAnchor="middle"
                        className="skill-tree-district-label"
                        fill={d.color}
                      >
                        {JOBS[d.job].name}
                      </text>
                    )}
                  </g>
                ))}

                {/* Edges come from the tree definition, including links to unowned nodes. */}
                {rendered.edges.map(({ a, b, bridge }) => {
                  const lit = unlocked.has(a.id) && unlocked.has(b.id);
                  const soft = unlocked.has(a.id) || unlocked.has(b.id);
                  return (
                    <line
                      key={`${a.id}-${b.id}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      className={
                        lit
                          ? "st-edge lit"
                          : soft
                            ? "st-edge soft"
                            : bridge
                              ? "st-edge bridge"
                              : "st-edge"
                      }
                    />
                  );
                })}

                {rendered.nodes.map((n) => {
                  const owned = unlocked.has(n.id);
                  const reachable = !owned && canUnlockSkillNode(n.id, unlocked);
                  const r = nodeRadius(n);
                  const tip = `${n.label}${owned ? " · unlocked" : reachable ? " · available" : " · locked"}`;
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${n.x},${n.y})`}
                      style={{ ["--st-job"]: JOB_COLOR[n.job] } as CSSProperties}
                      className={[
                        "st-node",
                        nodeWeightClass(n),
                        owned ? "owned" : "",
                        reachable ? "reachable" : "",
                        !owned && !reachable ? "locked" : "",
                        n.hub ? "hub" : "",
                        selected === n.id ? "selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectNode(n.id);
                      }}
                    >
                      <title>{tip}</title>
                      {reachable && <circle r={r + 8} className="st-node-pulse" />}
                      {n.hub && <circle r={r + 7} className="st-node-ornate" />}
                      {(n.rarity === "gem" || n.rarity === "rare" || n.id.startsWith("nexus_")) &&
                        !n.hub && <circle r={r + 4} className="st-node-ornate st-node-ornate--notable" />}
                      <circle r={r + (n.hub ? 3.5 : 2)} className="st-node-ring" />
                      <circle r={r} className="st-node-core" />
                      {n.hub && (
                        <text y={r + 22} textAnchor="middle" className="st-hub-caption">
                          {JOBS[n.job].name}
                          {n.id === hubId ? " · main" : n.id === subHubId ? " · support" : ""}
                        </text>
                      )}
                      {!n.hub &&
                        (lod === "near" ||
                          selected === n.id ||
                          (lod === "mid" && (n.rarity === "rare" || n.rarity === "gem" || n.id.startsWith("nexus_")))) && (
                        <text y={r + 14} textAnchor="middle" className="st-node-label">
                          {n.label}
                        </text>
                      )}
                      {(n.rarity === "gem" || n.id.startsWith("nexus_")) && !n.hub && (
                        <text y={1} textAnchor="middle" className="st-gem-mark">
                          ◆
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>

            <div className="skill-tree-map-hint">
              Drag to pan · scroll to zoom · click a node · unlock in the side panel
            </div>

            {/* Minimap */}
            <div className="skill-tree-minimap" aria-hidden>
              <svg viewBox={`${VIEW_OX} ${VIEW_OY} ${VIEW_W} ${VIEW_H}`}>
                {districts.map((d) => (
                  <circle
                    key={d.job}
                    cx={d.hub.x}
                    cy={d.hub.y}
                    r={160}
                    fill={d.color}
                    opacity={0.4}
                  />
                ))}
                {nodes.map((n) => (
                  <circle
                    key={n.id}
                    cx={n.x}
                    cy={n.y}
                    r={unlocked.has(n.id) ? 14 : n.hub ? 18 : 7}
                    className={unlocked.has(n.id) ? "st-minimap-owned" : "st-minimap-node"}
                  />
                ))}
              </svg>
            </div>
          </div>

          <aside className="skill-tree-detail">
            <button type="button" className="cmd-mini-btn" onClick={() => send({ type: "skill/respec" })}>
              Respec (10000 KEK)
            </button>
            {selectedNode ? (
              <>
                <div className="skill-tree-detail-kicker">Node detail</div>
                <div
                  className="skill-tree-detail-job"
                  style={{ borderColor: JOB_COLOR[selectedNode.job] }}
                >
                  {JOBS[selectedNode.job].name} district
                </div>
                <h3>
                  {selectedNode.label}
                  {selectedNode.hub && selectedNode.id === hubId
                    ? " (main)"
                    : selectedNode.hub && selectedNode.id === subHubId
                      ? " (support)"
                      : ""}
                </h3>
                <p className="skill-tree-rarity">{selectedNode.rarity}</p>
                <div className="skill-tree-detail-card">
                  <div className="skill-tree-detail-card-label">Description</div>
                  <p className="skill-tree-blurb" style={{ margin: 0 }}>
                    {selectedNode.blurb}
                  </p>
                </div>
                <div className="skill-tree-detail-card-label">Bonuses</div>
                <ul className="skill-tree-bonuses">
                  {Object.entries(selectedNode.bonus).map(([k, v]) =>
                    typeof v === "number" && v !== 0 ? (
                      <li key={k}>
                        <span>{bonusLabel(k)}</span>
                        <strong>{formatBonus(k, v)}</strong>
                      </li>
                    ) : null,
                  )}
                </ul>
                {unlocked.has(selectedNode.id) ? (
                  <div className="skill-tree-status owned">
                    {selectedNode.hub
                      ? freeHubs.has(selectedNode.id)
                        ? selectedNode.id === hubId
                          ? `Main heart · free — keep your ${JOBS[you.job].name} path; support adds another heart`
                          : selectedNode.id === subHubId
                            ? "Support heart · free — your main path is unchanged"
                            : "Heart unlocked · free"
                        : "Heart open — linked skills available to unlock"
                      : "Unlocked"}
                  </div>
                ) : canUnlockSkillNode(selectedNode.id, unlocked) ? (
                  <button
                    type="button"
                    className="cmd-mini-btn on skill-tree-unlock"
                    disabled={remaining < skillNodeCost(selectedNode.id)}
                    onClick={() => send({ type: "skill/unlock", nodeId: selectedNode.id })}
                  >
                    {skillNodeCost(selectedNode.id) === 0
                      ? "Unlock · free heart"
                      : remaining >= skillNodeCost(selectedNode.id)
                        ? `Unlock · ${skillNodeCost(selectedNode.id)} point`
                        : "No points left"}
                  </button>
                ) : (
                  <div className="skill-tree-status locked">Reach a connected node first</div>
                )}
              </>
            ) : (
              <div className="skill-tree-empty">
                <div className="skill-tree-detail-kicker">Path</div>
                <h3>Your path</h3>
                <p>
                  You begin at the <strong>{JOBS[you.job].name}</strong> heart. Spend points on glowing
                  neighbors, then follow corridors into other districts for their bonuses.
                </p>
                <button
                  type="button"
                  className="cmd-close-btn"
                  onClick={() => {
                    if (!hubId) return;
                    const h = SKILL_NODES[hubId]!;
                    flyTo(h.x, h.y, 0.95);
                    setSelected(hubId);
                  }}
                >
                  Jump home
                </button>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
