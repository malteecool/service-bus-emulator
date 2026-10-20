import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { Ajv, type ErrorObject } from "ajv";
import { settings, stripBom } from "./config.ts";

/**
 * JSON schema for the emulator's Config.json, copied from
 * https://github.com/Azure/azure-service-bus-emulator-installer (ServiceBus-Emulator/Schema/Config-schema.json).
 * Served to the UI so it can generate property forms.
 */
export const schema = JSON.parse(readFileSync(new URL("./emulator-config.schema.json", import.meta.url), "utf8"));

// The schema's name patterns use `[\w-\.\/]`, which is invalid with the `u` flag Ajv uses by default.
const ajv = new Ajv({ allErrors: true, unicodeRegExp: false, strict: false });
const validateSchema = ajv.compile(schema);

interface Entity {
  Name: string;
  Properties?: Record<string, unknown>;
}
interface Rule extends Entity {
  Properties: { FilterType?: string; CorrelationFilter?: object; SqlFilter?: object };
}
interface Subscription extends Entity {
  Rules?: Rule[];
}
interface Topic extends Entity {
  Subscriptions?: Subscription[];
}
export interface EmulatorConfig {
  UserConfig: {
    Namespaces: { Name: string; Queues?: Entity[]; Topics?: Topic[] }[];
    Logging: { Type: string };
  };
}

export function readConfig(): EmulatorConfig {
  return JSON.parse(stripBom(readFileSync(settings.emulatorConfigPath, "utf8")));
}

const NAME_RULE = "must start and end with a letter or digit, and contain only letters, digits, _ - . /";

/** Turns "/UserConfig/Namespaces/0/Queues/2/Properties/MaxDeliveryCount" into `Queue "orders" › MaxDeliveryCount`. */
function schemaError(e: ErrorObject, config: unknown): string {
  const labels: Record<string, string> = { Queues: "Queue", Topics: "Topic", Subscriptions: "Subscription", Rules: "Rule" };
  const segments = e.instancePath.split("/").slice(1);
  let node: any = config;
  let where = "";
  const rest: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    node = node?.[seg];
    if (labels[seg] && i + 1 < segments.length) {
      node = node?.[segments[++i]];
      where = `${where ? where + " › " : ""}${labels[seg]} "${node?.Name ?? `#${Number(segments[i]) + 1}`}"`;
      rest.length = 0;
    } else if (!["UserConfig", "Namespaces", "Properties"].includes(seg) && !/^\d+$/.test(seg)) {
      rest.push(seg);
    }
  }
  const field = rest.join(".");
  let message = e.message ?? "is invalid";
  if (e.keyword === "pattern") message = field.endsWith("Name") || field.startsWith("Forward") ? NAME_RULE : "is not a valid ISO 8601 duration (e.g. PT5M, PT1H)";
  if (e.keyword === "enum") message += `: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}`;
  if (e.keyword === "required") message = `is missing ${(e.params as { missingProperty: string }).missingProperty}`;
  return [where, field].filter(Boolean).join(" › ") + " " + message;
}

/** ISO 8601 duration (PT1H, P1DT5M, ...) to seconds; undefined if it doesn't parse. */
export function durationSeconds(value: string): number | undefined {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m || value === "P" || value.endsWith("T")) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map((n) => Number(n ?? 0));
  return ((((y * 365 + mo * 30 + d) * 24 + h) * 60 + mi) * 60) + s;
}

/** Limits stated in the schema's descriptions (not machine-checkable there). [min, max] in seconds. */
const durationLimits: Record<string, [number, number]> = {
  DefaultMessageTimeToLive: [5 * 60, 60 * 60],
  DuplicateDetectionHistoryTimeWindow: [5, 5 * 60],
  LockDuration: [5, 5 * 60],
};

export interface ValidationResult {
  errors: string[];
  /** Values outside documented limits; saved anyway, but the emulator may reject or clamp them. */
  warnings: string[];
}

