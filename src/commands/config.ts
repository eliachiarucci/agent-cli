import { loadConfig, saveConfig, CONFIG_PATH, type AgentConfig } from "../config";
import { render } from "../render";

// Only plain settings are editable; versions move via `agent update` and
// secrets never change after generation.
const EDITABLE = ["port", "appOrigin", "startWebUi"] as const;
type EditableKey = (typeof EDITABLE)[number];

export function configGet(key?: string): void {
  const config = loadConfig();
  const visible = {
    release: config.release,
    uiTag: config.uiTag,
    port: config.port,
    appOrigin: config.appOrigin,
    startWebUi: config.startWebUi,
  };
  if (!key) {
    console.log(JSON.stringify(visible, null, 2));
    console.log(`\n(full file with secrets: ${CONFIG_PATH})`);
    return;
  }
  if (!(key in visible)) {
    console.error(`Unknown key "${key}". Available: ${Object.keys(visible).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(String(visible[key as keyof typeof visible]));
}

export function configSet(key: string, value: string): void {
  if (!EDITABLE.includes(key as EditableKey)) {
    console.error(`"${key}" is not editable. Editable keys: ${EDITABLE.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();

  if (key === "port") {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`"${value}" is not a valid port.`);
      process.exitCode = 1;
      return;
    }
    config.port = port;
  } else if (key === "appOrigin") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      console.error(`"${value}" is not a valid URL (expected e.g. http://myserver.local:4125).`);
      process.exitCode = 1;
      return;
    }
    if (new URL(config.appOrigin).hostname !== parsed.hostname) {
      console.log("⚠ Passkeys are bound to the origin's hostname — existing passkeys will stop working.");
    }
    config.appOrigin = value.replace(/\/+$/, "");
  } else if (key === "startWebUi") {
    if (value !== "true" && value !== "false") {
      console.error(`"${value}" must be true or false.`);
      process.exitCode = 1;
      return;
    }
    config.startWebUi = value === "true";
  }

  saveConfig(config as AgentConfig);
  render(config);
  console.log(`✓ ${key} updated. Apply it with: agent restart`);
}
