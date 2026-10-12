import type {
  AbilityId,
  CharacterMintClientConfig,
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
  /** Factory the wallet must call to mint LOKC. Null when this server has none. */
  characterMint: CharacterMintClientConfig | null;
  /** True after submitting char/create — next matching snapshot may enter play. */
  pendingCreateEnter: boolean;
  snapshot: SnapshotMessage | null;
  logs: string[];
  selectedTarget: string | null;
  npcDialog: NpcDialog | null;
  explorer: ExplorerView | null;
  setPhase: (p: Phase) => void;
  setWallet: (w: string | null) => void;
  setConnected: (c: boolean) => void;
  setHasCharacter: (h: boolean) => void;
  setCharacters: (c: CharacterPreview[]) => void;
  setSelectedCharId: (id: string | null) => void;
  setCharacterPreview: (c: GameState["characterPreview"]) => void;
  setCharacterMint: (c: CharacterMintClientConfig | null) => void;
  setCharacterNft: (characterId: string, nftTokenId: string) => void;
  setPendingCreateEnter: (v: boolean) => void;
  setSnapshot: (s: SnapshotMessage) => void;
  clearSnapshot: () => void;
  pushLog: (m: string) => void;
  setSelectedTarget: (id: string | null) => void;
  setNpcDialog: (d: NpcDialog | null) => void;
  setExplorer: (page: ExplorerView) => void;
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
  characterMint: null,
  pendingCreateEnter: false,
  snapshot: null,
  logs: [],
  selectedTarget: null,
  npcDialog: null,
  explorer: null,
  setPhase: (phase) => set({ phase }),
  setWallet: (wallet) => set({ wallet: wallet ? wallet.toLowerCase() : null }),
  setConnected: (connected) => set({ connected }),
  setHasCharacter: (hasCharacter) => set({ hasCharacter }),
  setCharacters: (characters) => set({ characters, hasCharacter: characters.length > 0 }),
  setSelectedCharId: (selectedCharId) => set({ selectedCharId }),
  setCharacterPreview: (characterPreview) => set({ characterPreview }),
  setCharacterMint: (characterMint) => set({ characterMint }),
  setCharacterNft: (characterId, nftTokenId) =>
    set((s) => ({
      characters: s.characters.map((c) => (c.id === characterId ? { ...c, nftTokenId } : c)),
      characterPreview:
        s.characterPreview?.id === characterId ? { ...s.characterPreview, nftTokenId } : s.characterPreview,
      snapshot:
        s.snapshot?.you.characterId === characterId
          ? { ...s.snapshot, you: { ...s.snapshot.you, nftTokenId } }
          : s.snapshot,
    })),
  setPendingCreateEnter: (pendingCreateEnter) => set({ pendingCreateEnter }),
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
    set({
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
  me: () => {
    const s = get().snapshot;
    const w = get().wallet;
    if (!s || !w) return null;
    return s.units.find((u) => u.id.toLowerCase() === w.toLowerCase() && u.kind === "player") ?? null;
  },
}));

export type { AbilityId };
