import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, type AgentConfig } from "./config";
import { appEnv, composeYaml } from "./templates/compose";
import { searxngSettings } from "./templates/searxng";

/**
 * Renders all runtime artifacts from the config. Called before every compose
 * operation so the stack always reflects config.json.
 */
export function render(config: AgentConfig): void {
  mkdirSync(join(RUNTIME_DIR, "searxng"), { recursive: true });
  chmodSync(RUNTIME_DIR, 0o700);

  writeFileSync(join(RUNTIME_DIR, "docker-compose.yml"), composeYaml(config));
  const envPath = join(RUNTIME_DIR, "app.env");
  writeFileSync(envPath, appEnv(config));
  chmodSync(envPath, 0o600);
  writeFileSync(join(RUNTIME_DIR, "searxng", "settings.yml"), searxngSettings(config.secrets.searxngSecret));
}
