import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseServiceBusConnectionString, ServiceBusAdministrationClient } from "@azure/service-bus";
import { Bus, errorMessage, localBus } from "./bus.ts";
import { getEntities, settings, type Entities, type ReceiveSource } from "./config.ts";
import { record } from "./events.ts";

/**
 * Environments are the tabs in the UI. "local" is always the emulator (entities from Config.json,
 * mock responders, full control). Every other environment is a real Service Bus namespace, which is
 * read-only: send and peek only, no responders or purge, so the mock can't take messages away from
 * real services.
 */

/** Stored in environments.json (git-ignored: it holds connection strings). */
interface StoredEnvironment {
  id: string;
  name: string;
  connectionString: string;
}

export interface RuntimeCounts {
  active?: number;
  deadLetter?: number;
}

/** Entities plus message counts, for namespaces where the management API provides them. */
export interface EnvironmentEntities extends Entities {
  counts?: Record<string, RuntimeCounts>;
}

interface Environment {
  stored?: StoredEnvironment;
  id: string;
  name: string;
  readOnly: boolean;
  bus: Bus;
  entities: EnvironmentEntities;
  /** Set when listing entities failed (e.g. a Send/Listen-only connection string). */
  error?: string;
  refreshedAt?: string;
  refreshing?: Promise<void>;
}

/** What the UI gets: never the connection string, only the namespace host. */
export interface EnvironmentInfo {
  id: string;
  name: string;
  kind: "emulator" | "azure";
  readOnly: boolean;
  namespace: string;
  error?: string;
  refreshedAt?: string;
}

const file = resolve(process.env.ENVIRONMENTS_FILE ?? "environments.json");
const environments = new Map<string, Environment>();

function namespaceOf(connectionString: string): string {
  try {
    return parseServiceBusConnectionString(connectionString).fullyQualifiedNamespace;
  } catch {
    return "";
  }
}

function validateConnectionString(cs: string): void {
  let parsed;
  try {
    parsed = parseServiceBusConnectionString(cs);
  } catch (err) {
    throw new Error(`Invalid connection string: ${errorMessage(err)}`);
  }
  if (!parsed.fullyQualifiedNamespace) throw new Error("Invalid connection string: missing Endpoint");
  if (parsed.useDevelopmentEmulator) throw new Error("This is an emulator connection string; the Local tab already covers the emulator.");
  if ((parsed as { entityPath?: string }).entityPath) {
    throw new Error("Use a namespace-level connection string (without EntityPath) so queues and topics can be listed.");
  }
}

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "env";
  let id = base === "local" ? "local-2" : base;
  for (let n = 2; environments.has(id); n++) id = `${base}-${n}`;
  return id;
}

function save(): void {
  const stored = [...environments.values()].flatMap((e) => (e.stored ? [e.stored] : []));
  writeFileSync(file, JSON.stringify(stored, null, 2) + "\n");
}

function create(stored: StoredEnvironment): Environment {
  return {
    stored,
    id: stored.id,
    name: stored.name,
    readOnly: true,
    bus: new Bus(stored.id, stored.connectionString),
    entities: { targets: [], sources: [] },
  };
}

/** Lists queues, topics and subscriptions with message counts. Needs Manage rights. */
async function discover(env: Environment): Promise<void> {
  const admin = new ServiceBusAdministrationClient(env.stored!.connectionString);
  const entities: EnvironmentEntities = { targets: [], sources: [], counts: {} };
  for await (const q of admin.listQueuesRuntimeProperties()) {
    entities.targets.push({ kind: "queue", name: q.name });
    entities.sources.push({ id: q.name, kind: "queue", queue: q.name });
    entities.counts![q.name] = { active: q.activeMessageCount, deadLetter: q.deadLetterMessageCount };
  }
  for await (const t of admin.listTopics()) {
    entities.targets.push({ kind: "topic", name: t.name });
    for await (const s of admin.listSubscriptionsRuntimeProperties(t.name)) {
      const id = `${t.name}/subscriptions/${s.subscriptionName}`;
      entities.sources.push({ id, kind: "subscription", topic: t.name, subscription: s.subscriptionName });
      entities.counts![id] = { active: s.activeMessageCount, deadLetter: s.deadLetterMessageCount };
    }
  }
  const byName = (a: { name?: string; id?: string }, b: { name?: string; id?: string }) =>
    (a.name ?? a.id ?? "").localeCompare(b.name ?? b.id ?? "");
  entities.targets.sort(byName);
  entities.sources.sort(byName);
  env.entities = entities;
}

