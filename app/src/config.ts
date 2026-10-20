import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_CONNECTION_STRING =
  "Endpoint=sb://localhost:5672;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;";

export const settings = {
  connectionString: process.env.SB_CONNECTION_STRING ?? DEFAULT_CONNECTION_STRING,
  emulatorConfigPath: resolve(process.env.EMULATOR_CONFIG ?? "../emulator/config.json"),
  port: Number(process.env.PORT ?? 3000),
};

/** A place messages can be sent to (queue or topic). */
export interface SendTarget {
  kind: "queue" | "topic";
  name: string;
}

/** A place messages can be received from (queue or topic subscription). */
export interface ReceiveSource {
  /** Stable id used by the API/UI, e.g. "queue.1" or "topic.1/subscriptions/subscription.1". */
  id: string;
  kind: "queue" | "subscription";
  queue?: string;
  topic?: string;
  subscription?: string;
}

export interface Entities {
  targets: SendTarget[];
  sources: ReceiveSource[];
}

interface EmulatorConfig {
  UserConfig: {
    Namespaces: {
      Name: string;
      Queues?: { Name: string }[];
      Topics?: { Name: string; Subscriptions?: { Name: string }[] }[];
    }[];
  };
}

/** Config files saved by Windows editors may start with a byte-order mark, which JSON.parse rejects. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

let current: Entities = { targets: [], sources: [] };

export function getEntities(): Entities {
  return current;
}

/** Re-reads the emulator config; call after it changes. */
export function reloadEntities(): Entities {
  current = loadEntities();
  return current;
}

/**
 * Reads queues/topics/subscriptions from the emulator's Config.json, so the app
 * always matches what the emulator was started with.
 */
export function loadEntities(path = settings.emulatorConfigPath): Entities {
  const raw = stripBom(readFileSync(path, "utf8"));
  const config = JSON.parse(raw) as EmulatorConfig;
  const targets: SendTarget[] = [];
  const sources: ReceiveSource[] = [];

  for (const ns of config.UserConfig.Namespaces) {
    for (const q of ns.Queues ?? []) {
      targets.push({ kind: "queue", name: q.Name });
      sources.push({ id: q.Name, kind: "queue", queue: q.Name });
    }
    for (const t of ns.Topics ?? []) {
      targets.push({ kind: "topic", name: t.Name });
      for (const s of t.Subscriptions ?? []) {
        sources.push({
          id: `${t.Name}/subscriptions/${s.Name}`,
          kind: "subscription",
          topic: t.Name,
          subscription: s.Name,
        });
      }
    }
  }
  return { targets, sources };
}
