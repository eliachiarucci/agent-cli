#!/usr/bin/env bash
# Installer for the agent CLI:
#   curl -fsSL https://raw.githubusercontent.com/eliachiarucci/agent-cli/main/install.sh | bash
# Downloads the CLI binary for this platform and runs `agent setup`, which
# checks/installs Docker, starts the stack, and creates the first user.
set -euo pipefail

REPO="${AGENT_REPO:-eliachiarucci/agent-cli}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=macos-arm64 ;;
  Darwin-x86_64) echo "Intel Macs are not supported." >&2; exit 1 ;;
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) target=linux-arm64 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

tag="${AGENT_VERSION:-}"
if [ -z "$tag" ]; then
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
fi
[ -n "$tag" ] || { echo "Could not determine the latest release of $REPO." >&2; exit 1; }

base="https://github.com/$REPO/releases/download/$tag"
dir=/usr/local/bin
[ -d "$dir" ] && [ -w "$dir" ] || dir="$HOME/.local/bin"
mkdir -p "$dir"

echo "Downloading agent $tag ($target)..."
tmp="$(mktemp)"
curl -fsSL "$base/agent-$target" -o "$tmp"

expected="$(curl -fsSL "$base/agent-$target.sha256" | awk '{print $1}')"
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
else
  actual="$(sha256sum "$tmp" | awk '{print $1}')"
fi
[ "$actual" = "$expected" ] || { echo "Checksum verification failed." >&2; rm -f "$tmp"; exit 1; }

chmod +x "$tmp"
mv "$tmp" "$dir/agent"
echo "Installed agent $tag to $dir/agent"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "NOTE: add $dir to your PATH (e.g. in ~/.zshrc or ~/.bashrc)." ;;
esac

# Under `curl | bash` stdin is the script stream — give setup the real terminal.
if [ -t 0 ]; then
  exec "$dir/agent" setup
elif [ -e /dev/tty ]; then
  exec "$dir/agent" setup < /dev/tty
else
  echo "No terminal available — run \`agent setup\` to finish the installation."
fi
