import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { micInput, player } from "./media";

// The speaker (speech clips played back to back) and the microphone (16 kHz
// mono PCM with an energy VAD: a stretch of speech goes out as one segment,
// with 300 ms of pre-roll, ending after 300 ms of silence).

export type Played = { speechId: string; ok: boolean; durationMs: number; error?: string };

export class Speaker {
  private readonly player = player();
  private current: ChildProcess | null = null;
  private readonly queue: Array<{ speechId: string; file: string; dir: string }> = [];
  private busy = false;

  constructor(private readonly onPlayed: (played: Played) => void) {}

  get formats(): string[] {
    return this.player?.formats ?? [];
  }

  get playing(): boolean {
    return this.busy || this.queue.length > 0;
  }

  async enqueue(speechId: string, format: string, audio: Buffer): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "agent-device-"));
    const file = join(dir, `speech.${format.replace(/[^a-z0-9]/gi, "") || "wav"}`);
    await writeFile(file, audio);
    this.queue.push({ speechId, file, dir });
    if (!this.busy) void this.next();
  }

  private async next(): Promise<void> {
    const item = this.queue.shift();
    if (!item || !this.player) {
      this.busy = false;
      return;
    }
    this.busy = true;
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      this.current = spawn(this.player!.command, this.player!.args(item.file), { stdio: "ignore" });
      this.current.on("exit", (c) => resolve(c));
      this.current.on("error", () => resolve(1));
    });
    this.current = null;
    await rm(item.dir, { recursive: true, force: true });
    const ok = code === 0;
    this.onPlayed({ speechId: item.speechId, ok, durationMs: Date.now() - started, ...(!ok && { error: "Stopped" }) });
    void this.next();
  }

  /** Cuts the clip playing and drops the queue; dropped clips are reported as not played. */
  stop(): void {
    for (const item of this.queue.splice(0)) {
      this.onPlayed({ speechId: item.speechId, ok: false, durationMs: 0, error: "Stopped" });
      void rm(item.dir, { recursive: true, force: true });
    }
    this.current?.kill();
  }
}

const BYTES_PER_MS = 32; // 16 kHz s16le mono
const FRAME_MS = 30;

export class Microphone {
  private process: ChildProcess | null = null;
  private stopped = false;
  private segment = 0;

  constructor(
    private readonly device: string,
    // True while the microphone should be deaf (a reply playing, half duplex).
    private readonly muted: () => boolean,
    private readonly send: (segment: string, pcm: Buffer, flags?: { start?: boolean; end?: boolean }) => void,
    private readonly onFatal: (message: string) => void
  ) {}

  start(): void {
    const ff = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", ...micInput(this.device), "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.process = ff;
    let errors = "";
    ff.stderr!.on("data", (d: Buffer) => (errors += d.toString()));
    ff.on("error", (error) => this.onFatal(`ffmpeg failed to start: ${error.message}`));
    ff.on("exit", (code) => {
      if (this.stopped) return;
      this.onFatal(`The microphone stopped (ffmpeg exit ${code})${errors ? `:\n${errors.slice(-500)}` : ""}`);
    });

    const frameBytes = FRAME_MS * BYTES_PER_MS;
    let pending = Buffer.alloc(0);
    const preroll: Buffer[] = [];
    let noise = 300; // RMS noise floor, adapts while silent
    let inSpeech = false;
    let silentMs = 0;
    let seg = "";
    ff.stdout!.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const frame = Buffer.from(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
        let sum = 0;
        for (let i = 0; i < frame.length; i += 2) {
          const v = frame.readInt16LE(i);
          sum += v * v;
        }
        const rms = Math.sqrt(sum / (frame.length / 2));
        const muted = this.muted();
        const voiced = !muted && rms > Math.max(noise * 3, 400);
        if (!inSpeech) {
          if (!voiced) noise = noise * 0.95 + rms * 0.05;
          preroll.push(frame);
          if (preroll.length > 300 / FRAME_MS) preroll.shift();
          if (voiced) {
            inSpeech = true;
            silentMs = 0;
            seg = `m${++this.segment}`;
            this.send(seg, Buffer.concat(preroll.splice(0)), { start: true });
          }
          continue;
        }
        this.send(seg, frame);
        silentMs = voiced ? 0 : silentMs + FRAME_MS;
        if (silentMs >= 300 || muted) {
          this.send(seg, Buffer.alloc(0), { end: true });
          inSpeech = false;
        }
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.process?.kill();
  }
}
