import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseServiceBusConnectionString, ServiceBusAdministrationClient, ServiceBusClient } from "@azure/service-bus";
import { Bus, entityPathOf, errorMessage, localBus } from "./bus.ts";
import { getEntities, settings, type Entities, type ReceiveSource } from "./config.ts";
import { record } from "./events.ts";

/**
 * Environments are the tabs in the UI. "local" is always the emulator (entities from Config.json,
 * mock responders, full control). Every other environment is a real Service Bus namespace, which is
 * read-only: send and peek only, no responders or purge, so the mock can't take messages away from
 * real services.
 *
 * A real environment has one or more connection strings:
 * - namespace-level (no EntityPath): with Manage rights, all queues/topics/subscriptions are listed
 * - entity-level (`;EntityPath=<queue or topic>`): a key valid for that one entity only, common when
 *   each queue has its own access policy. Only that entity is shown.
 */

/** Stored in environments.json (git-ignored: it holds connection strings). */
interface StoredEnvironment {
  id: string;
  name: string;
  connectionStrings: string[];
  /** Older files stored a single string. */
  connectionString?: string;
}

export interface RuntimeCounts {
  active?: number;
  deadLetter?: number;
}

/** Entities plus message counts, where the keys allow reading them. */
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
  /** Problems while listing entities (wrong key, missing rights, unreachable namespace). */
  error?: string;
  refreshedAt?: string;
  refreshing?: Promise<void>;
}

/** What the UI gets: never connection strings or keys, only what each one is scoped to. */
export interface EnvironmentInfo {
  id: string;
  name: string;
  kind: "emulator" | "azure";
  readOnly: boolean;
  namespace: string;
  connections: { scope: string; keyName: string }[];
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

/** Splits pasted text into connection strings (one per line) and validates them together. */
function parseConnectionStrings(input: string | string[] | undefined): string[] {
  const list = [input ?? []].flat().flatMap((s) => s.split(/\r?\n/)).map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("At least one connection string is required");
  const namespaces = new Set<string>();
  const scopes = new Set<string>();
  for (const cs of list) {
    let parsed;
    try {
      parsed = parseServiceBusConnectionString(cs);
    } catch (err) {
      throw new Error(`Invalid connection string: ${errorMessage(err)}`);
    }
    if (!parsed.fullyQualifiedNamespace) throw new Error("Invalid connection string: missing Endpoint");
    if (parsed.useDevelopmentEmulator) throw new Error("That's an emulator connection string; the Local tab already covers the emulator.");
    if (!("sharedAccessKey" in parsed) || !parsed.sharedAccessKey) {
      throw new Error("Only connection strings with SharedAccessKeyName/SharedAccessKey are supported");
    }
    namespaces.add(parsed.fullyQualifiedNamespace.toLowerCase());
    const scope = (entityPathOf(cs) ?? "(namespace)").toLowerCase();
    if (scopes.has(scope)) throw new Error(`Two connection strings for the same ${scope === "(namespace)" ? "namespace" : `entity "${scope}"`}`);
    scopes.add(scope);
  }
  if (namespaces.size > 1) throw new Error(`All connection strings in one environment must use the same namespace (got ${[...namespaces].join(", ")})`);
  return list;
}

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "env";
  let id = base === "local" ? "local-2" : base;
  for (let n = 2; environments.has(id); n++) id = `${base}-${n}`;
  return id;
}

function save(): void {
  const stored = [...environments.values()].flatMap((e) =>
    e.stored ? [{ id: e.stored.id, name: e.stored.name, connectionStrings: e.stored.connectionStrings }] : [],
  );
  writeFileSync(file, JSON.stringify(stored, null, 2) + "\n");
}

function create(stored: StoredEnvironment): Environment {
  return {
    stored,
    id: stored.id,
    name: stored.name,
    readOnly: true,
    bus: new Bus(stored.id, stored.connectionStrings),
    entities: { targets: [], sources: [] },
  };
}

/** Explains the auth errors people actually hit, instead of only Azure's wording. */
function explain(err: unknown): string {
  const msg = errorMessage(err);
  if (/InvalidSignature/i.test(msg)) {
    return `${msg}. The key doesn't match the SharedAccessKeyName: copy the full connection string again, and keep ";EntityPath=..." if the key belongs to a queue-level policy.`;
  }
  if (/\b401\b|unauthori[sz]ed|claim/i.test(msg)) return `${msg}. The key lacks the rights for this (listing needs Manage, peek needs Listen).`;
  return msg;
}

/** Lists everything in the namespace with message counts. Needs a namespace-level key with Manage. */
async function discoverNamespace(cs: string, into: EnvironmentEntities): Promise<void> {
  const admin = new ServiceBusAdministrationClient(cs);
  for await (const q of admin.listQueuesRuntimeProperties()) {
    into.targets.push({ kind: "queue", name: q.name });
    into.sources.push({ id: q.name, kind: "queue", queue: q.name });
    into.counts![q.name] = { active: q.activeMessageCount, deadLetter: q.deadLetterMessageCount };
  }
  for await (const t of admin.listTopics()) {
    into.targets.push({ kind: "topic", name: t.name });
    for await (const s of admin.listSubscriptionsRuntimeProperties(t.name)) {
      const id = `${t.name}/subscriptions/${s.subscriptionName}`;
      into.sources.push({ id, kind: "subscription", topic: t.name, subscription: s.subscriptionName });
      into.counts![id] = { active: s.activeMessageCount, deadLetter: s.deadLetterMessageCount };
    }
  }
}

