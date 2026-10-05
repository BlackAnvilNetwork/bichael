/**
 * Who gets kill credit when a damage-over-time tick finishes a mob (#69).
 * Prefers the wallet that applied the DoT, then any other online wallet that hit the mob.
 * Merely targeting the mob earns nothing, so a bystander cannot steal the kill.
 */
export function pickDotKillCredit<P extends { wallet: string }>(
  sourceWallet: string | null | undefined,
  hitBy: Iterable<string> | undefined,
  online: Iterable<P>,
): P | null {
  const byWallet = new Map<string, P>();
  for (const pl of online) byWallet.set(pl.wallet.toLowerCase(), pl);
  if (sourceWallet) {
    const src = byWallet.get(sourceWallet.toLowerCase());
    if (src) return src;
  }
  for (const w of hitBy ?? []) {
    const pl = byWallet.get(w.toLowerCase());
    if (pl) return pl;
  }
  return null;
}
