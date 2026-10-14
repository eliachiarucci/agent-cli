import { spawn, type ChildProcess } from "node:child_process";
import { cameraInput, IS_MAC } from "./media";

// The camera through one ffmpeg process with two outputs at 2 fps: JPEGs on
// stdout (the frames sent) and a 64×36 grey copy on fd 3 (the change check,
// done here so no image library is needed). Only the newest of each is kept.

const FPS = 2;
const SMALL_W = 64;
const SMALL_H = 36;
const SMALL_BYTES = SMALL_W * SMALL_H;
// A small-frame pixel counts as changed past this difference (0–255); webcam
// noise stays well under it once averaged down to 64×36.
const PIXEL_DELTA = 16;

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export class Camera {
  latest: Buffer | null = null;
  private small: Buffer | null = null;
  private process: ChildProcess | null = null;
  private stopped = false;

  constructor(
    private readonly device: string,
    readonly size: string,
    private readonly onFatal: (message: string) => void
  ) {}

  start(mjpeg = true): void {
    const startedAt = Date.now();
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        ...cameraInput(this.device, this.size, mjpeg),
        "-filter_complex", `[0:v]fps=${FPS},split=2[full][s];[s]scale=${SMALL_W}:${SMALL_H},format=gray[small]`,
        "-map", "[full]", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1",
        "-map", "[small]", "-f", "rawvideo", "pipe:3",
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] }
    );
    this.process = ff;
    let errors = "";
    ff.stderr!.on("data", (d: Buffer) => {
      // avfoundation reports its pixel-format negotiation as errors, then picks a supported one.
      const lines = d.toString().split("\n").filter((l) => l.trim() && !/pixel format|^\[in#\d+ @ [^\]]+\]\s+\w+$/.test(l));
      errors += lines.join("\n");
    });

    let pending = Buffer.alloc(0);
    ff.stdout!.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      // A JPEG runs from SOI to EOI; the encoder byte-stuffs FF in the data, so FF D9 only ends it.
      for (;;) {
        const start = pending.indexOf(SOI);
        const end = start < 0 ? -1 : pending.indexOf(EOI, start + 2);
        if (end < 0) break;
        this.latest = Buffer.from(pending.subarray(start, end + 2));
        pending = pending.subarray(end + 2);
      }
    });
    let smallPending = Buffer.alloc(0);
    (ff.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      smallPending = Buffer.concat([smallPending, chunk]);
      while (smallPending.length >= SMALL_BYTES) {
        this.small = Buffer.from(smallPending.subarray(0, SMALL_BYTES));
        smallPending = smallPending.subarray(SMALL_BYTES);
      }
    });

    ff.on("error", (error) => this.onFatal(`ffmpeg failed to start: ${error.message}`));
    ff.on("exit", (code) => {
      if (this.stopped) return;
      // Some Linux cameras don't offer MJPEG: try once more with their raw format.
      if (!IS_MAC && mjpeg && Date.now() - startedAt < 5000) {
        this.start(false);
        return;
      }
      const hint = IS_MAC
        ? " (does this terminal have camera permission? System Settings → Privacy & Security → Camera)"
        : " (is the user in the video group? agent-device devices lists the cameras)";
      this.onFatal(`The camera stopped (ffmpeg exit ${code})${hint}${errors ? `:\n${errors.slice(-500)}` : ""}`);
    });
  }

  stop(): void {
    this.stopped = true;
    this.process?.kill();
  }

  /** The current small frame, to compare later ones with. */
  snapshot(): Buffer | null {
    return this.small;
  }

  /** The fraction of the view that changed since `reference` (1 without one). */
  changeSince(reference: Buffer | null): number {
    if (!reference || !this.small) return 1;
    let changed = 0;
    for (let i = 0; i < SMALL_BYTES; i++) if (Math.abs(this.small[i] - reference[i]) > PIXEL_DELTA) changed++;
    return changed / SMALL_BYTES;
  }
}

/** A region of a JPEG (fractions of its width and height), cropped by ffmpeg. */
export function cropJpeg(jpeg: Buffer, region: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const f = (n: number) => Math.min(Math.max(n, 0), 1).toFixed(4);
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-f", "jpeg_pipe", "-i", "pipe:0",
        "-vf", `crop=iw*${f(region.w)}:ih*${f(region.h)}:iw*${f(region.x)}:ih*${f(region.y)}`,
        "-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const chunks: Buffer[] = [];
    let errors = "";
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.stderr.on("data", (d: Buffer) => (errors += d.toString()));
    ff.on("error", reject);
    ff.on("exit", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errors.trim() || `ffmpeg exit ${code}`))));
    ff.stdin.end(jpeg);
  });
}
