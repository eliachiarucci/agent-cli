/**
 * Release helper for the CLI itself (this repo).
 *
 * Unlike backend/UI releases (scripts/release.ts), a CLI release ships the
 * versions.json bump *together with* the tag: the workflow refuses to build
 * unless versions.json "cli" matches the pushed tag. So the flow is:
 *
 *   1. ask which version tag to release (default: patch bump)
 *   2. update versions.json "cli", commit, tag, push main + tag
 *   3. wait for CI to build the SEA binaries and publish the GitHub release
 *
 * Usage:
 *   npm run release:cli                # asks for the tag, then confirms
 *   npm run release:cli -- v0.2.0      # preselect the tag, still confirms
 *   npm run release:cli -- --yes       # skip prompts (defaults to a patch bump)
 *   npm run release:cli -- --dry-run   # show the plan, touch nothing
 *
 * CI polling uses the public GitHub Actions REST API (no `gh` needed). Set
 * GITHUB_TOKEN / GH_TOKEN to raise the unauthenticated rate limit if needed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, ".."); // agent-cli
const VERSIONS_PATH = path.join(ROOT, "versions.json");

const CI_TIMEOUT_MS = 20 * 60 * 1000;
const CI_POLL_MS = 10_000;

// ── tiny ANSI helpers ──────────────────────────────────────────────────────
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function bumpPatch(version: string): string {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Unrecognized version string: ${version}`);
  return `v${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function repoSlug(): string {
  const url = git(["config", "--get", "remote.origin.url"]);
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`Cannot parse GitHub owner/repo from remote: ${url}`);
  return m[1];
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

// ── GitHub Actions polling ─────────────────────────────────────────────────
interface Run {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

async function fetchRuns(slug: string, tag: string): Promise<Run[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-release-script",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${slug}/actions/runs?per_page=30&event=push`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} for ${slug}`);
  const data = (await res.json()) as { workflow_runs?: (Run & { head_branch: string })[] };
  return (data.workflow_runs ?? []).filter((r) => r.head_branch === tag);
}

async function waitForCi(slug: string, tag: string): Promise<boolean> {
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < CI_TIMEOUT_MS) {
    let runs: Run[];
    try {
      runs = await fetchRuns(slug, tag);
    } catch (err) {
      console.log(`  ${yellow("!")} ${(err as Error).message} — retrying`);
      await sleep(CI_POLL_MS);
      continue;
    }
    if (runs.length === 0) {
      if (!announced) console.log(`  ${dim("·")} waiting for CI to start…`);
      announced = true;
      await sleep(CI_POLL_MS);
      continue;
    }
    const running = runs.filter((r) => r.status !== "completed");
    if (running.length > 0) {
      console.log(`  ${dim("·")} ${runs.length} run(s), ${running.length} in progress…`);
      await sleep(CI_POLL_MS);
      continue;
    }
    const failed = runs.filter((r) => r.conclusion !== "success");
    if (failed.length > 0) {
      console.log(`  ${red("✗")} CI failed — ${failed.map((r) => `${r.name} (${r.conclusion})`).join(", ")}`);
      failed.forEach((r) => console.log(`      ${dim(r.html_url)}`));
      return false;
    }
    console.log(`  ${green("✓")} CI green — ${runs.map((r) => r.name).join(", ")}`);
    return true;
  }
  console.log(`  ${red("✗")} timed out after ${CI_TIMEOUT_MS / 60000} min waiting for CI`);
  return false;
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const autoYes = argv.includes("--yes") || argv.includes("-y");
  const tagArg = argv.find((a) => !a.startsWith("-"));

  const versions = JSON.parse(readFileSync(VERSIONS_PATH, "utf8")) as Record<string, string>;
  const current = versions.cli;
  if (!current) throw new Error('No "cli" entry in versions.json');

  console.log(bold("\n  agent-cli release\n"));

  // Pre-flight: everything must already be committed on main.
  const errors: string[] = [];
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") errors.push(`on branch "${branch}", expected "main"`);
  if (git(["status", "--porcelain"])) errors.push("working tree is dirty — commit or stash first");
  if (errors.length > 0) {
    console.log(red("Pre-flight failed:"));
    errors.forEach((e) => console.log(`  ${red("✗")} ${e}`));
    process.exit(1);
  }

  // Pick the version tag (default: patch bump).
  const suggested = bumpPatch(current);
  let next = tagArg ?? (autoYes ? suggested : "");
  while (!next) {
    const answer = await ask(`  Version tag to release ${dim(`(current ${current})`)} [${bold(suggested)}]: `);
    next = answer || suggested;
    if (!/^v\d+\.\d+\.\d+$/.test(next)) {
      console.log(`  ${red("✗")} "${next}" is not a vX.Y.Z tag`);
      next = "";
    }
  }
  if (!/^v\d+\.\d+\.\d+$/.test(next)) throw new Error(`"${next}" is not a vX.Y.Z tag`);

  // The workflow publishes a GitHub release per tag, so a tag can never be reused.
  if (git(["tag", "--list", next]) === next) throw new Error(`tag ${next} already exists locally`);
  if (git(["ls-remote", "--tags", "origin", next])) throw new Error(`tag ${next} already exists on origin`);

  const slug = repoSlug();
  console.log(`\n  Planned release:\n`);
  console.log(`    cli  ${current} ${dim("→")} ${bold(next)}   ${dim(slug)}`);
  console.log(`\n  ${dim("versions.json")} is bumped in the same commit as the tag (the workflow requires it).`);
  if (dryRun) {
    console.log(yellow("\n  --dry-run: no tags pushed, no files changed.\n"));
    return;
  }

  if (!autoYes) {
    const answer = await ask(`\n  Proceed? ${dim("[y/N]")} `);
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  // Bump + commit + tag + push in one go.
  versions.cli = next;
  writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, 2) + "\n");
  git(["add", "versions.json"]);
  git(["commit", "-m", `release: cli ${next}`, "--", "versions.json"]);
  git(["tag", next]);
  git(["push", "origin", "main", next]);
  console.log(`\n  ${green("✓")} pushed ${bold(next)} (versions.json cli bumped in the same commit)`);

  console.log(bold("\n  Waiting for CI…"));
  const ok = await waitForCi(slug, next);
  if (!ok) {
    console.log(red("\n  CI did not pass — the release was not published."));
    console.log(dim("  The tag and versions.json bump are already pushed; fix the build and release"));
    console.log(dim("  a NEW patch version (tags cannot be reused once pushed).\n"));
    process.exit(1);
  }

  console.log(green("\n  Release complete."));
  console.log(dim("  `agent update` self-updates the CLI first when versions.json cli changes;"));
  console.log(dim("  raw.githubusercontent.com caches versions.json ~5 min, so updates may lag briefly.\n"));
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
