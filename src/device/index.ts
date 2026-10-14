import { openSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { ReadStream } from "node:tty";
import { CLI_VERSION } from "../version";
import {
  CREDENTIALS_PATH,
  DEFAULT_SETTINGS,
  SETTINGS_PATH,
  readCredentials,
  readSettings,
  settingsExist,
  writeSettings,
  type Settings,
} from "./files";
import { EXIT_FINAL, Link } from "./link";
import { IS_MAC, hasCommand, listDevices, player, type MediaDevice } from "./media";
import { configOwner, installService, serviceStatus, uninstallService } from "./service";

const USAGE = `agent-device ${CLI_VERSION}: this computer's camera, microphone and speaker for an agent

An agent sees, hears and speaks through its devices. Set one up from the agent's Settings → Devices
(Add device), which shows the command that installs and pairs it.

Usage:
  agent-device [run]                 Connect and stream (asks for the devices on the first run)
  agent-device setup                 Choose the camera, microphone and speaker
  agent-device devices               List the cameras and microphones
  agent-device status                Show the pairing, the chosen devices and the service
  sudo agent-device service install  Run it as a service, started at boot (Linux)
  sudo agent-device service uninstall
  agent-device --version
`;

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

// Under `curl | sh` stdin is the script; the install script hands over the
// terminal (< /dev/tty), and this is the fallback.
function terminal(): ReadStream | null {
  if (process.stdin.isTTY) return process.stdin as ReadStream;
  try {
    return new ReadStream(openSync("/dev/tty", "r"));
  } catch {
    return null;
  }
}

/** An arrow-key menu; returns the chosen option's index. */
function choose(input: ReadStream, title: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    let cursor = 0;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const draw = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${options.length + 1}A`);
      process.stdout.write(`\x1b[2K${title} \x1b[2m(↑/↓, enter)\x1b[0m\n`);
      options.forEach((o, i) =>
        process.stdout.write(`\x1b[2K${i === cursor ? `\x1b[32m❯\x1b[0m \x1b[1m${o}\x1b[0m` : `  ${o}`}\n`)
      );
    };
    const onKey = (_s: string, key: { name?: string; ctrl?: boolean }) => {
      if (key?.ctrl && key.name === "c") process.exit(130);
      if (key?.name === "up") cursor = (cursor - 1 + options.length) % options.length;
      else if (key?.name === "down") cursor = (cursor + 1) % options.length;
      else if (key?.name === "return") {
        input.removeListener("keypress", onKey);
        input.setRawMode(false);
        input.pause();
        return resolve(cursor);
      } else return;
      draw(false);
    };
    input.on("keypress", onKey);
    draw(true);
  });
}

async function pick(input: ReadStream, kind: string, devices: MediaDevice[]): Promise<string | null> {
  const options = [...devices.map((d) => d.name), `The system's default ${kind}`, `No ${kind}`];
  const i = await choose(input, `Which ${kind}?`, options);
  return i < devices.length ? devices[i].id : i === devices.length ? "default" : null;
}

function requireFfmpeg(): void {
  if (!hasCommand("ffmpeg")) {
    fail(`agent-device needs ffmpeg: ${IS_MAC ? "brew install ffmpeg" : "sudo apt install ffmpeg alsa-utils"}`);
  }
}

/** Asks for the devices in a terminal; without one, takes the default of each kind there is. */
async function setup(): Promise<Settings> {
  requireFfmpeg();
  const input = terminal();
  if (!input) {
    const { video, audio } = await listDevices();
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      camera: IS_MAC || video.length ? "default" : null,
      microphone: IS_MAC || audio.length ? "default" : null,
      speaker: player() !== null,
    };
    writeSettings(settings);
    const found = [settings.camera && "camera", settings.microphone && "microphone", settings.speaker && "speaker"].filter(Boolean);
    console.log(`No terminal to ask in: using the default ${found.join(", ") || "nothing"} (agent-device setup changes it).`);
    return settings;
  }
  const { video, audio } = await listDevices();
  const camera = await pick(input, "camera", video);
  const microphone = await pick(input, "microphone", audio);
  const canPlay = player() !== null;
  const speaker = canPlay ? (await choose(input, "Use the speaker?", ["Yes", "No"])) === 0 : false;
  // Talking over a reply needs the mic open while it plays: only safe with headphones.
  const fullDuplex =
    microphone !== null && speaker
      ? (await choose(input, "Will the speaker be headphones?", [
          "Yes: keep the microphone open, so people can talk over a reply",
          "No: mute the microphone while a reply plays",
        ])) === 0
      : false;
  input.destroy();
  const settings: Settings = { ...DEFAULT_SETTINGS, camera, microphone, speaker, fullDuplex };
  writeSettings(settings);
  console.log(`Saved to ${SETTINGS_PATH}.`);
  return settings;
}

async function runDevice(): Promise<void> {
  const credentials = readCredentials();
  if (!credentials) {
    fail(`Not paired (${CREDENTIALS_PATH} is missing). Add the device on the agent's Settings → Devices and run the command shown there.`, EXIT_FINAL);
  }
  requireFfmpeg();
  const settings = settingsExist() ? readSettings()! : await setup();
  new Link(credentials, settings, CLI_VERSION, fail).start();
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "run":
      return runDevice();
    case "setup":
      await setup();
      return;
    case "devices": {
      requireFfmpeg();
      const { video, audio } = await listDevices();
      console.log("Cameras:\n" + (video.map((d) => `  ${d.name}`).join("\n") || "  none"));
      console.log("Microphones:\n" + (audio.map((d) => `  ${d.name}`).join("\n") || "  none"));
      return;
    }
    case "status": {
      const credentials = readCredentials();
      const settings = readSettings();
      console.log(`Paired:   ${credentials ? `${credentials.server} (device ${credentials.deviceId})` : "no"}`);
      console.log(`Config:   ${configOwner()}`);
      console.log(
        `Devices:  ${settings ? `camera ${settings.camera ?? "none"}, microphone ${settings.microphone ?? "none"}, speaker ${settings.speaker ? "on" : "off"}` : "not chosen yet (agent-device setup)"}`
      );
      console.log(`Service:  ${serviceStatus()}`);
      return;
    }
    case "service":
      if (args[0] === "install") return installService();
      if (args[0] === "uninstall") return uninstallService();
      fail("Usage: sudo agent-device service install | uninstall");
    case "version":
    case "--version":
    case "-v":
      console.log(CLI_VERSION);
      return;
    default:
      console.log(USAGE);
      process.exitCode = command === "help" || command === "--help" ? 0 : 1;
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
