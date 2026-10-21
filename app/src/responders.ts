import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServiceBusReceivedMessage, ServiceBusReceiver } from "@azure/service-bus";
import { errorMessage, localBus } from "./bus.ts";
import type { ReceiveSource } from "./config.ts";
import { normalizeBody, record, toView } from "./events.ts";

/**
 * What a mock responder does with each message it receives:
 * - off:        not listening; messages stay in the queue
 * - log:        receive, log and complete (consume)
 * - reply:      send a reply to the message's replyTo (or a fixed target), then complete
 * - abandon:    abandon, so it's redelivered until MaxDeliveryCount and then dead-lettered
 * - deadletter: dead-letter immediately
 */
export const MODES = ["off", "log", "reply", "abandon", "deadletter"] as const;
export type Mode = (typeof MODES)[number];

export interface ResponderConfig {
  mode: Mode;
  /** Wait this long before acting on a message. Keep it below the entity's LockDuration. */
  delayMs: number;
  /** Fixed reply target; when empty, the incoming message's replyTo is used. */
  replyTo: string;
  /** Reply body template. Empty means echo the incoming body. See renderTemplate. */
  replyBody: string;
  /** Send the rendered reply body as parsed JSON. */
  replyJson: boolean;
  replySubject: string;
  /** Reason used when dead-lettering. */
  deadLetterReason: string;
}

export const DEFAULT_CONFIG: ResponderConfig = {
  mode: "off",
  delayMs: 0,
  replyTo: "",
  replyBody: "",
  replyJson: true,
  replySubject: "",
  deadLetterReason: "MockDeadLetter",
};

const MAX_DELAY_MS = 55_000;
const ERROR_REPEAT_MS = 30_000;

interface Responder {
  source: ReceiveSource;
  config: ResponderConfig;
  receiver?: ServiceBusReceiver;
  stop?: () => Promise<void>;
  handled: number;
}

const responders = new Map<string, Responder>();

const defaultsPath = resolve(process.env.RESPONDERS_FILE ?? "responders.json");

function lookup(path: string, root: unknown): unknown {
  return path.split(".").reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], root);
}

/**
 * Replaces {{placeholders}} in a reply template. Available: {{messageId}}, {{correlationId}},
 * {{subject}}, {{now}}, {{uuid}} (new per reply), {{body}} and {{body.some.path}}, {{props.someProperty}}.
 * In JSON mode values are inserted as JSON (strings get quotes), so write `{"id": {{body.id}}}`.
 */
export function renderTemplate(template: string, msg: ServiceBusReceivedMessage, json: boolean): string {
  const scope = {
    messageId: msg.messageId?.toString(),
    correlationId: msg.correlationId?.toString(),
    subject: msg.subject,
    now: new Date().toISOString(),
    uuid: randomUUID(),
    body: normalizeBody(msg.body),
    props: msg.applicationProperties ?? {},
  };
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = lookup(path, scope);
    if (json) return JSON.stringify(value ?? null);
    return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  });
}

async function reply(r: Responder, msg: ServiceBusReceivedMessage): Promise<void> {
  const { config } = r;
  const target = config.replyTo || msg.replyTo;
  if (!target) throw new Error("no replyTo on message and no fixed reply target configured");

  let body: unknown = normalizeBody(msg.body);
  if (config.replyBody.trim()) {
    const rendered = renderTemplate(config.replyBody, msg, config.replyJson);
    body = config.replyJson ? JSON.parse(rendered) : rendered;
  }

  const replyMessage = {
    body,
    contentType: config.replyJson ? "application/json" : "text/plain",
    correlationId: msg.correlationId ?? msg.messageId,
    subject: config.replySubject || msg.subject,
    sessionId: msg.replyToSessionId,
  };
  await localBus.getSender(target).sendMessages(replyMessage);
  record("replied", target, `reply to ${r.source.id}`, toView(replyMessage));
}

