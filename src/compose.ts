import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { join } from "node:path";
import { RUNTIME_DIR } from "./config";

const BASE_ARGS = ["compose", "-f", join(RUNTIME_DIR, "docker-compose.yml"), "--project-directory", RUNTIME_DIR];

/** Runs `docker compose <args>` attached to the user's terminal. */
export function compose(args: string[], options: SpawnSyncOptions = {}): number {
  const result = spawnSync("docker", [...BASE_ARGS, ...args], { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Like compose(), but throws on a non-zero exit. */
export function composeOrThrow(args: string[], options: SpawnSyncOptions = {}): void {
  const status = compose(args, options);
  if (status !== 0) throw new Error(`docker compose ${args.join(" ")} failed (exit ${status})`);
}

/** Runs `docker compose <args>` and returns captured stdout. */
export function composeOutput(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", [...BASE_ARGS, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `The app did not become healthy within ${Math.round(timeoutMs / 1000)}s (${lastError}).\n` +
      `Check the logs with: agent logs app`
  );
}
