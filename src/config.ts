import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { pinnedTags } from "./version";

export interface AgentConfig {
  version: 1;
  /** Backend image tag currently deployed. */
  release: string;
  /** UI image tag currently deployed. */
  uiTag: string;
  port: number;
  appOrigin: string;
  startWebUi: boolean;
  secrets: {
    betterAuthSecret: string;
    postgresPassword: string;
    searxngSecret: string;
  };
}

export const AGENT_HOME = process.env.AGENT_HOME ?? join(homedir(), ".agent");
export const CONFIG_PATH = join(AGENT_HOME, "config.json");
export const RUNTIME_DIR = join(AGENT_HOME, "runtime");

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): AgentConfig {
  if (!configExists()) {
    throw new Error(`No config at ${CONFIG_PATH} — run \`agent setup\` first.`);
  }
  let config: AgentConfig;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AgentConfig;
  } catch {
    throw new Error(
      `${CONFIG_PATH} is corrupt — likely a write that failed midway (e.g. disk full).\n` +
        `Reconstruct it from the rendered runtime files with: agent config rebuild`
    );
  }
  if (config.version !== 1) throw new Error(`Unsupported config version ${config.version}`);
  return config;
}

export function saveConfig(config: AgentConfig): void {
  mkdirSync(AGENT_HOME, { recursive: true, mode: 0o700 });
  // Write-then-rename: rename is atomic on POSIX, so a failed write (disk
  // full, crash) leaves the previous config intact instead of a truncated one.
  const staging = `${CONFIG_PATH}.tmp`;
  writeFileSync(staging, JSON.stringify(config, null, 2) + "\n");
  chmodSync(staging, 0o600); // holds the DB password and auth secret
  renameSync(staging, CONFIG_PATH);
}

export function newConfig(port: number, appOrigin: string, startWebUi: boolean): AgentConfig {
  const tags = pinnedTags();
  return {
    version: 1,
    release: tags.backend,
    uiTag: tags.ui,
    port,
    appOrigin,
    startWebUi,
    secrets: {
      betterAuthSecret: randomBytes(48).toString("hex"),
      postgresPassword: randomBytes(32).toString("hex"),
      searxngSecret: randomBytes(32).toString("hex"),
    },
  };
}

function lanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

/**
 * Best-guess origin reachable from other devices on the LAN. Prefers the
 * mDNS hostname (stable across DHCP renewals — and passkeys bind to the
 * APP_ORIGIN hostname), falling back to the primary LAN IP.
 */
export function defaultAppOrigin(port: number): string {
  const host = hostname();
  const mdnsName = host.endsWith(".local") ? host : undefined;
  const target = mdnsName ?? lanIPv4() ?? "localhost";
  return `http://${target.toLowerCase()}:${port}`;
}