/**
 * Works out what an entity-level connection string points at. With Manage rights the management API
 * says whether it's a queue or topic (and gives counts); otherwise a peek checks the key works. Without
 * Listen rights (a Send-only key) it's assumed to be a queue, so sending still works.
 */
async function discoverEntity(cs: string, entity: string, into: EnvironmentEntities, problems: string[]): Promise<void> {
  const admin = new ServiceBusAdministrationClient(cs);
  try {
    const q = await admin.getQueueRuntimeProperties(entity);
    into.targets.push({ kind: "queue", name: q.name });
    into.sources.push({ id: q.name, kind: "queue", queue: q.name });
    into.counts![q.name] = { active: q.activeMessageCount, deadLetter: q.deadLetterMessageCount };
    return;
  } catch {
    // Not a queue, or no Manage rights: try as topic, then fall back to a peek.
  }
  try {
    await admin.getTopic(entity);
    into.targets.push({ kind: "topic", name: entity });
    for await (const s of admin.listSubscriptionsRuntimeProperties(entity)) {
      const id = `${entity}/subscriptions/${s.subscriptionName}`;
      into.sources.push({ id, kind: "subscription", topic: entity, subscription: s.subscriptionName });
      into.counts![id] = { active: s.activeMessageCount, deadLetter: s.deadLetterMessageCount };
    }
    return;
  } catch {
    // No Manage rights on this entity.
  }

  into.targets.push({ kind: "queue", name: entity });
  into.sources.push({ id: entity, kind: "queue", queue: entity });
  const client = new ServiceBusClient(cs, { retryOptions: { maxRetries: 1, timeoutInMs: 10_000 } });
  try {
    const receiver = client.createReceiver(entity);
    await receiver.peekMessages(1);
    await receiver.close();
  } catch (err) {
    const msg = explain(err);
    // A Send-only key can't peek; that's fine for sending, so only mention it.
    problems.push(/claim|unauthori[sz]ed|\b401\b/i.test(msg) ? `${entity}: this key can send but not peek (no Listen right)` : `${entity}: ${msg}`);
  } finally {
    await client.close();
  }
}

async function discover(env: Environment): Promise<string[]> {
  const entities: EnvironmentEntities = { targets: [], sources: [], counts: {} };
  const problems: string[] = [];
  for (const cs of env.stored!.connectionStrings) {
    const entity = entityPathOf(cs);
    try {
      if (entity) await discoverEntity(cs, entity, entities, problems);
      else await discoverNamespace(cs, entities);
    } catch (err) {
      problems.push(`${entity ?? "Namespace"}: can't list entities: ${explain(err)}`);
    }
  }
  // A namespace-level and an entity-level string can both find the same entity.
  const unique = <T>(list: T[], key: (t: T) => string) => [...new Map(list.map((t) => [key(t).toLowerCase(), t])).values()];
  entities.targets = unique(entities.targets, (t) => t.name).sort((a, b) => a.name.localeCompare(b.name));
  entities.sources = unique(entities.sources, (s) => s.id).sort((a, b) => a.id.localeCompare(b.id));
  env.entities = entities;
  return problems;
}

export async function refresh(id: string): Promise<EnvironmentInfo> {
  const env = get(id);
  if (!env.stored) return info(env); // local: entities come from Config.json
  // Coalesce concurrent refreshes (e.g. tab switch + refresh button).
  env.refreshing ??= discover(env)
    .then((problems) => {
      env.error = problems.length ? problems.join("\n") : undefined;
      env.refreshedAt = new Date().toISOString();
      for (const p of problems) record("error", "environment", p, undefined, env.id);
    })
    .catch((err) => {
      env.error = explain(err);
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
    s.connectionStrings ??= s.connectionString ? [s.connectionString] : [];
    delete s.connectionString;
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
  const strings = env.stored?.connectionStrings ?? [settings.connectionString];
  return {
    id: env.id,
    name: env.name,
    kind: env.stored ? "azure" : "emulator",
    readOnly: env.readOnly,
    namespace: namespaceOf(strings[0]) || "localhost",
    connections: strings.map((cs) => ({
      scope: entityPathOf(cs) ?? "namespace",
      keyName: /(?:^|;)\s*SharedAccessKeyName=([^;]+)/i.exec(cs)?.[1] ?? "",
    })),
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

type EnvironmentInput = { name?: string; connectionStrings?: string | string[]; connectionString?: string };

export async function add(input: EnvironmentInput): Promise<EnvironmentInfo> {
  const name = input.name?.trim();
  if (!name) throw new Error("Name is required");
  const connectionStrings = parseConnectionStrings(input.connectionStrings ?? input.connectionString);
  const env = create({ id: slug(name), name, connectionStrings });
  environments.set(env.id, env);
  save();
  record("info", "environment", `added ${name} (${namespaceOf(connectionStrings[0])}, ${connectionStrings.length} connection string(s))`, undefined, env.id);
  return refresh(env.id);
}

/** Renames and/or replaces all connection strings; no connection strings keeps the current ones. */
export async function update(id: string, input: EnvironmentInput): Promise<EnvironmentInfo> {
  const env = get(id);
  if (!env.stored) throw new Error("The local environment can't be edited");
  const raw = [input.connectionStrings ?? input.connectionString ?? []].flat().join("\n").trim();
  const connectionStrings = raw ? parseConnectionStrings(raw) : undefined;
  if (input.name?.trim()) env.name = env.stored.name = input.name.trim();
  if (connectionStrings) {
    await env.bus.close();
    env.stored.connectionStrings = connectionStrings;
    env.bus = new Bus(env.id, connectionStrings);
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
