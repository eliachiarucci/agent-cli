#!/usr/bin/env bash
# Builds the Node SEA (single executable application) binaries for the current
# platform: dist/agent-<target> and dist/agent-device-<target>, each with a .sha256.
set -euo pipefail
cd "$(dirname "$0")"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=macos-arm64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) TARGET=linux-arm64 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

node build.mjs

# sea <name>: dist/<name>.cjs → dist/<name>-<target>
sea() {
  local name=$1 out="dist/$1-$TARGET"
  printf '{"main":"dist/%s.cjs","output":"dist/%s.blob","disableExperimentalSEAWarning":true}' "$name" "$name" \
    > "dist/$name.sea.json"
  node --experimental-sea-config "dist/$name.sea.json"
  cp "$(command -v node)" "$out"
  if [ "$(uname -s)" = "Darwin" ]; then
    codesign --remove-signature "$out"
    npx --yes postject "$out" NODE_SEA_BLOB "dist/$name.blob" \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
      --macho-segment-name NODE_SEA
    # Ad-hoc signature: required to run at all on arm64 macs.
    codesign --sign - "$out"
  else
    npx --yes postject "$out" NODE_SEA_BLOB "dist/$name.blob" \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
  fi
  (cd dist && shasum -a 256 "$name-$TARGET" > "$name-$TARGET.sha256")
  echo "[build-sea] $out ($(du -h "$out" | cut -f1 | tr -d ' '))"
}

sea agent
sea agent-device
