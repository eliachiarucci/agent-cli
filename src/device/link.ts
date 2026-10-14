import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import WebSocket from "ws";
import { Microphone, Speaker } from "./audio";
import { Camera, cropJpeg } from "./camera";
import type { Credentials, Settings } from "./files";

// The device link (the agent backend's lib/devices/protocol.ts): one
// WebSocket, JSON control messages, and binary messages framed as
// [u32 big-endian header length][JSON header][payload].

type DeviceConfig = {
  paused: boolean;
  heartbeatSec: number;
  minIntervalMs: number;
  changeThreshold: number;
};

// Close codes after which reconnecting is pointless (the server's gateway).
export const FINAL_CLOSES: Record<number, string> = {
  4000: "another connection took over this device",
  4001: "the device was paired again or its key was replaced",
  4002: "the device was deleted",
};
// systemd doesn't restart the service on this exit status (RestartPreventExitStatus).
export const EXIT_FINAL = 3;

function encode(header: object, payload: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json, payload]);
}

function decode(data: Buffer): { header: any; payload: Buffer } {
  const length = data.readUInt32BE(0);
  return { header: JSON.parse(data.subarray(4, 4 + length).toString("utf8")), payload: data.subarray(4 + length) };
}

function cpuTempC(): number | undefined {
  try {
    return Number(readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8")) / 1000;
  } catch {
    return undefined;
  }
}

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);

export class Link {
  private ws: WebSocket | null = null;
  private config: DeviceConfig | null = null;
  private backoffMs = 1000;
  private seq = 0;
  private audioSeq = 0;
  private lastSentAt = 0;
  private lastSentSmall: Buffer | null = null;
  private readonly camera: Camera | null;
  private readonly speaker: Speaker | null;
  private readonly microphone: Microphone | null;

  constructor(
    private readonly credentials: Credentials,
    private readonly settings: Settings,
    private readonly version: string,
    private readonly fail: (message: string, code?: number) => never
  ) {
    this.camera = settings.camera ? new Camera(settings.camera, settings.size, (m) => fail(m)) : null;
    this.speaker = settings.speaker ? new Speaker((played) => this.sendJson({ type: "played", ...played })) : null;
    if (this.speaker && this.speaker.formats.length === 0) {
      log("No audio player found (aplay or ffplay): the speaker is off.");
      this.speaker = null;
    }
    this.microphone = settings.microphone
      ? new Microphone(
          settings.microphone,
          () => !settings.fullDuplex && !!this.speaker?.playing,
          (segment, pcm, flags) => this.sendAudio(segment, pcm, flags),
          (m) => fail(m)
        )
      : null;
  }

  start(): void {
    if (!this.camera && !this.microphone && !this.speaker) this.fail("No camera, microphone or speaker: nothing to do. Run agent-device setup.");
    this.camera?.start();
    this.microphone?.start();
    log(
      [
        this.camera && `camera ${this.settings.camera} (${this.settings.size})`,
        this.microphone && `microphone ${this.settings.microphone}${this.settings.fullDuplex ? " (open while replies play)" : ""}`,
        this.speaker && "speaker",
      ]
        .filter(Boolean)
        .join(", ")
    );
    this.connect();
    setInterval(() => this.frameTick(), 250);
    setInterval(() => this.sendTelemetry(), 30_000);
    process.on("exit", () => {
      this.camera?.stop();
      this.microphone?.stop();
    });
  }

  private connect(): void {
    log(`Connecting to ${this.credentials.url}`);
    const ws = new WebSocket(this.credentials.url, { headers: { authorization: `Bearer ${this.credentials.token}` } });
    this.ws = ws;

    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        this.fail("The server refused this device's key. Pair it again (Settings → Devices → Pair again).", EXIT_FINAL);
      }
      log(`The server refused the connection (HTTP ${res.statusCode})`);
      ws.terminate();
    });
    ws.on("open", () => {
      this.backoffMs = 1000;
      log("Connected");
      this.sendJson({
        type: "hello",
        version: `agent-device/${this.version}`,
        capabilities: {
          ...(this.camera && { sizes: [this.settings.size] }),
          ...(this.speaker && { audio: this.speaker.formats }),
          ...(this.microphone && { microphone: ["pcm_s16le"] }),
        },
      });
      this.sendTelemetry();
    });
    ws.on("message", (data: Buffer, isBinary) => {
      if (isBinary) return void this.onBinary(data);
      const message = JSON.parse(data.toString());
      if (message.type === "config") {
        const { type: _type, ...config } = message;
        this.config = config;
      } else if (message.type === "capture") {
        void this.sendCapture(message.requestId, message.region);
      } else if (message.type === "stop_speech") {
        this.speaker?.stop();
      } else if (message.type === "error") {
        log(`Server error: ${message.message}`);
      }
    });
    ws.on("close", (code, reason) => {
      this.ws = null;
      if (FINAL_CLOSES[code]) this.fail(`Disconnected: ${FINAL_CLOSES[code]}.`, EXIT_FINAL);
      log(`Disconnected (${code}${reason.length ? ` ${reason}` : ""}); retrying in ${this.backoffMs / 1000} s`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
    ws.on("error", (error) => log(`Link error: ${error.message}`));
  }

  private open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private sendJson(message: object): void {
    if (this.open()) this.ws!.send(JSON.stringify(message));
  }

  // A frame when the view changed (at most every minIntervalMs) and a heartbeat
  // every heartbeatSec, as the server's config says; nothing while paused.
  private frameTick(): void {
    const config = this.config;
    if (!this.camera || !config || config.paused || !this.open() || !this.camera.latest) return;
    const since = Date.now() - this.lastSentAt;
    if (since >= config.heartbeatSec * 1000) return this.sendFrame("heartbeat");
    if (since >= config.minIntervalMs && this.camera.changeSince(this.lastSentSmall) > config.changeThreshold) {
      this.sendFrame("change");
    }
  }

  private sendFrame(trigger: "change" | "heartbeat" | "request", requestId?: string, jpeg = this.camera?.latest): void {
    if (!jpeg || !this.open()) return;
    this.ws!.send(encode({ type: "frame", seq: this.seq++, capturedAt: Date.now(), trigger, ...(requestId && { requestId }) }, jpeg));
    if (trigger !== "request") {
      this.lastSentAt = Date.now();
      this.lastSentSmall = this.camera?.snapshot() ?? null;
    }
  }

  // A capture request: the current frame, or a region of it.
  private async sendCapture(requestId: string, region?: { x: number; y: number; w: number; h: number }): Promise<void> {
    const jpeg = this.camera?.latest;
    if (!jpeg) return;
    try {
      this.sendFrame("request", requestId, region ? await cropJpeg(jpeg, region) : jpeg);
    } catch (error) {
      log(`Crop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async onBinary(data: Buffer): Promise<void> {
    const { header, payload } = decode(data);
    if (header?.type !== "speech" || !this.speaker) return;
    await this.speaker.enqueue(String(header.speechId), String(header.format ?? "wav"), payload);
  }

  private sendAudio(segment: string, pcm: Buffer, flags: { start?: boolean; end?: boolean } = {}): void {
    if (!this.open()) return;
    this.ws!.send(
      encode({ type: "audio", segment, seq: this.audioSeq++, format: "pcm_s16le", sampleRate: 16000, ...flags }, pcm)
    );
  }

  private sendTelemetry(): void {
    const cpu = cpuTempC();
    this.sendJson({ type: "telemetry", uptimeS: Math.round(uptime()), ...(cpu !== undefined && { cpuTempC: cpu }) });
  }
}
