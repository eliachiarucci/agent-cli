import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where agent-device keeps its state, for the user it runs as:
//   device.json    what pairing gave it: the server, the link's URL, the device's token.
//                  Written by the install script (also with --pair-only, for other device
//                  software to read), mode 600.
//   settings.json  which camera, microphone and speaker to use (agent-device setup).
export const CONFIG_DIR = process.env.AGENT_DEVICE_DIR ?? join(homedir(), ".config", "agent-device");
export const CREDENTIALS_PATH = join(CONFIG_DIR, "device.json");
export const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");

export type Credentials = { server: string; url: string; token: string; deviceId: string };

// null = not used. "default" = the system's default device.
export type Settings = {
  camera: string | null;
  microphone: string | null;
  speaker: boolean;
  // Keep the microphone open while a reply plays, so people can talk over it.
  // Only with headphones: from speakers the reply would interrupt itself.
  fullDuplex: boolean;
  // The camera's capture size.
  size: string;
};

export const DEFAULT_SETTINGS: Settings = {
  camera: "default",
  microphone: "default",
  speaker: true,
  fullDuplex: false,
  size: "1280x720",
};

export function readCredentials(): Credentials | null {
  try {
    const value = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as Partial<Credentials>;
    if (value.url && value.token) return value as Credentials;
  } catch {
    // Missing or unreadable: not paired.
  }
  return null;
}

export function readSettings(): Settings | null {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<Settings>) };
  } catch {
    return null;
  }
}

export function writeSettings(settings: Settings): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  chmodSync(SETTINGS_PATH, 0o600);
}

export function settingsExist(): boolean {
  return existsSync(SETTINGS_PATH);
}
