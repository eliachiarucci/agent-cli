/**
 * Release helper for the three-repo agent stack.
 *
 * Interactively (or via flags) bumps the patch version of the Backend and/or UI,
 * then runs the full rollout: tag + push each selected repo, wait for its CI to
 * build and push the image, and only then bump agent-cli/versions.json so a
 * rolled-out version never points at an image that failed to build.
 *
 * Usage:
 *   npm run release                      # asks release type + services, then confirms
 *   npm run release -- --backend --ui    # preselect services, still confirms
 *   npm run release -- --minor           # patch (default) | minor | major bump
 *   npm run release -- --backend --yes   # skip prompts (defaults to a patch bump)
 *   npm run release -- --dry-run         # show the plan, touch nothing
 *
 * CI polling uses the public GitHub Actions REST API (no `gh` needed). Set
 * GITHUB_TOKEN / GH_TOKEN to raise the unauthenticated rate limit if needed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface, emitKeypressEvents } from "node:readline";
import * as path from "node:path";

type ServiceKey = "backend" | "ui";
interface Service {
  key: ServiceKey;
  label: string;
  repo: string;
}

const ROOT = path.resolve(__dirname, ".."); // agent-cli
const VERSIONS_PATH = path.join(ROOT, "versions.json");
const SERVICES: Service[] = [
  { key: "backend", label: "Backend", repo: path.resolve(ROOT, "../agent") },
  { key: "ui", label: "UI", repo: path.resolve(ROOT, "../agent-ui") },
];

const CI_TIMEOUT_MS = 15 * 60 * 1000;
const CI_POLL_MS = 10_000;

// ── tiny ANSI helpers ──────────────────────────────────────────────────────
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

type BumpType = "patch" | "minor" | "major";
const BUMP_TYPES: BumpType[] = ["patch", "minor", "major"]; // order = menu order; patch is the default

function bumpVersion(version: string, type: BumpType): string {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Unrecognized version string: ${version}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (type === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (type === "minor") [minor, patch] = [minor + 1, 0];
  else patch += 1;
  return `v${major}.${minor}.${patch}`;
}

function repoSlug(repo: string): string {
  const url = git(repo, ["config", "--get", "remote.origin.url"]);
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`Cannot parse GitHub owner/repo from remote: ${url}`);
  return m[1];
}

// ── interactive single-select radio ────────────────────────────────────────
function selectOne(title: string, options: { label: string; hint: string }[], def: number): Promise<number> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return resolve(def);

    let cursor = def;
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    const draw = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${options.length + 1}A`);
      process.stdout.write(`\x1b[2K${title}\n`);
      options.forEach((o, i) => {
        const pointer = i === cursor ? green("❯") : " ";
        const text = o.label.padEnd(7);
        process.stdout.write(`\x1b[2K${pointer} ${i === cursor ? bold(text) : text} ${dim(o.hint)}\n`);
      });
    };

    const finish = (val: number | null): void => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (val === null) process.exit(130);
      resolve(val);
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") return finish(null);
      if (key.name === "up") ((cursor = (cursor - 1 + options.length) % options.length), draw(false));
      else if (key.name === "down") ((cursor = (cursor + 1) % options.length), draw(false));
      else if (key.name === "return") finish(cursor);
    };

    stdin.on("keypress", onKey);
    draw(true);
  });
}

// ── interactive checkbox multi-select ──────────────────────────────────────
function multiSelect(services: Service[], versions: Record<string, string>, bump: BumpType): Promise<Service[]> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return resolve(services.slice()); // non-TTY: take all

    const selected = services.map(() => true); // default: everything selected
    let cursor = 0;
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    const header = "Select services to release " + dim("(↑/↓ move · space toggle · a all · enter confirm)");
    const draw = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${services.length + 1}A`);
      process.stdout.write(`\x1b[2K${header}\n`);
      services.forEach((s, i) => {
        const pointer = i === cursor ? bold("❯") : " ";
        const box = selected[i] ? green("◉") : "◯";
        const jump = `${versions[s.key]} → ${bumpVersion(versions[s.key], bump)}`;
        process.stdout.write(`\x1b[2K${pointer} ${box} ${s.label.padEnd(8)} ${dim(jump)}\n`);
      });
    };

    const finish = (result: Service[] | null) => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (result === null) process.exit(130);
      resolve(result);
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") return finish(null);
      switch (key.name) {
        case "up":
          cursor = (cursor - 1 + services.length) % services.length;
          return draw(false);
        case "down":
          cursor = (cursor + 1) % services.length;
          return draw(false);
        case "space":
          selected[cursor] = !selected[cursor];
          return draw(false);
        case "a": {
          const all = selected.every(Boolean);
          selected.fill(!all);
          return draw(false);
        }
        case "return":
          return finish(services.filter((_, i) => selected[i]));
      }
    };

    stdin.on("keypress", onKey);
    draw(true);
  });
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

async function waitForCi(label: string, slug: string, tag: string): Promise<boolean> {
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < CI_TIMEOUT_MS) {
    let runs: Run[];
    try {
      runs = await fetchRuns(slug, tag);
    } catch (err) {
      console.log(`  ${yellow("!")} ${label}: ${(err as Error).message} — retrying`);
      await sleep(CI_POLL_MS);
      continue;
    }
    if (runs.length === 0) {
      if (!announced) console.log(`  ${dim("·")} ${label}: waiting for CI to start…`);
      announced = true;
      await sleep(CI_POLL_MS);
      continue;
    }
    const running = runs.filter((r) => r.status !== "completed");
    if (running.length > 0) {
      console.log(`  ${dim("·")} ${label}: ${runs.length} run(s), ${running.length} in progress…`);
      await sleep(CI_POLL_MS);
      continue;
    }
    const failed = runs.filter((r) => r.conclusion !== "success");
    if (failed.length > 0) {
      console.log(`  ${red("✗")} ${label}: CI failed — ${failed.map((r) => `${r.name} (${r.conclusion})`).join(", ")}`);
      failed.forEach((r) => console.log(`      ${dim(r.html_url)}`));
      return false;
    }
    console.log(`  ${green("✓")} ${label}: CI green — ${runs.map((r) => r.name).join(", ")}`);
    return true;
  }
  console.log(`  ${red("✗")} ${label}: timed out after ${CI_TIMEOUT_MS / 60000} min waiting for CI`);
  return false;
}

// ── main ───────────────────────────────────────────────────────────────────
interface Plan {
  service: Service;
  slug: string;
  current: string;
  next: string;
  tagExists: boolean;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const autoYes = argv.includes("--yes") || argv.includes("-y");
  const flagged = SERVICES.filter((s) => argv.includes(`--${s.key}`));
  const bumpFlag = BUMP_TYPES.find((t) => argv.includes(`--${t}`));

  const versions = JSON.parse(readFileSync(VERSIONS_PATH, "utf8")) as Record<string, string>;

  console.log(bold("\n  agent release\n"));

  // Release type — patch is the default (first option, and the headless fallback).
  const bumpType: BumpType =
    bumpFlag ??
    (autoYes
      ? "patch"
      : BUMP_TYPES[
          await selectOne(
            "Release type " + dim("(↑/↓ · enter)"),
            [
              { label: "patch", hint: "0.0.X — fixes" },
              { label: "minor", hint: "0.X.0 — features" },
              { label: "major", hint: "X.0.0 — breaking changes" },
            ],
            0,
          )
        ]);

  const chosen = flagged.length > 0 ? flagged : await multiSelect(SERVICES, versions, bumpType);
  if (chosen.length === 0) {
    console.log(yellow("Nothing selected — aborting."));
    return;
  }

  // Pre-flight + build the plan.
  const plans: Plan[] = [];
  const errors: string[] = [];
  for (const service of chosen) {
    const { repo, label } = service;
    const current = versions[service.key];
    if (!current) {
      errors.push(`${label}: no "${service.key}" entry in versions.json`);
      continue;
    }
    const next = bumpVersion(current, bumpType);
    const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== "main") errors.push(`${label}: on branch "${branch}", expected "main"`);
    if (git(repo, ["status", "--porcelain"])) errors.push(`${label}: working tree is dirty — commit or stash first`);

    const tagExists = git(repo, ["tag", "--list", next]) === next;
    if (tagExists) {
      const tagCommit = git(repo, ["rev-list", "-n", "1", next]);
      const head = git(repo, ["rev-parse", "HEAD"]);
      if (tagCommit !== head) errors.push(`${label}: tag ${next} already exists on a different commit`);
    }
    plans.push({ service, slug: repoSlug(repo), current, next, tagExists });
  }

  if (errors.length > 0) {
    console.log(red("Pre-flight failed:"));
    errors.forEach((e) => console.log(`  ${red("✗")} ${e}`));
    process.exit(1);
  }

  // Preview.
  console.log(`  Planned release ${dim(`(${bumpType})`)}:\n`);
  for (const p of plans) {
    const note = p.tagExists ? dim(" (tag exists → reuse)") : "";
    console.log(`    ${p.service.label.padEnd(8)} ${p.current} ${dim("→")} ${bold(p.next)}   ${dim(p.slug)}${note}`);
  }
  console.log(`\n  ${dim("versions.json")} will be updated after CI passes.`);
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

  // 1. Tag + push each selected repo.
  console.log("");
  for (const p of plans) {
    const { repo } = p.service;
    if (!p.tagExists) git(repo, ["tag", p.next]);
    git(repo, ["push", "origin", "main", p.next]);
    console.log(`  ${green("✓")} ${p.service.label}: pushed ${bold(p.next)}`);
  }

  // 2. Wait for every selected repo's CI in parallel.
  console.log(bold("\n  Waiting for CI…"));
  const results = await Promise.all(plans.map((p) => waitForCi(`${p.service.label} ${p.next}`, p.slug, p.next)));
  if (results.some((ok) => !ok)) {
    console.log(red("\n  CI did not pass for every service — versions.json left untouched."));
    console.log(dim("  Tags are pushed; fix CI and re-run to finish the rollout."));
    process.exit(1);
  }

  // 3. Roll out versions.json.
  for (const p of plans) versions[p.service.key] = p.next;
  writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, 2) + "\n");
  const summary = plans.map((p) => `${p.service.key} ${p.next}`).join(", ");
  git(ROOT, ["add", "versions.json"]);
  git(ROOT, ["commit", "-m", `chore: ${summary}`, "--", "versions.json"]);
  git(ROOT, ["push"]);
  console.log(`  ${green("✓")} versions.json rolled out — ${bold(summary)}`);

  console.log(green("\n  Release complete."));
  console.log(dim("  Note: `agent update` reads versions.json via a CDN with ~5 min cache;"));
  console.log(dim("  it may report \"Already up to date\" briefly. That's the CDN, not a failed rollout.\n"));
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
