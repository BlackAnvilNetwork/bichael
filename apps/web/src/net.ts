import type { ClientMessage, ServerMessage } from "@bellgrave/protocol";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { useGame } from "./state";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";
const HEARTBEAT_MS = 20_000;
const RESUME_KEY = "bellgrave.resumeChar";
const WALLET_KEY = "bellgrave.wallet";
const PK_KEY = "bellgrave.walletKey";

let socket: WebSocket | null = null;
let authedWallet: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
/** Character to re-enter after a soft disconnect while in play. */
let resumeCharId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;
/** User chose Logout — drop the live session and do not auto-enter the character. */
let intentionalLogout = false;
let authInFlight = false;

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "ping", t: Date.now() } satisfies ClientMessage));
  }, HEARTBEAT_MS);
}

function rememberResume() {
  if (intentionalLogout) return;
  const g = useGame.getState();
  if (g.phase === "play" && g.selectedCharId) {
    resumeCharId = g.selectedCharId;
    try {
      localStorage.setItem(RESUME_KEY, g.selectedCharId);
    } catch {
      /* ignore */
    }
  }
}

function consumeResumeId(rosterIds: string[]): string | null {
  const stored = resumeCharId ?? (() => {
    try {
      return localStorage.getItem(RESUME_KEY);
    } catch {
      return null;
    }
  })();
  resumeCharId = null;
  if (!stored) return null;
  if (!rosterIds.includes(stored)) return null;
  return stored;
}

function clearResumeStorage() {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    /* ignore */
  }
}

/** Local anvil-style account kept in this browser. Never logged. */
function localAccount(): PrivateKeyAccount {
  let key = localStorage.getItem(PK_KEY);
  const existingWallet = localStorage.getItem(WALLET_KEY);
  // Migrate mock 0xmvp… ids to a real secp256k1 account.
  if (!key || !existingWallet || !/^0x[0-9a-fA-F]{40}$/.test(existingWallet)) {
    key = generatePrivateKey();
    localStorage.setItem(PK_KEY, key);
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  localStorage.setItem(WALLET_KEY, account.address);
  return account;
}

export function mockWallet(): string {
  return localAccount().address;
}

function tryAutoAuth() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (authInFlight) return;
  const account = localAccount();
  const w = account.address.toLowerCase();
  if (authedWallet === w && useGame.getState().wallet) return;
  authInFlight = true;
  useGame.getState().setWallet(account.address);
  socket.send(JSON.stringify({ type: "auth/hello", wallet: account.address } satisfies ClientMessage));
}

async function completeSignedAuth(msg: Extract<ServerMessage, { type: "auth/challenge" }>) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    authInFlight = false;
    return;
  }
  try {
    const account = localAccount();
    if (account.address.toLowerCase() !== msg.wallet.toLowerCase()) {
      useGame.getState().pushLog("Error: Wallet mismatch on login challenge.");
      authInFlight = false;
      return;
    }
    const signature = await account.signMessage({ message: msg.message });
    authedWallet = account.address.toLowerCase();
    socket.send(
      JSON.stringify({
        type: "auth",
        wallet: account.address,
        signature,
        nonce: msg.nonce,
        message: msg.message,
      } satisfies ClientMessage),
    );
  } catch {
    useGame.getState().pushLog("Error: Could not sign the login challenge.");
    authInFlight = false;
  }
}

function bindVisibility() {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      connectSocket();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ping", t: Date.now() } satisfies ClientMessage));
    }
  });
}

