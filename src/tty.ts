import { openSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream } from "node:tty";

// Under `curl | bash`, stdin is the script stream — install.sh re-execs the
// CLI with `< /dev/tty`, and this is the defensive fallback for anything else.
let input: NodeJS.ReadableStream | undefined;
function ttyInput(): NodeJS.ReadableStream {
  if (!input) {
    input = process.stdin.isTTY ? process.stdin : new ReadStream(openSync("/dev/tty", "r"));
  }
  return input;
}

export function isInteractive(): boolean {
  if (process.stdin.isTTY) return true;
  try {
    ttyInput();
    return true;
  } catch {
    return false;
  }
}

export function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: ttyInput(), output: process.stdout });
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === "" && defaultValue !== undefined ? defaultValue : trimmed);
    });
  });
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const answer = await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}`, "");
  if (answer === "") return defaultYes;
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
