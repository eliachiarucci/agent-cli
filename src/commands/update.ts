import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeOrThrow, waitForHealth } from "../compose";
import { loadConfig, saveConfig } from "../config";
import { render } from "../render";
import { CLI_REPO, CLI_VERSION, seaTarget } from "../version";

interface Manifest {
  cli: string;
  backend: string;
  ui: string;
}

const MANIFEST_URL =
  process.env.AGENT_MANIFEST_URL ?? `https://raw.githubusercontent.com/${CLI_REPO}/main/versions.json`;

async function fetchManifest(): Promise<Manifest> {
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Could not fetch ${MANIFEST_URL} (HTTP ${res.status})`);
  return (await res.json()) as Manifest;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downloads the release binary, verifies its checksum, and replaces this executable. */
async function replaceBinary(tag: string): Promise<void> {
  const target = seaTarget();
  const base = `https://github.com/${CLI_REPO}/releases/download/${tag}`;
  console.log(`Updating the CLI to ${tag}...`);

  const [binary, checksumFile] = await Promise.all([
    download(`${base}/agent-${target}`),
    download(`${base}/agent-${target}.sha256`),
  ]);
  const expected = checksumFile.toString("utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for agent-${target}: expected ${expected}, got ${actual}`);
  }

  const staging = join(tmpdir(), `agent-${tag}-${process.pid}`);
  writeFileSync(staging, binary);
  chmodSync(staging, 0o755);
  try {
    // rename over the running binary works on macOS/Linux (the old inode lives on)
    renameSync(staging, process.execPath);
  } catch {
    // /usr/local/bin not writable (or cross-device tmp): escalate once
    const result = spawnSync("sudo", ["install", "-m", "755", staging, process.execPath], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Could not replace ${process.execPath}.`);
  }
}

export async function update(args: string[]): Promise<void> {
  const config = loadConfig();
  const manifest = await fetchManifest();

  // Self-update first so the new compose template ships with the new images.
  // Skipped in dev (tsx) where process.execPath is the node binary.
  if (!args.includes("--skip-self") && CLI_VERSION !== "dev" && manifest.cli !== CLI_VERSION) {
    await replaceBinary(manifest.cli);
    const result = spawnSync(process.execPath, ["update", "--skip-self"], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  if (manifest.backend === config.release && manifest.ui === config.uiTag) {
    console.log(`Already up to date (backend ${config.release}, ui ${config.uiTag}).`);
    return;
  }

  console.log(`Updating: backend ${config.release} → ${manifest.backend}, ui ${config.uiTag} → ${manifest.ui}`);
  config.release = manifest.backend;
  config.uiTag = manifest.ui;
  render(config);

  composeOrThrow(["pull"]);
  composeOrThrow(["up", "-d", "--remove-orphans"]);
  // Persist only once the new images are actually running, so a failed update
  // stays retryable instead of looking "already up to date".
  saveConfig(config);
  console.log("Waiting for the app to become healthy (migrations run automatically)...");
  await waitForHealth(`http://localhost:${config.port}/agent/health`, 180_000);
  console.log(`✓ Updated. Backend ${config.release}, UI ${config.uiTag}.`);
}

export async function selfUpdate(): Promise<void> {
  if (CLI_VERSION === "dev") {
    console.log("Running from source — nothing to self-update.");
    return;
  }
  const manifest = await fetchManifest();
  if (manifest.cli === CLI_VERSION) {
    console.log(`CLI is up to date (${CLI_VERSION}).`);
    return;
  }
  await replaceBinary(manifest.cli);
  console.log(`✓ CLI updated to ${manifest.cli}.`);
}
