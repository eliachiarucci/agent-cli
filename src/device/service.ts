import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { CONFIG_DIR } from "./files";
import { hasCommand } from "./media";

// Linux: agent-device as a systemd service, so it starts at boot and comes
// back after a crash. It runs as the user who installed it (their
// ~/.config/agent-device), in the video and audio groups. macOS runs it in a
// terminal instead: background processes there don't get the camera and
// microphone permission prompt.

const UNIT = "agent-device.service";
const UNIT_PATH = `/etc/systemd/system/${UNIT}`;

function run(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: "inherit" }).status === 0;
}

function requireSystemd(): void {
  if (process.platform !== "linux" || !hasCommand("systemctl")) {
    throw new Error("The service needs Linux with systemd. On macOS, run agent-device in a terminal.");
  }
  if (process.getuid?.() !== 0) throw new Error("Run it with sudo: sudo agent-device service install");
}

export function installService(): void {
  requireSystemd();
  const user = process.env.SUDO_USER;
  if (!user || user === "root") throw new Error("Run it with sudo from the user the device should run as.");
  const home = spawnSync("getent", ["passwd", user], { encoding: "utf8" }).stdout.split(":")[5]?.trim();
  if (!home || !existsSync(`${home}/.config/agent-device/device.json`)) {
    throw new Error(`${user} has no paired device (${home}/.config/agent-device/device.json). Run the install command first.`);
  }
  writeFileSync(
    UNIT_PATH,
    [
      "[Unit]",
      "Description=agent-device: this computer's camera, microphone and speaker for an agent",
      "Wants=network-online.target",
      "After=network-online.target sound.target",
      "",
      "[Service]",
      `User=${user}`,
      "SupplementaryGroups=video audio",
      `Environment=HOME=${home}`,
      `ExecStart=${process.execPath} run`,
      "Restart=always",
      "RestartSec=5",
      // Exit 3: the server said not to reconnect (paired again, deleted, replaced).
      "RestartPreventExitStatus=3",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n")
  );
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["enable", UNIT]);
  if (!run("systemctl", ["restart", UNIT])) throw new Error("The service didn't start: journalctl -u agent-device");
  console.log(`agent-device runs as a service (user ${user}). Logs: journalctl -u agent-device -f`);
}

export function uninstallService(): void {
  requireSystemd();
  run("systemctl", ["disable", "--now", UNIT]);
  rmSync(UNIT_PATH, { force: true });
  run("systemctl", ["daemon-reload"]);
  console.log("The agent-device service is removed (the pairing in ~/.config/agent-device stays).");
}

export function serviceStatus(): string {
  if (process.platform !== "linux" || !existsSync(UNIT_PATH)) return "not installed";
  const state = spawnSync("systemctl", ["is-active", UNIT], { encoding: "utf8" }).stdout.trim();
  return state || "unknown";
}

export function configOwner(): string {
  return `${userInfo().username} (${CONFIG_DIR})`;
}
