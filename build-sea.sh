#!/usr/bin/env bash
# Builds a Node SEA (single executable application) binary for the current
# platform. Output: dist/agent-<target> + dist/agent-<target>.sha256
set -euo pipefail
cd "$(dirname "$0")"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=macos-arm64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) TARGET=linux-arm64 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

OUT="dist/agent-$TARGET"

node build.mjs
node --experimental-sea-config sea-config.json

cp "$(command -v node)" "$OUT"

if [ "$(uname -s)" = "Darwin" ]; then
  codesign --remove-signature "$OUT"
  npx --yes postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
  # Ad-hoc signature: required to run at all on arm64 macs.
  codesign --sign - "$OUT"
else
  npx --yes postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi

(cd dist && shasum -a 256 "agent-$TARGET" > "agent-$TARGET.sha256")
echo "[build-sea] $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
