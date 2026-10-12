import type { ClientMessage, ServerMessage } from "@bellgrave/protocol";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { clearPendingMint, clearPendingMintIfTokenBound } from "./pending-mint";
import { useGame } from "./state";
import { setPreferredPayoutWallet } from "./wallet";
import {
  appKitConfigured,
  connectWithAppKit,
  disconnectAppKit,
  sessionFromConnectedAppKit,
} from "./appkit";
import { connectInjectedWallet, injectedWalletAvailable } from "./injected-login";
import { defaultRpcUrl, walletConnectConfigured } from "./walletconnect";

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
let nameCheckWaiter:
  | {
      resolve: (r: { ok: true; name: string } | { ok: false; error: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | null = null;

/** External wallet used for auth challenge signing (injected / WalletConnect). */
type ExternalAuth = {
  address: `0x${string}`;
  signMessage: (message: string) => Promise<string>;
};
let externalAuth: ExternalAuth | null = null;

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

function beginAuthHello(address: `0x${string}`) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (authInFlight) return;
  const w = address.toLowerCase();
  if (authedWallet === w && useGame.getState().wallet) return;
  authInFlight = true;
  socket.send(JSON.stringify({ type: "auth/hello", wallet: address } satisfies ClientMessage));
}

function tryAutoAuth() {
  if (externalAuth) {
    beginAuthHello(externalAuth.address);
    return;
  }
  beginAuthHello(localAccount().address);
}

async function completeSignedAuth(msg: Extract<ServerMessage, { type: "auth/challenge" }>) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    authInFlight = false;
    return;
  }
  try {
    let signature: string;
    let wallet: `0x${string}`;
    if (externalAuth && externalAuth.address.toLowerCase() === msg.wallet.toLowerCase()) {
      wallet = externalAuth.address;
      signature = await externalAuth.signMessage(msg.message);
    } else {
      const account = localAccount();
      if (account.address.toLowerCase() !== msg.wallet.toLowerCase()) {
        useGame.getState().pushLog("Error: Wallet mismatch on login challenge.");
        authInFlight = false;
        return;
      }
      wallet = account.address;
      signature = await account.signMessage({ message: msg.message });
    }
    // Do not set authedWallet until auth/ok — signing alone is not a server session.
    socket.send(
      JSON.stringify({
        type: "auth",
        wallet,
        signature,
        nonce: msg.nonce,
        message: msg.message,
      } satisfies ClientMessage),
    );
  } catch {
    useGame.getState().pushLog("Error: Could not sign the login challenge.");
    authInFlight = false;
    authedWallet = null;
  }
}

/**
 * Connect home-chain wallet (Reown AppKit picker, or injected MetaMask without project id),
 * then re-auth as that wallet (replaces burner session). Login is sign-only — no forced switch.
 *
 * Never uses @walletconnect/ethereum-provider showQrModal (raw QR-only modal).
 */
