import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./versions.json", import.meta.url), "utf8"));
// CI passes the git tag; local builds fall back to the manifest's cli version.
const cliVersion = process.env.CLI_VERSION ?? manifest.cli;

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs", // Node SEA only supports CommonJS entrypoints
  target: "node22",
  define: {
    __CLI_VERSION__: JSON.stringify(cliVersion),
    __BACKEND_TAG__: JSON.stringify(manifest.backend),
    __UI_TAG__: JSON.stringify(manifest.ui),
  },
};

// agent: the server's installer and manager. agent-device: a device's client
// (camera, microphone, speaker), released with it.
await esbuild.build({ ...shared, entryPoints: ["src/index.ts"], outfile: "dist/agent.cjs" });
// ws's optional native helpers (bufferutil, utf-8-validate) aren't needed; it falls back to JS.
await esbuild.build({
  ...shared,
  entryPoints: ["src/device/index.ts"],
  outfile: "dist/agent-device.cjs",
  external: ["bufferutil", "utf-8-validate"],
});

console.log(`[build] dist/agent.cjs, dist/agent-device.cjs (${cliVersion}, backend ${manifest.backend}, ui ${manifest.ui})`);
