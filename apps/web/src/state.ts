import type {
  AbilityId,
  CharacterPreview,
  JobId,
  LokEventView,
  LokExploreScope,
  SnapshotMessage,
  SpellOffer,
  UnitSnapshot,
} from "@bellgrave/protocol";
import { create } from "zustand";

type Phase = "boot" | "auth" | "create" | "select" | "play";

export type ExplorerView = {
  scope: LokExploreScope;
  q: string;
  beforeSeq?: number;
  req?: number;
  events: LokEventView[];
  total: number;
  hasMore: boolean;
};

export type NpcDialog = {
  npcId: string;
  title: string;
  body: string;
  jobs?: JobId[];
  spells?: SpellOffer[];
  subjobMode?: boolean;
  subLevel?: number;
  craftOpen?: boolean;
  lokOpen?: boolean;
};

type GameState = {
  phase: Phase;
  wallet: string | null;
  connected: boolean;
  hasCharacter: boolean;
  characters: CharacterPreview[];
  selectedCharId: string | null;
  characterPreview: CharacterPreview | null;
  /** True after submitting char/create — next matching snapshot may enter play. */
  pendingCreateEnter: boolean;
  /** Mint fee config from auth/ok (available before any character snapshot). */
  characterMint: {
    factory: string;
    nft: string;
    mintFee: string;
    chainId: number;
    rpcUrl: string;
    supportsCreateFor?: boolean;
    suggestedTokenId?: string;
    startingJobs?: number[];
    devFaucet?: boolean;
    devServerMint?: boolean;
    currency?: {
      chainId: number;
      symbol: string;
      name: string;
      decimals: number;
      defaultMintFeeWei: string;
      exampleAskHuman: string;
    };
  } | null;
  snapshot: SnapshotMessage | null;
  logs: string[];
  selectedTarget: string | null;
  npcDialog: NpcDialog | null;
  explorer: ExplorerView | null;
  /** After a PvP bounty loss — show rejoin CTA until dismissed or joined. */
  pvpSlainPrompt: {
    slayerName: string;
    bountyWei: string;
    areaId: string;
  } | null;
  setPhase: (p: Phase) => void;
  setWallet: (w: string | null) => void;
  setConnected: (c: boolean) => void;
  setHasCharacter: (h: boolean) => void;
  setCharacters: (c: CharacterPreview[]) => void;
  setSelectedCharId: (id: string | null) => void;
  setCharacterPreview: (c: GameState["characterPreview"]) => void;
  setPendingCreateEnter: (v: boolean) => void;
  setCharacterMint: (c: GameState["characterMint"]) => void;
  setSnapshot: (s: SnapshotMessage) => void;
  clearSnapshot: () => void;
  pushLog: (m: string) => void;
  setSelectedTarget: (id: string | null) => void;
  setNpcDialog: (d: NpcDialog | null) => void;
  setExplorer: (page: ExplorerView) => void;
  setPvpSlainPrompt: (p: GameState["pvpSlainPrompt"]) => void;
  me: () => UnitSnapshot | null;
};

export const useGame = create<GameState>((set, get) => ({
  phase: "boot",
  wallet: null,
  connected: false,
  hasCharacter: false,
  characters: [],
  selectedCharId: null,
  characterPreview: null,
  pendingCreateEnter: false,
  characterMint: null,
  snapshot: null,
  logs: [],
  selectedTarget: null,
  npcDialog: null,
  explorer: null,
  pvpSlainPrompt: null,
  setPhase: (phase) => set({ phase }),
  setWallet: (wallet) => set({ wallet: wallet ? wallet.toLowerCase() : null }),
  setConnected: (connected) => set({ connected }),
  setHasCharacter: (hasCharacter) => set({ hasCharacter }),
  setCharacters: (characters) => set({ characters, hasCharacter: characters.length > 0 }),
  setSelectedCharId: (selectedCharId) => set({ selectedCharId }),
  setCharacterPreview: (characterPreview) => set({ characterPreview }),
  setPendingCreateEnter: (pendingCreateEnter) => set({ pendingCreateEnter }),
  setCharacterMint: (characterMint) => set({ characterMint }),
  clearSnapshot: () => set({ snapshot: null, selectedTarget: null, explorer: null }),
  setSnapshot: (snapshot) => {
    const prev = get().snapshot;
    // Skip identical-tick no-ops (reconnect / duplicate floods).
    if (prev && prev.tick === snapshot.tick) return;
    const w = get().wallet?.toLowerCase();
    const me = w
      ? snapshot.units.find((u) => u.id.toLowerCase() === w && u.kind === "player")
      : undefined;
    // Keep local UI selection (ally heals/buffs) across ticks (#70).
    // Snapshots previously stomped selectedTarget with server combat targetId every tick.
    const prevSelected = get().selectedTarget;
    const stillValid =
      !!prevSelected && snapshot.units.some((u) => u.id === prevSelected);
    const serverTarget = me?.targetId ?? null;
    const serverTargetChanged =
      !!prev &&
      !!me &&
      (prev.units.find((u) => u.id.toLowerCase() === w && u.kind === "player")?.targetId ??
        null) !== serverTarget;
    let selectedTarget: string | null;
    if (serverTargetChanged && serverTarget) {
      // Player engaged a new mob (or server cleared/retargeted combat) — follow it.
      selectedTarget = serverTarget;
    } else if (stillValid) {
      selectedTarget = prevSelected;
    } else {
      selectedTarget = serverTarget;
    }
    const mint = snapshot.you?.lok?.characterMint;
    set({
      ...(mint !== undefined ? { characterMint: mint ?? null } : {}),
      snapshot,
      logs: snapshot.log ?? prev?.log ?? get().logs,
      selectedTarget,
    });
  },
  pushLog: (message) =>
    set((s) => ({ logs: [...s.logs.slice(-30), message] })),
  setSelectedTarget: (selectedTarget) => set({ selectedTarget }),
  setNpcDialog: (npcDialog) => set({ npcDialog }),
  setExplorer: (explorer) => set({ explorer }),
  setPvpSlainPrompt: (pvpSlainPrompt) => set({ pvpSlainPrompt }),
  me: () => {
    const s = get().snapshot;
    const w = get().wallet;
    if (!s || !w) return null;
    return s.units.find((u) => u.id.toLowerCase() === w.toLowerCase() && u.kind === "player") ?? null;
  },
}));

/** Dev-only: console / visual QA can inject play snapshots without a wallet. */
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __useGame?: typeof useGame }).__useGame = useGame;
}

export type { AbilityId };
