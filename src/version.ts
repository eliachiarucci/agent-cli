import { readFileSync } from "node:fs";
import { join } from "node:path";

// Injected by esbuild `define` in release builds (build.mjs). When running
// from source via tsx they are undefined and we fall back to versions.json.
declare const __CLI_VERSION__: string;
declare const __BACKEND_TAG__: string;
declare const __UI_TAG__: string;

export const GITHUB_OWNER = "eliachiarucci";
export const CLI_REPO = `${GITHUB_OWNER}/agent-cli`;
export const BACKEND_IMAGE = `ghcr.io/${GITHUB_OWNER}/agent`;
export const UI_IMAGE = `ghcr.io/${GITHUB_OWNER}/agent-ui`;

function manifestFallback(): { cli: string; backend: string; ui: string } {
  return JSON.parse(readFileSync(join(__dirname, "..", "versions.json"), "utf8"));
}

export const CLI_VERSION =
  typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "dev";

/** Image tags this CLI build ships with — used to seed a fresh config. */
export function pinnedTags(): { backend: string; ui: string } {
  if (typeof __BACKEND_TAG__ !== "undefined" && typeof __UI_TAG__ !== "undefined") {
    return { backend: __BACKEND_TAG__, ui: __UI_TAG__ };
  }
  const manifest = manifestFallback();
  return { backend: manifest.backend, ui: manifest.ui };
}

export function seaTarget(): string {
  const os = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!os || !arch || (os === "macos" && arch === "x64")) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }
  return `${os}-${arch}`;
}
