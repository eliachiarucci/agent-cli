import { rmSync } from "node:fs";
import { compose, composeOrThrow, composeOutput, waitForHealth } from "../compose";
import { configExists, defaultAppOrigin, loadConfig, newConfig, saveConfig, AGENT_HOME, CONFIG_PATH, type AgentConfig } from "../config";
import { dockerPreflight } from "../docker";
import { render } from "../render";
import { ask, confirm, isInteractive } from "../tty";
import { createFirstUser, hasUsers } from "./users";

async function promptNewConfig(): Promise<AgentConfig> {
  console.log("\nA few questions (Enter accepts the default):\n");

  let port = 4125;
  const portAnswer = await ask("Port for the web UI", String(port));
  const parsed = Number.parseInt(portAnswer, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) port = parsed;

  const appOrigin = await ask(
    "Address other devices will use to reach it (passkeys bind to this hostname)",
    defaultAppOrigin(port)
  );

  return newConfig(port, appOrigin.replace(/\/+$/, ""), true);
}

export async function setup(): Promise<void> {
  await dockerPreflight();

  let config: AgentConfig;
  if (configExists()) {
    config = loadConfig();
    console.log(`Using existing configuration at ${CONFIG_PATH}.`);
  } else if (isInteractive()) {
    config = await promptNewConfig();
    saveConfig(config);
  } else {
    config = newConfig(4125, defaultAppOrigin(4125), true);
    saveConfig(config);
    console.log(`No TTY available — wrote defaults to ${CONFIG_PATH}.`);
  }

  render(config);

  console.log("\nStarting the stack (first run downloads the images)...");
  // --pull missing: fetches release images on a fresh install but leaves
  // locally built dev images (AGENT_IMAGE=…:dev) alone.
  composeOrThrow(["up", "-d", "--pull", "missing"]);

  console.log("Waiting for the app to become healthy (first boot runs database migrations)...");
  await waitForHealth(`http://localhost:${config.port}/agent/health`, 180_000);

  if (!hasUsers()) {
    if (isInteractive()) {
      console.log("\nLet's create your account:");
      await createFirstUser();
    } else {
      console.log("\nNo users yet — create one with: agent users create <username>");
    }
  }

  console.log(`\n✓ All set. Open ${config.appOrigin} in your browser.`);
  console.log("  Manage the install with: agent status | logs | users | config | update");
}

export async function start(): Promise<void> {
  const config = loadConfig();
  render(config);
  composeOrThrow(["up", "-d"]);
  await waitForHealth(`http://localhost:${config.port}/agent/health`, 120_000);
  console.log(`✓ Running at ${config.appOrigin}`);
}

export function stop(): void {
  loadConfig(); // fail early with a friendly message if never set up
  composeOrThrow(["down"]);
  console.log("✓ Stopped.");
}

export async function restart(): Promise<void> {
  const config = loadConfig();
  render(config);
  composeOrThrow(["down"]);
  composeOrThrow(["up", "-d"]);
  await waitForHealth(`http://localhost:${config.port}/agent/health`, 120_000);
  console.log(`✓ Running at ${config.appOrigin}`);
}

export function logs(args: string[]): void {
  loadConfig();
  process.exitCode = compose(["logs", ...args]);
}

export async function status(): Promise<void> {
  const config = loadConfig();
  const { stdout } = composeOutput(["ps", "--format", "table {{.Service}}\\t{{.Status}}\\t{{.Image}}"]);
  console.log(stdout.trim() || "Stack is not running.");
  console.log(`\nBackend: ${config.release}  UI: ${config.uiTag}  Origin: ${config.appOrigin}`);
  try {
    const res = await fetch(`http://localhost:${config.port}/agent/health`, { signal: AbortSignal.timeout(3000) });
    console.log(`Health: ${res.ok ? "ok" : `HTTP ${res.status}`}`);
  } catch {
    console.log("Health: unreachable");
  }
}

export async function uninstall(): Promise<void> {
  const config = loadConfig();
  render(config);
  if (!(await confirm("Stop and remove the agent containers?", false))) {
    console.log("Aborted.");
    return;
  }
  composeOrThrow(["down", "--remove-orphans"]);

  const wipe = await ask('Also delete ALL data (database, downloaded models)? Type "delete" to confirm', "");
  if (wipe === "delete") {
    composeOrThrow(["down", "--volumes"]);
    rmSync(AGENT_HOME, { recursive: true, force: true });
    console.log(`✓ Removed containers, volumes, and ${AGENT_HOME}.`);
  } else {
    console.log("✓ Containers removed; data volumes and config kept.");
  }
  console.log(`Remove the CLI itself with: rm ${process.execPath.includes("node") ? "<agent binary>" : process.execPath}`);
}