export function connectSocket() {
  bindVisibility();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return socket;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  rememberResume();
  socket = new WebSocket(WS_URL);
  socket.addEventListener("open", () => {
    useGame.getState().setConnected(true);
    useGame.getState().pushLog("Connected to Bellgrave server.");
    startHeartbeat();
    tryAutoAuth();
  });
  socket.addEventListener("close", () => {
    clearHeartbeat();
    useGame.getState().setConnected(false);
    authedWallet = null;
    authInFlight = false;
    const wasLogout = intentionalLogout;
    intentionalLogout = false;
    if (!wasLogout) rememberResume();
    useGame.getState().pushLog(wasLogout ? "Logged out." : "Disconnected. Reconnecting…");
    reconnectTimer = setTimeout(connectSocket, wasLogout ? 0 : 1200);
  });
  socket.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerMessage;
    const g = useGame.getState();
    if (msg.type === "pong") {
      return;
    }
    if (msg.type === "auth/challenge") {
      void completeSignedAuth(msg);
      return;
    }
    if (msg.type === "auth/ok") {
      authInFlight = false;
      g.setWallet(msg.wallet);
      g.setPendingCreateEnter(false);
      const list =
        msg.characters?.length > 0
          ? msg.characters
          : msg.character
            ? [msg.character]
            : [];
      g.setCharacters(list);
      g.setHasCharacter(list.length > 0 || msg.hasCharacter);
      const primary = msg.character ?? list[0] ?? null;
      g.setCharacterPreview(primary);

      const resumeId = consumeResumeId(list.map((c) => c.id));
      if (resumeId) {
        g.setSelectedCharId(resumeId);
        g.setPhase("play");
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ type: "char/enter", characterId: resumeId } satisfies ClientMessage),
          );
        }
        return;
      }

      clearResumeStorage();
      g.clearSnapshot();
      g.setSelectedCharId(primary?.id ?? null);
      g.setPhase(list.length > 0 || msg.hasCharacter ? "select" : "create");
    } else if (msg.type === "snapshot") {
      g.setSnapshot(msg);
      if (!intentionalLogout && g.phase === "play" && msg.you.characterId) {
        try {
          localStorage.setItem(RESUME_KEY, msg.you.characterId);
        } catch {
          /* ignore */
        }
      }
      if (g.phase === "play") {
        if (g.pendingCreateEnter) {
          g.setPendingCreateEnter(false);
        }
        return;
      }
      const preview = {
        id: msg.you.characterId,
        name: msg.you.name,
        job: msg.you.job,
        level: msg.you.level,
        gender: msg.you.gender ?? "male",
      };
      g.setCharacterPreview(preview);
      g.setSelectedCharId(preview.id);
      g.setHasCharacter(true);
      const others = g.characters.filter((c) => c.id !== preview.id);
      g.setCharacters([...others, preview]);
      if (g.pendingCreateEnter) {
        g.setPendingCreateEnter(false);
        g.setPhase("play");
      }
    } else if (msg.type === "log") {
      g.pushLog(msg.message);
    } else if (msg.type === "error") {
      authInFlight = false;
      g.pushLog(`Error: ${msg.message}`);
    } else if (msg.type === "party/invite") {
      g.pushLog(`${msg.fromName} invited you to a party — open Party to accept.`);
    } else if (msg.type === "lok/events") {
      g.setExplorer(msg);
    } else if (msg.type === "npc/dialog") {
      g.setNpcDialog({
        npcId: msg.npcId,
        title: msg.title,
        body: msg.body,
        jobs: msg.jobs,
        spells: msg.spells,
        subjobMode: msg.subjobMode,
        subLevel: msg.subLevel,
        craftOpen: msg.craftOpen,
        lokOpen: msg.lokOpen,
      });
    }
  });
  return socket;
}

/**
 * Leave the world: close the socket so the server parks the character,
 * forget the resume target, then reconnect onto character select (or create).
 */
export function logoutToMenu() {
  if (intentionalLogout) return;
  intentionalLogout = true;
  resumeCharId = null;
  clearResumeStorage();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const g = useGame.getState();
  g.setPendingCreateEnter(false);
  g.setNpcDialog(null);
  g.clearSnapshot();
  g.setPhase(g.characters.length > 0 || g.hasCharacter ? "select" : "create");

  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    socket.close();
    return;
  }
  intentionalLogout = false;
  connectSocket();
}

export function send(msg: ClientMessage) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    useGame.getState().pushLog("Not connected.");
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      connectSocket();
    }
    return;
  }
  socket.send(JSON.stringify(msg));
}