export async function loginWithWalletConnect(opts?: {
  chainId?: number;
  rpcUrl?: string;
  /** When true, only adopt an already-connected AppKit account (Hud opened the modal). */
  appKitAlreadyOpen?: boolean;
}): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const chainId = opts?.chainId ?? Number(import.meta.env.VITE_CHAIN_ID ?? "100");
  const rpcUrl = opts?.rpcUrl ?? defaultRpcUrl(chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return { ok: false, error: "Bad VITE_CHAIN_ID for wallet login." };
  }
  try {
    let address: `0x${string}`;
    let signMessage: (message: string) => Promise<string>;

    if (appKitConfigured()) {
      const session = opts?.appKitAlreadyOpen
        ? await sessionFromConnectedAppKit()
        : await connectWithAppKit();
      address = session.address;
      signMessage = async (message) =>
        session.client.signMessage({ message, account: session.account });
      useGame.getState().pushLog("Wallet connected. Signing in…");
    } else if (injectedWalletAvailable()) {
      const session = await connectInjectedWallet({ chainId, rpcUrl, switchChain: false });
      address = session.address;
      signMessage = async (message) =>
        session.client.signMessage({ message, account: session.account });
      useGame.getState().pushLog("Browser wallet connected. Signing in…");
    } else {
      return {
        ok: false,
        error:
          "No wallet available. Set VITE_WALLETCONNECT_PROJECT_ID for Reown AppKit, or install MetaMask/Rabby.",
      };
    }

    setPreferredPayoutWallet(address);
    externalAuth = { address, signMessage };
    authedWallet = null;
    authInFlight = false;
    if (socket?.readyState === WebSocket.OPEN) {
      beginAuthHello(address);
    } else {
      connectSocket();
    }
    return { ok: true, address };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Connect is offered when AppKit (project id) or an injected wallet is available. */
export function walletConnectLoginAvailable(): boolean {
  return walletConnectConfigured() || injectedWalletAvailable();
}

/** @deprecated Use walletConnectLoginAvailable — includes injected fallback. */
export function walletLoginAvailable(): boolean {
  return walletConnectLoginAvailable();
}

/** True after the server has accepted signed auth (auth/ok). */
export function isServerAuthed(): boolean {
  return authedWallet !== null;
}

/** Ask the server whether a character name is free on the global log (before paying mint). */
export function checkCharacterNameAvailable(
  name: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: "Not connected to the server." });
  }
  if (!isServerAuthed()) {
    return Promise.resolve({ ok: false, error: "Sign in before checking names." });
  }
  if (nameCheckWaiter) {
    clearTimeout(nameCheckWaiter.timer);
    nameCheckWaiter.resolve({ ok: false, error: "Name check superseded." });
    nameCheckWaiter = null;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (nameCheckWaiter?.resolve === resolve) nameCheckWaiter = null;
      resolve({ ok: false, error: "Name check timed out." });
    }, 8_000);
    nameCheckWaiter = { resolve, timer };
    socket!.send(JSON.stringify({ type: "char/nameCheck", name } satisfies ClientMessage));
  });
}

export async function clearExternalWalletAuth(): Promise<void> {
  externalAuth = null;
  await disconnectAppKit();
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
    useGame.getState().pushLog("Connected to Black Anvil server.");
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
      authedWallet = msg.wallet.toLowerCase();
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
      if ("characterMint" in msg) g.setCharacterMint(msg.characterMint ?? null);
      clearPendingMintIfTokenBound(
        msg.wallet,
        list.map((c) => c.tokenId),
      );
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
        ...(msg.you.lok?.tokenId ? { tokenId: msg.you.lok.tokenId } : {}),
      };
      g.setCharacterPreview(preview);
      g.setSelectedCharId(preview.id);
      g.setHasCharacter(true);
      const others = g.characters.filter((c) => c.id !== preview.id);
      const nextRoster = [...others, preview];
      g.setCharacters(nextRoster);
      if (g.wallet) {
        clearPendingMintIfTokenBound(
          g.wallet,
          nextRoster.map((c) => c.tokenId),
        );
        // Successful create: roster updated — drop any pending paid mint for this wallet.
        if (g.pendingCreateEnter) clearPendingMint(g.wallet);
      }
      if (g.pendingCreateEnter) {
        g.setPendingCreateEnter(false);
        g.setPhase("play");
      }
    } else if (msg.type === "char/nameCheck") {
      if (nameCheckWaiter) {
        clearTimeout(nameCheckWaiter.timer);
        const resolve = nameCheckWaiter.resolve;
        nameCheckWaiter = null;
        if (msg.available && msg.name) resolve({ ok: true, name: msg.name });
        else resolve({ ok: false, error: msg.error ?? "That name is not available." });
      }
    } else if (msg.type === "log") {
      g.pushLog(msg.message);
    } else if (msg.type === "error") {
      if (authInFlight) {
        authInFlight = false;
        authedWallet = null;
      }
      // Only resolve a pending nameCheck on errors that are replies to that request path.
      if (
        nameCheckWaiter &&
        /Authenticate first|signed wallet first|Too many name checks/i.test(msg.message)
      ) {
        clearTimeout(nameCheckWaiter.timer);
        const resolve = nameCheckWaiter.resolve;
        nameCheckWaiter = null;
        resolve({ ok: false, error: msg.message });
      }
      // M-F: paid NFT already bound — stop reusing it on the next create.
      if (/already bound/i.test(msg.message) && g.wallet) {
        clearPendingMint(g.wallet);
      }
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
  void clearExternalWalletAuth();
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