export async function refresh(id: string): Promise<EnvironmentInfo> {
  const env = get(id);
  if (!env.stored) return info(env); // local: entities come from Config.json
  // Coalesce concurrent refreshes (e.g. tab switch + refresh button).
  env.refreshing ??= discover(env)
    .then(() => {
      env.error = undefined;
      env.refreshedAt = new Date().toISOString();
    })
    .catch((err) => {
      env.error = /401|unauthori[sz]ed|Manage/i.test(errorMessage(err))
        ? `Can't list entities: the connection string needs Manage rights (${errorMessage(err)})`
        : `Can't list entities: ${errorMessage(err)}`;
      record("error", "environment", env.error, undefined, env.id);
    })
    .finally(() => {
      env.refreshing = undefined;
    });
  await env.refreshing;
  return info(env);
}

export function loadEnvironments(): void {
  environments.set("local", {
    id: "local",
    name: "Local (emulator)",
    readOnly: false,
    bus: localBus,
    get entities() {
      return getEntities();
    },
  });
  if (!existsSync(file)) return;
  const stored: StoredEnvironment[] = JSON.parse(readFileSync(file, "utf8"));
  for (const s of stored) {
    const env = create(s);
    environments.set(s.id, env);
    // Discover in the background so startup isn't blocked by a slow or unreachable namespace.
    void refresh(s.id);
  }
}

export function get(id: string): Environment {
  const env = environments.get(id || "local");
  if (!env) throw new Error(`unknown environment ${id}`);
  return env;
}

function info(env: Environment): EnvironmentInfo {
  return {
    id: env.id,
    name: env.name,
    kind: env.stored ? "azure" : "emulator",
    readOnly: env.readOnly,
    namespace: env.stored ? namespaceOf(env.stored.connectionString) : namespaceOf(settings.connectionString) || "localhost",
    error: env.error,
    refreshedAt: env.refreshedAt,
  };
}

export function list(): EnvironmentInfo[] {
  return [...environments.values()].map(info);
}

export function findSource(env: Environment, sourceId: string): ReceiveSource | undefined {
  return env.entities.sources.find((s) => s.id === sourceId);
}

export async function add(input: { name: string; connectionString: string }): Promise<EnvironmentInfo> {
  const name = input.name?.trim();
  const connectionString = input.connectionString?.trim();
  if (!name) throw new Error("Name is required");
  validateConnectionString(connectionString);
  const env = create({ id: slug(name), name, connectionString });
  environments.set(env.id, env);
  save();
  record("info", "environment", `added ${name} (${namespaceOf(connectionString)})`, undefined, env.id);
  return refresh(env.id);
}

/** Renames and/or replaces the connection string; an empty connection string keeps the old one. */
export async function update(id: string, input: { name?: string; connectionString?: string }): Promise<EnvironmentInfo> {
  const env = get(id);
  if (!env.stored) throw new Error("The local environment can't be edited");
  if (input.name?.trim()) env.name = env.stored.name = input.name.trim();
  const cs = input.connectionString?.trim();
  if (cs && cs !== env.stored.connectionString) {
    validateConnectionString(cs);
    await env.bus.close();
    env.stored.connectionString = cs;
    env.bus = new Bus(env.id, cs);
  }
  save();
  return refresh(id);
}

export async function remove(id: string): Promise<void> {
  const env = get(id);
  if (!env.stored) throw new Error("The local environment can't be removed");
  environments.delete(id);
  save();
  await env.bus.close();
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([...environments.values()].map((e) => e.bus.close()));
}
