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
npm run build:sea                      # build the SEA binary for this platform
```

Use locally built images with:

```sh
AGENT_IMAGE=ghcr.io/eliachiarucci/agent:dev \
AGENT_UI_IMAGE=ghcr.io/eliachiarucci/agent-ui:dev \
AGENT_HOME=/tmp/agent-test npm run dev -- setup
```

## Releasing

1. Bump `cli` in `versions.json` (and `backend`/`ui` to the image tags this release should pin).
2. Tag the commit with the same version (`git tag v0.2.0 && git push --tags`) — CI builds the binaries and creates the GitHub release.
3. Backend/UI-only rollouts don't need a CLI release: tag the backend/UI repos (their CI pushes images), then bump `backend`/`ui` in `versions.json` on `main` — `agent update` picks it up.
