import { openSync } from "node:fs";
import { compose, composeOutput } from "../compose";
import { ask } from "../tty";

// User management runs inside the app container (dist/users.js — the only
// place accounts can be created; public signup is disabled in the backend).

/** Interactive in-container run; the password prompt needs a real TTY. */
function execUsersInteractive(args: string[]): number {
  // Under `curl | bash` stdin is not a TTY — hand docker a /dev/tty fd so
  // `exec -it` can allocate one for the in-container password prompt.
  const stdin = process.stdin.isTTY ? 0 : openSync("/dev/tty", "r");
  return compose(["exec", "-it", "app", "node", "dist/users.js", ...args], {
    stdio: [stdin, "inherit", "inherit"],
  });
}

export function hasUsers(): boolean {
  const { status, stdout } = composeOutput(["exec", "-T", "app", "node", "dist/users.js", "list"]);
  return status === 0 && !stdout.includes("No users.");
}

export async function createFirstUser(): Promise<void> {
  const username = await ask("Username");
  if (!username) {
    console.log("Skipped. Create your account later with: agent users create <username>");
    return;
  }
  const name = await ask("Full name", username);
  const status = execUsersInteractive(["create", username, "--name", name]);
  if (status !== 0) {
    console.log("User creation failed — try again with: agent users create " + username);
  }
}

export function users(args: string[]): void {
  if (args[0] === "list") {
    process.exitCode = compose(["exec", "-T", "app", "node", "dist/users.js", "list"]);
    return;
  }
  if (args.length === 0) args = ["--help"];
  process.exitCode = execUsersInteractive(args);
}
