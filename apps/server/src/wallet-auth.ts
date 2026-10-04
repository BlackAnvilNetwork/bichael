/** EIP-4361-style signed login for the local game server. */
import { randomBytes } from "node:crypto";
import { verifyMessage, type Hex } from "viem";

const NONCE_TTL_MS = 5 * 60_000;
/** Pending challenges one connection may hold at once. */
export const AUTH_PENDING_PER_CONNECTION = 5;
/** Pending challenges across every connection. */
export const AUTH_PENDING_GLOBAL = 100;
/** auth/hello attempts allowed per connection in the window below. */
export const AUTH_HELLO_LIMIT = 10;
export const AUTH_HELLO_WINDOW_MS = 60_000;
const MAX_HELLO_TRACKED = 200;

type PendingNonce = {
  wallet: string;
  message: string;
  expiresAt: number;
  connectionId: string;
};

const usedNonces = new Map<string, number>();
const pendingNonces = new Map<string, PendingNonce>();
const helloHits = new Map<string, number[]>();

function prune(now = Date.now()) {
  for (const [nonce, exp] of usedNonces) {
    if (exp <= now) usedNonces.delete(nonce);
  }
  for (const [nonce, row] of pendingNonces) {
    if (row.expiresAt <= now) pendingNonces.delete(nonce);
  }
  for (const [id, hits] of helloHits) {
    const fresh = hits.filter((t) => now - t < AUTH_HELLO_WINDOW_MS);
    if (fresh.length === 0) helloHits.delete(id);
    else if (fresh.length !== hits.length) helloHits.set(id, fresh);
  }
}

function pendingFor(connectionId: string): number {
  let n = 0;
  for (const row of pendingNonces.values()) {
    if (row.connectionId === connectionId) n += 1;
  }
  return n;
}

function allowHello(connectionId: string, now: number): boolean {
  let hits = helloHits.get(connectionId);
  if (!hits) {
    if (helloHits.size >= MAX_HELLO_TRACKED) return false;
    hits = [];
  }
  hits = hits.filter((t) => now - t < AUTH_HELLO_WINDOW_MS);
  if (hits.length >= AUTH_HELLO_LIMIT) {
    helloHits.set(connectionId, hits);
    return false;
  }
  hits.push(now);
  helloHits.set(connectionId, hits);
  return true;
}

export function isEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function authMessage(args: {
  wallet: string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  chainId?: number;
  uri?: string;
  domain?: string;
}): string {
  const wallet = args.wallet.toLowerCase();
  const uri = args.uri ?? "bellgrave://local";
  const chainId = args.chainId ?? 31337;
  const domain = (args.domain ?? "localhost").trim() || "localhost";
  const expirationTime = args.expirationTime ?? new Date(Date.now() + NONCE_TTL_MS).toISOString();
  return [
    "Bellgrave wants you to sign in with your Ethereum account:",
    wallet,
    "",
    "Domain: " + domain,
    "URI: " + uri,
    "Version: 1",
    "Chain ID: " + chainId,
    "Nonce: " + args.nonce,
    "Issued At: " + args.issuedAt,
    "Expiration Time: " + expirationTime,
  ].join("\n");
}

export type AuthChallengeOpts = {
  /** Websocket that asked for this nonce. A different socket cannot redeem it. */
  connectionId?: string;
  /** SIWE domain, usually the request host. */
  domain?: string;
  now?: number;
};

export function issueAuthChallenge(
  wallet: string,
  opts: AuthChallengeOpts = {},
): { ok: true; nonce: string; issuedAt: string; message: string } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  prune(now);
  const addr = wallet.trim().toLowerCase();
  if (!isEthAddress(addr)) {
    return { ok: false, error: "Wallet must be a 0x address." };
  }
  const connectionId = opts.connectionId ?? "";
  if (pendingFor(connectionId) >= AUTH_PENDING_PER_CONNECTION) {
    return { ok: false, error: "Too many pending login challenges." };
  }
  if (pendingNonces.size >= AUTH_PENDING_GLOBAL) {
    return { ok: false, error: "Too many pending login challenges." };
  }
  if (!allowHello(connectionId, now)) {
    return { ok: false, error: "Too many login challenges. Wait a moment." };
  }
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date(now).toISOString();
  const expiresAt = now + NONCE_TTL_MS;
  const domain = (opts.domain ?? "localhost").trim() || "localhost";
  const message = authMessage({
    wallet: addr,
    nonce,
    issuedAt,
    expirationTime: new Date(expiresAt).toISOString(),
    domain,
  });
  pendingNonces.set(nonce, { wallet: addr, message, expiresAt, connectionId });
  return { ok: true, nonce, issuedAt, message };
}

export async function verifyAuthLogin(args: {
  wallet: string;
  signature: string;
  nonce: string;
  message: string;
  /** Must be the connection that received the challenge. */
  connectionId?: string;
}): Promise<{ ok: true; wallet: string } | { ok: false; error: string }> {
  const now = Date.now();
  prune(now);
  const wallet = args.wallet.trim().toLowerCase();
  if (!isEthAddress(wallet)) {
    return { ok: false, error: "Wallet must be a 0x address." };
  }
  if (!args.signature || typeof args.signature !== "string") {
    return { ok: false, error: "Signature required." };
  }
  const pending = pendingNonces.get(args.nonce);
  if (!pending || pending.expiresAt <= now) {
    if (pending) pendingNonces.delete(args.nonce);
    if (usedNonces.has(args.nonce)) {
      return { ok: false, error: "Login nonce was already used." };
    }
    return { ok: false, error: "Login nonce is unknown or expired." };
  }
  if (pending.wallet !== wallet) {
    return { ok: false, error: "Login nonce belongs to another wallet." };
  }
  const connectionId = args.connectionId ?? "";
  if (pending.connectionId !== connectionId) {
    return { ok: false, error: "Login nonce belongs to another connection." };
  }
  if (args.message !== pending.message) {
    return { ok: false, error: "Signed message does not match this login." };
  }
  // Consume before the signature await so two in-flight auths cannot both pass.
  pendingNonces.delete(args.nonce);
  usedNonces.set(args.nonce, now + NONCE_TTL_MS);
  let valid = false;
  try {
    valid = await verifyMessage({
      address: wallet as `0x${string}`,
      message: args.message,
      signature: args.signature as Hex,
    });
  } catch {
    return { ok: false, error: "Signature could not be checked." };
  }
  if (!valid) return { ok: false, error: "Signature is invalid." };
  return { ok: true, wallet };
}

/** Drop challenges and hello budget when a websocket closes. */
export function dropAuthConnection(connectionId: string) {
  if (!connectionId) return;
  for (const [nonce, row] of pendingNonces) {
    if (row.connectionId === connectionId) pendingNonces.delete(nonce);
  }
  helloHits.delete(connectionId);
}

/** Test helper: mark a nonce used without verifying. */
export function __resetAuthNoncesForTests() {
  usedNonces.clear();
  pendingNonces.clear();
  helloHits.clear();
}

/** Test helper: drop pending rows but keep the hello rate window. */
export function __clearPendingChallengesForTests() {
  pendingNonces.clear();
}

/** Test helper: force a pending challenge to look expired. */
export function __expirePendingForTests(nonce: string) {
  const row = pendingNonces.get(nonce);
  if (row) row.expiresAt = Date.now() - 1;
}
