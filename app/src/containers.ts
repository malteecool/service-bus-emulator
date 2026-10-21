import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "./bus.ts";
import { record } from "./events.ts";

const exec = promisify(execFile);

const composeFile = resolve(process.env.EMULATOR_COMPOSE ?? "../emulator/docker-compose.yaml");
/** Pinned so every compose tool (some ignore the file's `name:`) manages the same containers. */
const PROJECT = "microsoft-azure-servicebus-emulator";
/** Fixed by `container_name` in the compose file. */
const CONTAINERS = { emulator: "servicebus-emulator", sqledge: "sqledge" } as const;
const httpPort = Number(process.env.EMULATOR_HTTP_PORT ?? 5300);

export const ACTIONS = ["up", "down", "restart", "recreate", "pull"] as const;
export type Action = (typeof ACTIONS)[number];

export const ENGINES = ["auto", "docker", "podman"] as const;
export type EngineChoice = (typeof ENGINES)[number];

interface Engine {
  name: "docker" | "podman";
  /** Command plus leading args that run compose, e.g. ["docker", "compose"] or ["podman-compose"]. */
  compose: string[];
  /**
   * Docker Compose (v1/v2) understands --quiet-pull and `pull -q`. podman-compose doesn't reliably,
   * and `podman compose` may delegate to either, so Podman gets only the common flags.
   */
  quietFlags: boolean;
}

let choice: EngineChoice = ENGINES.includes(process.env.CONTAINER_ENGINE as EngineChoice)
  ? (process.env.CONTAINER_ENGINE as EngineChoice)
  : "auto";
let engine: Engine | undefined;
let running: Action | undefined;

async function succeeds(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 15_000 });
    return stdout;
  } catch {
    return undefined;
  }
}

async function dockerCompose(): Promise<string[]> {
  // Early `docker compose` betas print help and exit 0 for `version`, so check for an actual version.
  const v2 = await succeeds("docker", ["compose", "version"]);
  if (v2 && /version v?2\./i.test(v2)) return ["docker", "compose"];
  if (await succeeds("docker-compose", ["version", "--short"])) return ["docker-compose"];
  return ["docker", "compose"];
}

async function podmanCompose(): Promise<string[]> {
  // `podman compose` (Podman 4.7+) wraps whichever provider is installed; it fails without one.
  if (await succeeds("podman", ["compose", "version"])) return ["podman", "compose"];
  if (await succeeds("podman-compose", ["version"])) return ["podman-compose"];
  return ["podman-compose"];
}

async function makeEngine(name: Engine["name"]): Promise<Engine> {
  return name === "docker"
    ? { name, compose: await dockerCompose(), quietFlags: true }
    : { name, compose: await podmanCompose(), quietFlags: false };
}

/**
 * Picks the container engine. "auto" uses whichever one is actually reachable (Docker daemon first,
 * then Podman), falling back to whichever CLI is installed.
 */
async function getEngine(): Promise<Engine> {
  if (engine) return engine;
  if (choice !== "auto") {
    engine = await makeEngine(choice);
  } else if (await succeeds("docker", ["info", "--format", "{{.ServerVersion}}"])) {
    engine = await makeEngine("docker");
  } else if (await succeeds("podman", ["info", "--format", "{{.Version.Version}}"])) {
    engine = await makeEngine("podman");
  } else {
    engine = await makeEngine((await succeeds("docker", ["--version"])) || !(await succeeds("podman", ["--version"])) ? "docker" : "podman");
  }
  return engine;
}

export async function setEngine(next: EngineChoice): Promise<void> {
  if (!ENGINES.includes(next)) throw new Error(`unknown engine ${next}`);
  if (running) throw new Error(`can't switch engine while "${running}" is running`);
  choice = next;
  engine = undefined;
  record("info", "containers", `engine set to ${next}`);
}

