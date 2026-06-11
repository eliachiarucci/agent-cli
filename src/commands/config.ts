import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  configExists,
  loadConfig,
  saveConfig,
  CONFIG_PATH,
  RUNTIME_DIR,
  type AgentConfig,
} from "../config";
import { render } from "../render";

// Only plain settings are editable; versions move via `agent update` and
// secrets never change after generation.
const EDITABLE = ["port", "appOrigin", "startWebUi"] as const;
type EditableKey = (typeof EDITABLE)[number];

export function configGet(key?: string): void {
  const config = loadConfig();
  const visible = {
    release: config.release,
    uiTag: config.uiTag,
    port: config.port,
    appOrigin: config.appOrigin,
    startWebUi: config.startWebUi,
  };
  if (!key) {
    console.log(JSON.stringify(visible, null, 2));
    console.log(`\n(full file with secrets: ${CONFIG_PATH})`);
    return;
  }
  if (!(key in visible)) {
    console.error(`Unknown key "${key}". Available: ${Object.keys(visible).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(String(visible[key as keyof typeof visible]));
}

export function configSet(key: string, value: string): void {
  if (!EDITABLE.includes(key as EditableKey)) {
    console.error(`"${key}" is not editable. Editable keys: ${EDITABLE.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();

  if (key === "port") {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`"${value}" is not a valid port.`);
      process.exitCode = 1;
      return;
    }
    config.port = port;
  } else if (key === "appOrigin") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      console.error(`"${value}" is not a valid URL (expected e.g. http://myserver.local:4125).`);
      process.exitCode = 1;
      return;
    }
    if (new URL(config.appOrigin).hostname !== parsed.hostname) {
      console.log("⚠ Passkeys are bound to the origin's hostname — existing passkeys will stop working.");
    }
    config.appOrigin = value.replace(/\/+$/, "");
  } else if (key === "startWebUi") {
    if (value !== "true" && value !== "false") {
      console.error(`"${value}" must be true or false.`);
      process.exitCode = 1;
      return;
    }
    config.startWebUi = value === "true";
  }

  saveConfig(config as AgentConfig);
  render(config);
  console.log(`✓ ${key} updated. Apply it with: agent restart`);
}

/**
 * Reconstructs config.json from the rendered runtime files (compose, app.env,
 * searxng settings) — disaster recovery for a corrupted/lost config. Every
 * value in config.json also lives in those files, secrets included, so the
 * rebuilt config matches the deployed stack exactly.
 */
export function configRebuild(force: boolean): void {
  if (configExists()) {
    try {
      loadConfig();
      if (!force) {
        console.log(`${CONFIG_PATH} is valid — nothing to rebuild. Use --force to rebuild it anyway.`);
        return;
      }
    } catch {
      // corrupt — that's exactly what this command is for
    }
  }

  const composePath = join(RUNTIME_DIR, "docker-compose.yml");
  const envPath = join(RUNTIME_DIR, "app.env");
  if (!existsSync(composePath) || !existsSync(envPath)) {
    throw new Error(`No rendered stack in ${RUNTIME_DIR} to rebuild from — run \`agent setup\` instead.`);
  }

  const compose = readFileSync(composePath, "utf8");
  const env = new Map(
    readFileSync(envPath, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const eq = line.indexOf("=");
        return [line.slice(0, eq), line.slice(eq + 1)] as const;
      })
  );
  const required = (key: string): string => {
    const value = env.get(key);
    if (!value) throw new Error(`${envPath} is missing ${key} — cannot rebuild.`);
    return value;
  };

  const postgresPassword = /postgres:\/\/agent:([^@]+)@db/.exec(required("DATABASE_URL"))?.[1];
  if (!postgresPassword) {
    throw new Error(`Could not extract the Postgres password from DATABASE_URL in ${envPath}.`);
  }

  // The searxng container chowns its config dir on startup; reading it back
  // may need sudo.
  const settingsPath = join(RUNTIME_DIR, "searxng", "settings.yml");
  let searxngSecret: string;
  try {
    const match = /secret_key:\s*"([^"]+)"/.exec(readFileSync(settingsPath, "utf8"));
    if (!match) throw new Error(`No secret_key found in ${settingsPath}.`);
    searxngSecret = match[1];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `${settingsPath} is not readable (owned by the searxng container).\n` +
          `Re-run with sudo, then restore ownership: sudo chown $USER ${CONFIG_PATH}`
      );
    }
    throw error;
  }

  const startWebUi = /^ {2}ui:/m.test(compose);
  const portMatch = startWebUi ? /"(\d+):80"/.exec(compose) : /"(\d+):3001"/.exec(compose);
  if (!portMatch) throw new Error(`Could not find the published port in ${composePath}.`);

  // Image tags as last rendered. They may be ahead of what's actually running
  // (a crashed update renders before it pulls), hence the restart/update hint.
  const release = /image:\s*\S+\/agent:(\S+)/.exec(compose)?.[1] ?? "v0.0.0";
  const uiTag = /image:\s*\S+\/agent-ui:(\S+)/.exec(compose)?.[1] ?? "v0.0.0";

  const config: AgentConfig = {
    version: 1,
    release,
    uiTag,
    port: Number(portMatch[1]),
    appOrigin: required("APP_ORIGIN"),
    startWebUi,
    secrets: {
      betterAuthSecret: required("BETTER_AUTH_SECRET"),
      postgresPassword,
      searxngSecret,
    },
  };

  saveConfig(config);
  console.log(`✓ Rebuilt ${CONFIG_PATH} (backend ${release}, ui ${uiTag}, port ${config.port}).`);
  console.log("Run `agent restart` to make sure the stack matches it, then `agent update`.");
}
