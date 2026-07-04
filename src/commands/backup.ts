import { closeSync, existsSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeOutput, composeToFd } from "../compose";
import { loadConfig } from "../config";

const USAGE = `Usage: agent backup [file-or-directory] [--files]

Dumps the database to agent-backup-YYYY-MM-DD.dump in the current directory
(or the given path) using pg_dump's custom format — restore with pg_restore.
--files also archives agent-created files to agent-files-YYYY-MM-DD.tar.gz.
Restore procedure: https://github.com/eliachiarucci/agent/blob/main/docs/install.md#backups`;

function runningServices(): string[] {
  return composeOutput(["ps", "--status", "running", "--services"])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Streams a container command's stdout into <target> via a .partial file, so
// a failed dump never leaves a plausible-looking backup under the final name.
function dumpTo(target: string, execArgs: string[]): void {
  const partial = `${target}.partial`;
  const fd = openSync(partial, "w");
  let result: { status: number; stderr: string };
  try {
    result = composeToFd(["exec", "-T", ...execArgs], fd);
  } finally {
    closeSync(fd);
  }
  if (result.status !== 0) {
    rmSync(partial, { force: true });
    throw new Error(`Backup failed (exit ${result.status}):\n${result.stderr.trim()}`);
  }
  renameSync(partial, target);
}

function prettySize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function backup(args: string[]): void {
  loadConfig(); // fail early with a friendly message if never set up

  const includeFiles = args.includes("--files");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--files");
  if (unknown.length > 0 || positional.length > 1) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const running = runningServices();
  if (!running.includes("db")) {
    throw new Error("The database container is not running. Start the stack first: agent start");
  }
  if (includeFiles && !running.includes("app")) {
    throw new Error("--files needs the app container (it mounts the files volume). Start the stack first: agent start");
  }

  const date = new Date().toISOString().slice(0, 10);
  const dumpDefault = `agent-backup-${date}.dump`;
  const target = positional[0];
  const dumpFile =
    target && existsSync(target) && statSync(target).isDirectory()
      ? join(target, dumpDefault)
      : (target ?? dumpDefault);

  // Credentials come from the container's own environment, so this keeps
  // working if the rendered compose credentials ever change.
  dumpTo(dumpFile, ["db", "sh", "-c", 'pg_dump --format=custom -U "$POSTGRES_USER" "$POSTGRES_DB"']);
  console.log(`✓ Database dump: ${dumpFile} (${prettySize(statSync(dumpFile).size)})`);

  if (includeFiles) {
    const filesFile = join(dirname(dumpFile), `agent-files-${date}.tar.gz`);
    dumpTo(filesFile, ["app", "tar", "-czf", "-", "-C", "/files", "."]);
    console.log(`✓ Files archive: ${filesFile} (${prettySize(statSync(filesFile).size)})`);
  }

  console.log("Keep backups somewhere safe — they contain every user's data, including stored credentials.");
}
