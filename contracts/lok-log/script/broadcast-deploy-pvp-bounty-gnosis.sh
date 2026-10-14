#!/usr/bin/env bash
# Broadcast PvpBounty onto Gnosis (100) against the official CharacterNFT.
# HARD STOP: refuses --broadcast unless CONFIRM_BROADCAST=1.
#
# Usage:
#   set -a && source .env.gnosis && set +a
#   CONFIRM_BROADCAST=1 ./script/broadcast-deploy-pvp-bounty-gnosis.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RPC_URL="${RPC_URL:-${GNOSIS_RPC_URL:-https://rpc.gnosischain.com}}"
: "${RPC_URL:?set RPC_URL or GNOSIS_RPC_URL}"

ensure_private_key() {
  if [[ -n "${PRIVATE_KEY:-}" ]] && cast wallet address --private-key "$PRIVATE_KEY" >/dev/null 2>&1; then
    return 0
  fi
  local env_file="${LOK_DEPLOY_ENV_FILE:-$ROOT/.env}"
  if [[ ! -f "$env_file" ]]; then
    echo "broadcast-deploy-pvp-bounty-gnosis: PRIVATE_KEY missing or invalid and no $env_file" >&2
    exit 1
  fi
  PRIVATE_KEY="$(
    python3 - <<'PY' "$env_file"
import re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^PRIVATE_KEY=(.*)$", text, re.M)
if not m:
    sys.exit(1)
print(m.group(1).strip().strip('"').strip("'"))
PY
  )" || {
    echo "broadcast-deploy-pvp-bounty-gnosis: could not read PRIVATE_KEY from $env_file" >&2
    exit 1
  }
  export PRIVATE_KEY
}
ensure_private_key

if [[ "${CONFIRM_BROADCAST:-}" != "1" ]]; then
  echo "broadcast-deploy-pvp-bounty-gnosis: refusing --broadcast (set CONFIRM_BROADCAST=1 after go-ahead)." >&2
  exit 1
fi

export NFT="${NFT:-0x48aFeC17A56c5Bd32ABDbcAD57f16d3859b1289F}"
export ADMIN="${ADMIN:-0x08cDab8b049D2A42125C3A2bf1bF1E2f619C4e01}"
export LISTING="${LISTING:-0xbFa29a6EE3d1188aa0A9e0c783E5Da620b859E76}"

DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
echo "[broadcast-deploy-pvp-bounty-gnosis] deployer=$DEPLOYER nft=$NFT admin=$ADMIN operator=$LISTING"

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

forge script script/DeployPvpBountyGnosis.s.sol:DeployPvpBountyGnosis \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --slow \
  --private-key "$PRIVATE_KEY" \
  --sender "$DEPLOYER" \
  -vv | tee "$LOG"

PVP_BOUNTY="$(grep -E '^[[:space:]]*PVP_BOUNTY[[:space:]]+0x' "$LOG" | tail -1 | grep -oE '0x[a-fA-F0-9]{40}' | head -1 || true)"
if [[ -z "$PVP_BOUNTY" ]]; then
  echo "broadcast-deploy-pvp-bounty-gnosis: could not parse PVP_BOUNTY from forge log" >&2
  exit 1
fi
echo "[broadcast-deploy-pvp-bounty-gnosis] PVP_BOUNTY=$PVP_BOUNTY"
echo "[broadcast-deploy-pvp-bounty-gnosis] Record under deployments/gnosis.json → contracts.PvpBounty and set LOK_PVP_BOUNTY."
