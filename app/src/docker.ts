import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "./bus.ts";
import { record } from "./events.ts";

const exec = promisify(execFile);

const composeFile = resolve(process.env.EMULATOR_COMPOSE ?? "../emulator/docker-compose.yaml");
/** Pinned so Compose v1 (which ignores the file's `name:`) and v2 agree on container labels. */
const PROJECT = "microsoft-azure-servicebus-emulator";
const httpPort = Number(process.env.EMULATOR_HTTP_PORT ?? 5300);

export const ACTIONS = ["up", "down", "restart", "recreate", "pull"] as const;
export type Action = (typeof ACTIONS)[number];

const actionArgs: Record<Action, string[]> = {
  up: ["up", "-d", "--quiet-pull"],
  down: ["down"],
  restart: ["restart"],
  // Recreates the containers so the emulator starts fresh with the current Config.json.
  recreate: ["up", "-d", "--force-recreate"],
  pull: ["pull", "-q"],
};

let composeCmd: string[] | undefined;
let running: Action | undefined;

/** Prefers Compose v2 (`docker compose`), falls back to standalone `docker-compose`. */
async function compose(): Promise<string[]> {
  if (composeCmd) return composeCmd;
  try {
    // Early `docker compose` betas print help and exit 0 here, so check for an actual version.
    const { stdout } = await exec("docker", ["compose", "version"]);
    if (!/version v?2\./i.test(stdout)) throw new Error("not Compose v2");
    composeCmd = ["docker", "compose"];
  } catch {
    try {
      await exec("docker-compose", ["version", "--short"]);
      composeCmd = ["docker-compose"];
    } catch {
      composeCmd = ["docker", "compose"];
    }
  }
  return composeCmd;
}

async function composeArgs(args: string[]): Promise<[string, string[]]> {
  const [cmd, ...pre] = await compose();
  // Run from the compose file's folder so it picks up emulator/.env.
  return [cmd, [...pre, "-p", PROJECT, "-f", composeFile, ...args]];
}

/** Reads emulator/.env the way compose does (process env vars win), for pre-flight checks. */
function composeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const path = resolve(dirname(composeFile), ".env");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*([\w.]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trimStart().startsWith("#")) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  for (const key of ["ACCEPT_EULA", "SQL_PASSWORD"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  return env;
}

/** Catches the two settings that otherwise fail obscurely inside the containers. */
function preflight(): void {
  if (!existsSync(resolve(dirname(composeFile), ".env")) && !process.env.ACCEPT_EULA) {
    throw new Error("emulator/.env is missing: copy emulator/.env.example to emulator/.env and fill in ACCEPT_EULA and SQL_PASSWORD.");
  }
  const env = composeEnv();
  if (env.ACCEPT_EULA?.toUpperCase() !== "Y") {
    throw new Error('Set ACCEPT_EULA="Y" in emulator/.env to accept the emulator and SQL Edge license terms.');
  }
  // SQL Server's policy: 8+ chars from at least 3 of: uppercase, lowercase, digits, symbols.
  // A weak password makes the SQL container exit silently and the emulator fail to start.
  const pw = env.SQL_PASSWORD ?? "";
  const classes = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (pw === "your-password" || pw.length < 8 || classes < 3) {
    throw new Error(
      "SQL_PASSWORD in emulator/.env is too weak for SQL Server: use 8+ characters from at least 3 of uppercase, lowercase, digits and symbols.",
    );
  }
}

/** Starts a compose command in the background, streaming its output to the activity feed. */
export async function run(action: Action): Promise<void> {
  if (!ACTIONS.includes(action)) throw new Error(`unknown action ${action}`);
  if (running) throw new Error(`"${running}" is still running`);
  if (action !== "down" && action !== "pull") preflight();
  const [cmd, args] = await composeArgs(actionArgs[action]);
  running = action;
  record("info", "docker", `$ ${cmd} ${args.join(" ")}`);

  const child = spawn(cmd, args, { cwd: dirname(composeFile) });
  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) record("info", "docker", line.trim());
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (err) => {
    running = undefined;
    record("error", "docker", `${action} failed: ${errorMessage(err)}`);
  });
  child.on("close", (code) => {
    running = undefined;
    if (code === 0) record("info", "docker", `${action} finished`);
    else record("error", "docker", `${action} exited with code ${code}`);
  });
}

export interface ContainerStatus {
  name: string;
  state: string;
  status: string;
}

export interface EmulatorStatus {
  dockerAvailable: boolean;
  error?: string;
  compose?: string;
  running?: Action;
  containers: ContainerStatus[];
  /** Emulator's health endpoint answered OK. */
  healthy: boolean;
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${httpPort}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function status(): Promise<EmulatorStatus> {
  const [healthy, cmd] = await Promise.all([checkHealth(), compose()]);
  try {
    const { stdout } = await exec("docker", [
      "ps", "-a",
      "--filter", `label=com.docker.compose.project=${PROJECT}`,
      "--format", "{{json .}}",
    ]);
    const containers = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const c = JSON.parse(line) as { Names: string; State?: string; Status: string };
        // Older Docker versions don't report State; derive it from the status text.
        const state = c.State ?? (c.Status.startsWith("Up") ? "running" : "exited");
        return { name: c.Names, state, status: c.Status };
      });
    return { dockerAvailable: true, compose: cmd.join(" "), running, containers, healthy };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    return { dockerAvailable: false, error: stderr || errorMessage(err), compose: cmd.join(" "), running, containers: [], healthy };
  }
}

export async function logs(service = "emulator", tail = 300): Promise<string> {
  if (!["emulator", "sqledge"].includes(service)) throw new Error(`unknown service ${service}`);
  const [cmd, args] = await composeArgs(["logs", "--no-color", "--tail", String(tail), service]);
  const { stdout, stderr } = await exec(cmd, args, { cwd: dirname(composeFile), maxBuffer: 10 * 1024 * 1024 });
  return stdout + stderr;
}
