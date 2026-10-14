# agent-cli

Installer and management CLI for the [agent](https://github.com/eliachiarucci/agent) self-hosted personal assistant.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/eliachiarucci/agent-cli/main/install.sh | bash
```

This downloads the `agent` binary for your platform (macOS arm64, Linux x64/arm64), then runs `agent setup`, which:

1. Checks for Docker — offers to install it on Linux, starts OrbStack/Docker Desktop on macOS.
2. Asks two questions (port, address) and writes `~/.agent/config.json` with generated secrets.
3. Pulls the images and starts the stack (app, web UI, Postgres + pgvector, SearXNG).
4. Prompts you to create the first user account.
5. Prints the web UI URL.

LLM providers (Anthropic, LM Studio, …) are configured afterwards in the web UI under Settings → Models — the install needs no model configuration.

## Commands

```
agent setup                      Install and start everything (idempotent)
agent start | stop | restart     Manage the stack
agent status                     Containers, versions, health
agent logs [service] [-f]        Tail logs (app, ui, db, searxng)
agent users list|create|remove   Manage accounts (signup is CLI-only)
agent config get [key]           Show configuration
agent config set <key> <value>   port, appOrigin, startWebUi
agent backup [path] [--files]    Dump the database (and, with --files, agent-created files)
agent update                     Update CLI, images, and database schema
agent self-update                Update only the CLI binary
agent uninstall                  Remove the stack (data wiped only on confirm)
```

## Devices: agent-device

A device is a computer with a camera, a microphone or a speaker (a laptop, a Raspberry Pi, a robot) that an agent
sees, hears and speaks through. `agent-device` is its client, built and released here next to `agent`
(`src/device/`, binaries `agent-device-<platform>`). Nobody installs it by hand: the web UI's Settings → Devices →
Add device shows a command that the agent server serves, which installs it (and ffmpeg), asks for the devices,
pairs it with a one-time code and starts it:

```sh
curl -fsSL https://agent.example.com/agent/devices/install.sh | sh -s -- ABCDE-FGHJK
```

```
agent-device [run]                 Connect and stream (asks for the devices on the first run)
agent-device setup                 Choose the camera, microphone and speaker
agent-device devices               List the cameras and microphones
agent-device status                Show the pairing, the chosen devices and the service
sudo agent-device service install  Run it as a service, started at boot (Linux, systemd)
```

It keeps its pairing in `~/.config/agent-device/device.json` and its choices in `settings.json` next to it. It
captures with ffmpeg (avfoundation on macOS, V4L2 and ALSA on Linux), sends a frame when the view changes and a
heartbeat as the server's settings say, crops regions for the agent's `zoom`, streams speech with a simple voice
detector (muted while a reply plays, unless the speaker is headphones), and plays replies with afplay or aplay.
On macOS it runs in a terminal: background processes don't get the camera and microphone permission.

## How it works

- `~/.agent/config.json` is the single source of truth (no `.env` files). The CLI renders `~/.agent/runtime/{docker-compose.yml, app.env, searxng/settings.yml}` from it before every operation.
- Image versions are pinned by [versions.json](versions.json) on `main`: `agent update` fetches it, self-updates the binary if needed, then pulls the pinned backend/UI images. Database migrations run automatically inside the app container on startup.
- Postgres and SearXNG are not exposed on the host; only the web UI port (default 4125) is published.
- `appOrigin` is the address other devices use (e.g. `http://myserver.local:4125`). Passkeys are bound to its hostname — changing it invalidates existing passkeys.

## Development

```sh
npm install
npm run dev -- status                  # run from source (tsx)
npm run typecheck
npm run build:sea                      # build both SEA binaries (agent, agent-device) for this platform
npx tsx src/device/index.ts status     # agent-device from source (AGENT_DEVICE_DIR to use another config folder)
```

Use locally built images with:

```sh
AGENT_IMAGE=ghcr.io/eliachiarucci/agent:dev \
AGENT_UI_IMAGE=ghcr.io/eliachiarucci/agent-ui:dev \
AGENT_HOME=/tmp/agent-test npm run dev -- setup
```

## Releasing

1. Bump `cli` in `versions.json` (and `backend`/`ui` to the image tags this release should pin).
2. Tag the commit with the same version (`git tag v0.2.0 && git push --tags`) — CI builds the binaries (`agent` and `agent-device`) and creates the GitHub release. The device install script downloads `agent-device` from the latest release.
3. Backend/UI-only rollouts don't need a CLI release: tag the backend/UI repos (their CI pushes images), then bump `backend`/`ui` in `versions.json` on `main` — `agent update` picks it up.
