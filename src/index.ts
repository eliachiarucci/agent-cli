import { configGet, configRebuild, configSet } from "./commands/config";
import { logs, restart, setup, start, status, stop, uninstall } from "./commands/setup";
import { selfUpdate, update } from "./commands/update";
import { users } from "./commands/users";
import { CLI_VERSION } from "./version";

const USAGE = `agent ${CLI_VERSION} — self-hosted personal assistant

Usage:
  agent setup                      Install and start everything (idempotent)
  agent start | stop | restart     Manage the stack
  agent status                     Show containers, versions, and health
  agent logs [service] [-f]        Tail logs (services: app, ui, db, searxng)
  agent users list                 List accounts
  agent users create <username> [--name "Full Name"]
  agent users remove <username>
  agent config get [key]           Show configuration
  agent config set <key> <value>   Change port, appOrigin, or startWebUi
  agent config rebuild [--force]   Reconstruct a lost/corrupt config.json from the runtime files
  agent update                     Update CLI, images, and database schema
  agent self-update                Update only the CLI binary
  agent uninstall                  Remove the stack (data wiped only on confirm)
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "setup":
      return setup();
    case "start":
      return start();
    case "stop":
      return stop();
    case "restart":
      return restart();
    case "status":
      return status();
    case "logs":
      return logs(args);
    case "users":
      return users(args);
    case "config":
      if (args[0] === "get") return configGet(args[1]);
      if (args[0] === "set" && args[1] && args[2] !== undefined) return configSet(args[1], args[2]);
      if (args[0] === "rebuild") return configRebuild(args.includes("--force"));
      console.error("Usage: agent config get [key] | agent config set <key> <value> | agent config rebuild [--force]");
      process.exitCode = 1;
      return;
    case "update":
      return update(args);
    case "self-update":
      return selfUpdate();
    case "uninstall":
      return uninstall();
    case "version":
    case "--version":
    case "-v":
      console.log(CLI_VERSION);
      return;
    default:
      console.log(USAGE);
      process.exitCode = command === undefined || command === "help" || command === "--help" ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
