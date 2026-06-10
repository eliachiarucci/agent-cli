import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  // The searxng container chowns its bind-mounted config dir to its own user
  // on startup, so after the first boot this file is no longer ours to write.
  // Its content never changes after install (the secret is generated once), so
  // skip when it's already correct and only warn when it actually drifted.
  const settingsPath = join(RUNTIME_DIR, "searxng", "settings.yml");
  const desired = searxngSettings(config.secrets.searxngSecret);
  let current: string | undefined;
  try {
    current = readFileSync(settingsPath, "utf8");
  } catch {
    // missing or unreadable — fall through to the write attempt
  }
  if (current !== desired) {
    try {
      writeFileSync(settingsPath, desired);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw error;
      console.warn(
        `⚠ Could not update ${settingsPath} (owned by the searxng container).\n` +
          `  Fix with: sudo chown -R $USER ${join(RUNTIME_DIR, "searxng")} && agent restart`
      );
    }
  }
}
