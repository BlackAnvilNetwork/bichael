/** Must match apps/server/src/mint-claim.ts mintClaimMessage. */
export function mintClaimMessage(opts: {
  tokenId: string;
  gameWallet: string;
  chainId: number;
  charId: string;
  nonce: string;
  expiry: number;
}): string {
  return [
    "Black Anvil character mint claim",
    "tokenId: " + opts.tokenId,
    "gameWallet: " + opts.gameWallet.toLowerCase(),
    "chainId: " + String(opts.chainId),
    "charId: " + opts.charId,
    "nonce: " + opts.nonce,
    "expiry: " + String(opts.expiry),
  ].join("\n");
}

export function freshMintNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
