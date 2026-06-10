import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./versions.json", import.meta.url), "utf8"));
// CI passes the git tag; local builds fall back to the manifest's cli version.
const cliVersion = process.env.CLI_VERSION ?? manifest.cli;

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs", // Node SEA only supports CommonJS entrypoints
  target: "node22",
  outfile: "dist/agent.cjs",
  define: {
    __CLI_VERSION__: JSON.stringify(cliVersion),
    __BACKEND_TAG__: JSON.stringify(manifest.backend),
    __UI_TAG__: JSON.stringify(manifest.ui),
  },
});

console.log(`[build] dist/agent.cjs (${cliVersion}, backend ${manifest.backend}, ui ${manifest.ui})`);