async function handle(r: Responder, msg: ServiceBusReceivedMessage): Promise<void> {
  const receiver = r.receiver!;
  const { config } = r;
  record("received", r.source.id, `mode=${config.mode}`, toView(msg));

  if (config.delayMs > 0) await new Promise((res) => setTimeout(res, Math.min(config.delayMs, MAX_DELAY_MS)));

  try {
    switch (config.mode) {
      case "log":
        await receiver.completeMessage(msg);
        break;
      case "reply":
        await reply(r, msg);
        await receiver.completeMessage(msg);
        break;
      case "abandon":
        await receiver.abandonMessage(msg);
        record("info", r.source.id, `abandoned (delivery ${msg.deliveryCount})`);
        break;
      case "deadletter":
        await receiver.deadLetterMessage(msg, {
          deadLetterReason: config.deadLetterReason || "MockDeadLetter",
          deadLetterErrorDescription: "Dead-lettered by service-bus mock",
        });
        record("info", r.source.id, "dead-lettered");
        break;
      case "off":
        // Mode switched to off while this message was in flight: leave it for someone else.
        await receiver.abandonMessage(msg);
        break;
    }
    r.handled++;
  } catch (err) {
    record("error", r.source.id, `handler failed: ${errorMessage(err)}`);
    // Complete so a broken reply config doesn't redeliver the same message in a tight loop.
    await receiver.completeMessage(msg).catch(() => {});
  }
}

function start(r: Responder): void {
  const receiver = localBus.createReceiver(r.source, { receiveMode: "peekLock" });
  r.receiver = receiver;
  // The SDK keeps retrying while the emulator is down; don't log the same error every second.
  let lastError = "";
  let lastErrorAt = 0;
  const sub = receiver.subscribe(
    {
      processMessage: (msg) => {
        lastError = "";
        return handle(r, msg);
      },
      processError: async (args) => {
        const text = `${args.errorSource}: ${errorMessage(args.error)}`;
        if (text === lastError && Date.now() - lastErrorAt < ERROR_REPEAT_MS) return;
        lastError = text;
        lastErrorAt = Date.now();
        record("error", r.source.id, text);
      },
    },
    { autoCompleteMessages: false, maxConcurrentCalls: 1 },
  );
  r.stop = async () => {
    await sub.close();
    await receiver.close();
  };
  record("info", r.source.id, "listening");
}

async function stop(r: Responder): Promise<void> {
  await r.stop?.();
  r.stop = undefined;
  r.receiver = undefined;
  record("info", r.source.id, "stopped listening");
}

/**
 * Brings responders in line with the current sources: stops and drops removed ones, adds new ones
 * (with saved defaults from responders.json) and leaves existing ones untouched.
 */
export async function syncResponders(sources: ReceiveSource[]): Promise<void> {
  const ids = new Set(sources.map((s) => s.id));
  for (const [id, r] of responders) {
    if (ids.has(id)) continue;
    if (r.stop) await stop(r);
    responders.delete(id);
  }
  const saved: Record<string, Partial<ResponderConfig>> = existsSync(defaultsPath)
    ? JSON.parse(readFileSync(defaultsPath, "utf8"))
    : {};
  for (const source of sources) {
    if (responders.has(source.id)) continue;
    const r: Responder = { source, config: { ...DEFAULT_CONFIG, ...saved[source.id] }, handled: 0 };
    responders.set(source.id, r);
    if (r.config.mode !== "off") start(r);
  }
}

export function listResponders() {
  return [...responders.values()].map((r) => ({
    source: r.source,
    config: r.config,
    listening: !!r.receiver,
    handled: r.handled,
  }));
}

export async function updateResponder(id: string, patch: Partial<ResponderConfig>): Promise<ResponderConfig> {
  const r = responders.get(id);
  if (!r) throw new Error(`unknown source ${id}`);
  if (patch.mode && !MODES.includes(patch.mode)) throw new Error(`unknown mode ${patch.mode}`);

  const wasActive = r.config.mode !== "off";
  r.config = { ...r.config, ...patch };
  const isActive = r.config.mode !== "off";

  if (!wasActive && isActive) start(r);
  else if (wasActive && !isActive) await stop(r);
  return r.config;
}

/** Writes the current responder configs to responders.json so they're applied on next start. */
export function saveDefaults(): string {
  const data = Object.fromEntries([...responders.values()].map((r) => [r.source.id, r.config]));
  writeFileSync(defaultsPath, JSON.stringify(data, null, 2) + "\n");
  return defaultsPath;
}

export async function stopAll(): Promise<void> {
  await Promise.allSettled([...responders.values()].filter((r) => r.stop).map(stop));
}
