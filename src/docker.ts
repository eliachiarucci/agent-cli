import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { confirm } from "./tty";

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string; missing: boolean } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT",
  };
}

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

async function installDockerLinux(): Promise<void> {
  console.log("\nDocker is not installed.");
  const yes = await confirm("Install it now with Docker's official script (https://get.docker.com)? Uses sudo.", true);
  if (!yes) fail("Docker is required. Install it and re-run `agent setup`.");
  const result = spawnSync("sh", ["-c", "curl -fsSL https://get.docker.com | sh"], { stdio: "inherit" });
  if (result.status !== 0) fail("Docker installation failed. Install it manually and re-run `agent setup`.");
}

async function startDockerMac(): Promise<void> {
  const apps = ["/Applications/OrbStack.app", "/Applications/Docker.app"].filter((app) => existsSync(app));
  if (apps.length === 0) {
    fail(
      "Docker is not installed. Install OrbStack (https://orbstack.dev) or Docker Desktop\n" +
        "(https://docker.com/products/docker-desktop), e.g.:\n\n" +
        "  brew install --cask orbstack\n\nthen re-run `agent setup`."
    );
  }
  console.log(`Starting ${apps[0].replace("/Applications/", "").replace(".app", "")}...`);
  spawnSync("open", ["-a", apps[0]], { stdio: "ignore" });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (run("docker", ["info"]).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail("The Docker daemon did not start within 90s. Start it manually and re-run `agent setup`.");
}

/** Ensures docker + compose v2 are installed and the daemon is reachable. */
export async function dockerPreflight(): Promise<void> {
  let version = run("docker", ["--version"]);
  if (version.missing) {
    if (process.platform === "linux") {
      await installDockerLinux();
    } else if (process.platform === "darwin") {
      await startDockerMac();
    } else {
      fail("Unsupported platform: only macOS and Linux are supported.");
    }
    version = run("docker", ["--version"]);
    if (!version.ok) fail("Docker still isn't available on PATH after installation.");
  }

  let info = run("docker", ["info"]);
  if (!info.ok) {
    if (/permission denied/i.test(info.stderr)) {
      console.log("\nYour user cannot talk to the Docker daemon (not in the `docker` group).");
      const yes = await confirm("Add this user to the docker group now? Uses sudo.", true);
      if (yes) {
        spawnSync("sudo", ["usermod", "-aG", "docker", process.env.USER ?? ""], { stdio: "inherit" });
        fail("Group added. Log out and back in (or reboot), then re-run `agent setup`.");
      }
      fail("Run `sudo usermod -aG docker $USER`, re-login, then re-run `agent setup`.");
    }
    if (process.platform === "darwin") {
      await startDockerMac();
      info = run("docker", ["info"]);
      if (!info.ok) fail(`Docker daemon is not reachable:\n${info.stderr.trim()}`);
    } else {
      fail(
        `Docker daemon is not reachable:\n${info.stderr.trim()}\n\nStart it with: sudo systemctl start docker`
      );
    }
  }

  const composeVersion = run("docker", ["compose", "version"]);
  if (!composeVersion.ok) {
    fail(
      "The Docker Compose v2 plugin is missing (`docker compose` failed).\n" +
        "Install docker-compose-plugin: https://docs.docker.com/compose/install/linux/"
    );
  }
}
