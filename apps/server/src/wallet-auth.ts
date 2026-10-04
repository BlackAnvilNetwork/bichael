/** EIP-4361-style signed login for the local game server. */
import { randomBytes } from "node:crypto";
import { verifyMessage, type Hex } from "viem";

const NONCE_TTL_MS = 5 * 60_000;
const usedNonces = new Map<string, number>();
const pendingNonces = new Map<string, { wallet: string; expiresAt: number }>();

function prune() {
  const now = Date.now();
  for (const [nonce, exp] of usedNonces) {
    if (exp <= now) usedNonces.delete(nonce);
  }
  for (const [nonce, row] of pendingNonces) {
    if (row.expiresAt <= now) pendingNonces.delete(nonce);
  }
}

export function isEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function authMessage(args: {
  wallet: string;
  nonce: string;
  issuedAt: string;
  chainId?: number;
  uri?: string;
}): string {
  const wallet = args.wallet.toLowerCase();
  const uri = args.uri ?? "bellgrave://local";
  const chainId = args.chainId ?? 31337;
  return [
    "Bellgrave wants you to sign in with your Ethereum account:",
    wallet,
    "",
    "URI: " + uri,
    "Version: 1",
    "Chain ID: " + chainId,
    "Nonce: " + args.nonce,
    "Issued At: " + args.issuedAt,
  ].join("\n");
}

export function issueAuthChallenge(wallet: string): {
  ok: true;
  nonce: string;
  issuedAt: string;
  message: string;
} | { ok: false; error: string } {
  prune();
  const addr = wallet.trim().toLowerCase();
  if (!isEthAddress(addr)) {
    return { ok: false, error: "Wallet must be a 0x address." };
  }
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  pendingNonces.set(nonce, { wallet: addr, expiresAt: Date.now() + NONCE_TTL_MS });
  return {
    ok: true,
    nonce,
    issuedAt,
    message: authMessage({ wallet: addr, nonce, issuedAt }),
  };
}

export async function verifyAuthLogin(args: {
  wallet: string;
  signature: string;
  nonce: string;
  message: string;
}): Promise<{ ok: true; wallet: string } | { ok: false; error: string }> {
  prune();
  const wallet = args.wallet.trim().toLowerCase();
  if (!isEthAddress(wallet)) {
    return { ok: false, error: "Wallet must be a 0x address." };
  }
  if (!args.signature || typeof args.signature !== "string") {
    return { ok: false, error: "Signature required." };
  }
  const pending = pendingNonces.get(args.nonce);
  if (!pending) {
    return { ok: false, error: "Login nonce is unknown or expired." };
  }
  if (pending.wallet !== wallet) {
    return { ok: false, error: "Login nonce belongs to another wallet." };
  }
  if (usedNonces.has(args.nonce)) {
    return { ok: false, error: "Login nonce was already used." };
  }
  if (!args.message.includes(args.nonce) || !args.message.toLowerCase().includes(wallet)) {
    return { ok: false, error: "Signed message does not match this login." };
  }
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
  pendingNonces.delete(args.nonce);
  usedNonces.set(args.nonce, Date.now() + NONCE_TTL_MS);
  return { ok: true, wallet };
}

/** Test helper: mark a nonce used without verifying. */
export function __resetAuthNoncesForTests() {
  usedNonces.clear();
  pendingNonces.clear();
}