export function validateConfig(config: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!validateSchema(config)) {
    errors.push(...(validateSchema.errors ?? []).map((e) => schemaError(e, config)));
    return { errors, warnings };
  }

  const ns = (config as EmulatorConfig).UserConfig.Namespaces[0];
  const queues = ns.Queues ?? [];
  const topics = ns.Topics ?? [];

  if (queues.length + topics.length > 50) errors.push(`Max 50 queues + topics per namespace (have ${queues.length + topics.length})`);

  // Service Bus entity names are case-insensitive and queues/topics share one namespace.
  const names = new Map<string, string>();
  for (const [kind, list] of [["queue", queues], ["topic", topics]] as const) {
    for (const e of list) {
      const key = e.Name.toLowerCase();
      if (names.has(key)) errors.push(`${kind === "queue" ? "Queue" : "Topic"} "${e.Name}": name already used by a ${names.get(key)} (names are case-insensitive)`);
      else names.set(key, kind);
    }
  }

  const checkProps = (label: string, entityName: string, props: Record<string, unknown> = {}, isSubscription = false) => {
    for (const key of ["ForwardTo", "ForwardDeadLetteredMessagesTo"]) {
      const target = props[key];
      if (typeof target !== "string" || target === "") continue;
      if (!names.has(target.toLowerCase())) errors.push(`${label} › ${key} "${target}" is not a queue or topic in this config`);
      else if (target.toLowerCase() === entityName.toLowerCase()) errors.push(`${label} › ${key} can't point to itself`);
    }
    for (const [key, [min, max]] of Object.entries(durationLimits)) {
      const value = props[key];
      if (typeof value !== "string") continue;
      const secs = durationSeconds(value);
      const lower = key === "LockDuration" && isSubscription ? 60 : min;
      if (secs !== undefined && (secs < lower || secs > max)) {
        warnings.push(`${label} › ${key} ${value} is outside the emulator's documented range (${lower}s–${max}s)`);
      }
    }
  };

  for (const q of queues) checkProps(`Queue "${q.Name}"`, q.Name, q.Properties);
  for (const t of topics) {
    checkProps(`Topic "${t.Name}"`, t.Name, t.Properties);
    const subNames = new Set<string>();
    for (const s of t.Subscriptions ?? []) {
      const label = `Topic "${t.Name}" › Subscription "${s.Name}"`;
      if (subNames.has(s.Name.toLowerCase())) errors.push(`Topic "${t.Name}": duplicate subscription "${s.Name}"`);
      subNames.add(s.Name.toLowerCase());
      // A subscription forwarding to its own topic would loop, so compare against the topic name.
      checkProps(label, t.Name, s.Properties, true);

      const ruleNames = new Set<string>();
      for (const r of s.Rules ?? []) {
        if (ruleNames.has(r.Name.toLowerCase())) errors.push(`${label}: duplicate rule "${r.Name}"`);
        ruleNames.add(r.Name.toLowerCase());
        const type = r.Properties.FilterType;
        if (type === "Correlation" && !r.Properties.CorrelationFilter) errors.push(`${label} › Rule "${r.Name}" needs a CorrelationFilter`);
        if (type === "Sql" && !r.Properties.SqlFilter) errors.push(`${label} › Rule "${r.Name}" needs a SqlFilter`);
      }
    }
  }
  return { errors, warnings };
}

/** Validates and writes Config.json, keeping the previous version as config.json.bak. */
export function writeConfig(config: EmulatorConfig): ValidationResult {
  const result = validateConfig(config);
  if (result.errors.length) return result;
  copyFileSync(settings.emulatorConfigPath, settings.emulatorConfigPath + ".bak");
  // Write in place (not write-and-rename) so the file bind-mounted into the container stays the same file.
  writeFileSync(settings.emulatorConfigPath, JSON.stringify(config, null, 2) + "\n");
  return result;
}