function actionArgs(action: Action, e: Engine): string[] {
  switch (action) {
    case "up":
      return e.quietFlags ? ["up", "-d", "--quiet-pull"] : ["up", "-d"];
    case "down":
      return ["down"];
    case "restart":
      return ["restart"];
    case "recreate":
      // Recreates the containers so the emulator starts fresh with the current Config.json.
      return ["up", "-d", "--force-recreate"];
    case "pull":
      return e.quietFlags ? ["pull", "-q"] : ["pull"];
  }
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
  const e = await getEngine();
  const [cmd, ...pre] = e.compose;
  const args = [...pre, "-p", PROJECT, "-f", composeFile, ...actionArgs(action, e)];
  running = action;
  const tag = e.name;
  record("info", tag, `$ ${cmd} ${args.join(" ")}`);

  // Run from the compose file's folder so it picks up emulator/.env.
  const child = spawn(cmd, args, { cwd: dirname(composeFile) });
  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) record("info", tag, line.trim());
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  let failed = false;
  child.on("error", (err) => {
    failed = true;
    running = undefined;
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    record("error", tag, missing ? `${cmd} is not installed or not on PATH` : `${action} failed: ${errorMessage(err)}`);
  });
  child.on("close", (code) => {
    running = undefined;
    if (failed) return; // already reported by the "error" handler
    if (code === 0) record("info", tag, `${action} finished`);
    else if (code !== null) record("error", tag, `${action} exited with code ${code}`);
  });
}

export interface ContainerStatus {
  name: string;
  state: string;
  status: string;
}

export interface EmulatorStatus {
  engine: Engine["name"];
  engineChoice: EngineChoice;
  /** The engine's CLI answered `ps`. */
  available: boolean;
  error?: string;
  compose: string;
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

/**
 * Parses `ps` output from either engine: Docker prints one JSON object per line (`{{json .}}`),
 * Podman's `--format json` prints an array with Names as an array.
 */
export function parsePs(stdout: string): ContainerStatus[] {
  const text = stdout.trim();
  if (!text) return [];
  const rows: Record<string, unknown>[] = text.startsWith("[")
    ? JSON.parse(text)
    : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return rows.map((c) => {
    const names = Array.isArray(c.Names) ? c.Names : String(c.Names ?? "").split(",");
    const status = String(c.Status ?? "");
    // Older Docker versions don't report State; derive it from the status text.
    const state = String(c.State ?? (/^up\b/i.test(status) ? "running" : "exited")).toLowerCase();
    return { name: String(names[0] ?? "").replace(/^\//, ""), state, status };
  });
}

export async function status(): Promise<EmulatorStatus> {
  const [healthy, e] = await Promise.all([checkHealth(), getEngine()]);
  const base = { engine: e.name, engineChoice: choice, compose: e.compose.join(" "), running, healthy };
  // Query by container name rather than compose labels: names are fixed in the compose file and
  // labels differ between docker-compose and podman-compose.
  const filters = Object.values(CONTAINERS).flatMap((n) => ["--filter", `name=${n}`]);
  const format = e.name === "podman" ? ["--format", "json"] : ["--format", "{{json .}}"];
  try {
    const { stdout } = await exec(e.name, ["ps", "-a", ...filters, ...format], { timeout: 15_000 });
    const wanted: string[] = Object.values(CONTAINERS);
    const containers = parsePs(stdout).filter((c) => wanted.includes(c.name));
    return { ...base, available: true, containers };
  } catch (err) {
    // Re-detect next time: in auto mode the other engine may have come up meanwhile.
    if (choice === "auto" && !running) engine = undefined;
    const stderr = (err as { stderr?: string }).stderr?.trim();
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    let error = missing ? `${e.name} is not installed or not on PATH` : stderr || errorMessage(err);
    if (e.name === "podman" && /machine|connect|socket/i.test(error)) error += " (is the Podman machine running? Try: podman machine start)";
    return { ...base, available: false, error, containers: [] };
  }
}

export async function logs(service = "emulator", tail = 300): Promise<string> {
  const container = CONTAINERS[service as keyof typeof CONTAINERS];
  if (!container) throw new Error(`unknown service ${service}`);
  const e = await getEngine();
  // Plain `<engine> logs` behaves the same everywhere, unlike the compose tools' logs commands.
  try {
    const { stdout, stderr } = await exec(e.name, ["logs", "--tail", String(tail), container], { maxBuffer: 10 * 1024 * 1024 });
    return stdout + stderr;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${e.name} is not installed or not on PATH`);
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || errorMessage(err));
  }
}
