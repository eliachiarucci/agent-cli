import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeOrThrow, waitForHealth } from "../compose";
import { loadConfig, saveConfig, RUNTIME_DIR } from "../config";
import { render } from "../render";
import { BACKEND_IMAGE, CLI_REPO, CLI_VERSION, seaTarget, UI_IMAGE } from "../version";

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

/** Image refs in the rendered compose file — the record of what's deployed. */
function deployedImages(): string[] {
  let yaml: string;
  try {
    yaml = readFileSync(join(RUNTIME_DIR, "docker-compose.yml"), "utf8");
  } catch {
    return [];
  }
  return [...yaml.matchAll(/^\s+image:\s*(\S+)/gm)].map((match) => match[1]);
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

  // Diff the rendered compose file across the re-render: backend/ui move via
  // the manifest tags, db/searxng move when this CLI build ships new pins in
  // the compose template. Anything that drops out of the file is stale.
  const tagsChanged = manifest.backend !== config.release || manifest.ui !== config.uiTag;
  const before = deployedImages();
  config.release = manifest.backend;
  config.uiTag = manifest.ui;
  render(config);
  const after = deployedImages();
  const stale = before.filter((ref) => !after.includes(ref));
  const fresh = after.filter((ref) => !before.includes(ref));

  if (!tagsChanged && stale.length === 0 && fresh.length === 0) {
    console.log(`Already up to date (backend ${config.release}, ui ${config.uiTag}).`);
    return;
  }

  if (fresh.length > 0) {
    const repo = (ref: string) => ref.slice(0, ref.lastIndexOf(":"));
    console.log("Updating:");
    for (const ref of fresh) {
      const old = stale.find((s) => repo(s) === repo(ref));
      console.log(old ? `  ${old} → ${ref}` : `  + ${ref}`);
    }
  } else {
    console.log(`Updating: backend → ${manifest.backend}, ui → ${manifest.ui}`);
  }
  // Removed only after the new stack is healthy, so the previous images stay
  // available for a rollback if the update fails. AGENT_IMAGE / AGENT_UI_IMAGE
  // mean the rendered ref isn't what's actually deployed — skip those repos.
  const oldImages = stale.filter(
    (ref) =>
      !(process.env.AGENT_IMAGE && ref.startsWith(`${BACKEND_IMAGE}:`)) &&
      !(process.env.AGENT_UI_IMAGE && ref.startsWith(`${UI_IMAGE}:`))
  );

  composeOrThrow(["pull"]);
  composeOrThrow(["up", "-d", "--remove-orphans"]);
  // Persist only once the new images are actually running, so a failed update
  // stays retryable instead of looking "already up to date".
  saveConfig(config);
  console.log("Waiting for the app to become healthy (migrations run automatically)...");
  await waitForHealth(`http://localhost:${config.port}/agent/health`, 180_000);
  for (const ref of oldImages) {
    // Best-effort: a failure (image already gone, still in use elsewhere) is not an update failure.
    const removed = spawnSync("docker", ["image", "rm", ref], { encoding: "utf8" });
    if (removed.status === 0) console.log(`Removed old image ${ref}.`);
  }
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
