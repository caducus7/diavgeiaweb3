#!/bin/bash
# Cloud sessions only: Foundry, solc and the verifier's node modules, so `forge test` and `npm test` work at once.
# foundry.paradigm.xyz and binaries.soliditylang.org may be blocked, so both come from their GitHub releases.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
TOOLS="$HOME/.local/diavgeia-tools"
SOLC="$TOOLS/solc-0.8.28"
mkdir -p "$TOOLS"

if [ ! -x "$TOOLS/forge" ] || [ ! -x "$TOOLS/anvil" ]; then
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/foundry.tgz" \
    https://github.com/foundry-rs/foundry/releases/download/stable/foundry_stable_linux_amd64.tar.gz
  tar -xzf "$tmp/foundry.tgz" -C "$tmp"
  install -m 0755 "$tmp/forge" "$tmp/anvil" "$TOOLS/"
  rm -rf "$tmp"
fi

if [ ! -x "$SOLC" ]; then
  curl -fsSL --retry 3 -o "$SOLC.part" \
    https://github.com/ethereum/solidity/releases/download/v0.8.28/solc-static-linux
  chmod +x "$SOLC.part" && mv "$SOLC.part" "$SOLC"
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$TOOLS:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  echo "export FOUNDRY_SOLC=\"$SOLC\"" >> "$CLAUDE_ENV_FILE"
fi

# npm install (not ci) reuses the cached node_modules between sessions.
cd "$ROOT/verifier" && npm install --no-audit --no-fund --loglevel=error
