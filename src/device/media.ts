import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// Cameras, microphones and the speaker, through ffmpeg (capture) and the
// system's player (afplay on macOS, aplay on Linux). Devices are named by what
// ffmpeg opens: on macOS the device's name (it survives others being plugged
// in), on Linux the V4L2 node and the ALSA device.

export type MediaDevice = { id: string; name: string };
export const IS_MAC = process.platform === "darwin";

export function hasCommand(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

/** macOS: ffmpeg's avfoundation listing. Screens aren't cameras. */
async function avfoundationDevices(): Promise<{ video: MediaDevice[]; audio: MediaDevice[] }> {
  const out = await new Promise<string>((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let text = "";
    ff.stderr.on("data", (d: Buffer) => (text += d.toString()));
    ff.on("error", reject);
    ff.on("exit", () => resolve(text));
  });
  const video: MediaDevice[] = [];
  const audio: MediaDevice[] = [];
  let list: MediaDevice[] | null = null;
  for (const line of out.split("\n")) {
    if (/video devices:/i.test(line)) list = video;
    else if (/audio devices:/i.test(line)) list = audio;
    const m = /\] \[(\d+)\] (.+)$/.exec(line);
    if (m && list && !/^Capture screen/i.test(m[2])) list.push({ id: m[2].trim(), name: m[2].trim() });
  }
  return { video, audio };
}

/** Linux: V4L2 capture nodes (index 0 of each camera; the others are metadata) and ALSA cards. */
function linuxDevices(): { video: MediaDevice[]; audio: MediaDevice[] } {
  const video: MediaDevice[] = [];
  const base = "/sys/class/video4linux";
  if (existsSync(base)) {
    for (const node of readdirSync(base).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      const read = (f: string) => {
        try {
          return readFileSync(`${base}/${node}/${f}`, "utf8").trim();
        } catch {
          return "";
        }
      };
      if (read("index") !== "" && read("index") !== "0") continue;
      video.push({ id: `/dev/${node}`, name: `${read("name") || node} (/dev/${node})` });
    }
  }
  const audio: MediaDevice[] = [];
  try {
    // " 1 [Device         ]: USB-Audio - USB PnP Sound Device"
    for (const line of readFileSync("/proc/asound/cards", "utf8").split("\n")) {
      const m = /^\s*\d+\s+\[(\S+)\s*\]:\s*(.+)$/.exec(line);
      if (m) audio.push({ id: `plughw:CARD=${m[1]}`, name: `${m[2].split(" - ").pop()} (plughw:CARD=${m[1]})` });
    }
  } catch {
    // No ALSA.
  }
  return { video, audio };
}

export async function listDevices(): Promise<{ video: MediaDevice[]; audio: MediaDevice[] }> {
  return IS_MAC ? avfoundationDevices() : linuxDevices();
}

/** ffmpeg input arguments for a camera ("default" = the first one). */
export function cameraInput(camera: string, size: string, mjpeg = true): string[] {
  if (IS_MAC) return ["-f", "avfoundation", "-framerate", "30", "-video_size", size, "-i", `${camera}:none`];
  const node = camera === "default" ? linuxDevices().video[0]?.id ?? "/dev/video0" : camera;
  return ["-f", "v4l2", ...(mjpeg ? ["-input_format", "mjpeg"] : []), "-video_size", size, "-i", node];
}

/** ffmpeg input arguments for a microphone, giving 16 kHz mono s16le after the output options. */
export function micInput(microphone: string): string[] {
  if (IS_MAC) return ["-f", "avfoundation", "-i", `:${microphone}`];
  return ["-f", "alsa", "-i", microphone];
}

/** The player for speech clips and the formats it takes, or null without one. */
export function player(): { command: string; args: (file: string) => string[]; formats: string[] } | null {
  if (IS_MAC) return { command: "afplay", args: (f) => [f], formats: ["wav", "mp3", "aiff"] };
  if (hasCommand("aplay")) return { command: "aplay", args: (f) => ["-q", f], formats: ["wav"] };
  if (hasCommand("ffplay")) {
    return { command: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "error", f], formats: ["wav", "mp3"] };
  }
  return null;
}
