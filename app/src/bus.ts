import {
  ServiceBusClient,
  type ServiceBusMessage,
  type ServiceBusReceiver,
  type ServiceBusReceiverOptions,
  type ServiceBusSender,
} from "@azure/service-bus";
import { settings, type ReceiveSource } from "./config.ts";
import { record, toView, type MessageView } from "./events.ts";

// Fail fast: the default retry policy can take ~90s to report that the emulator isn't running.
export const client = new ServiceBusClient(settings.connectionString, {
  retryOptions: { maxRetries: 2, retryDelayInMs: 500, timeoutInMs: 10_000 },
});

function leafMessages(err: unknown): string[] {
  if (err instanceof AggregateError && err.errors.length) return err.errors.flatMap(leafMessages);
  return [err instanceof Error ? err.message || err.name : String(err)];
}

/** Connection failures arrive as (nested, repeated) AggregateErrors with empty messages; flatten them. */
export function errorMessage(err: unknown): string {
  const messages = [...new Set(leafMessages(err))];
  if (messages.some((m) => m.includes("ECONNREFUSED"))) {
    return `Can't reach the Service Bus emulator (${messages.join("; ")}). Is it running?`;
  }
  return messages.join("; ");
}

const senders = new Map<string, ServiceBusSender>();

export function getSender(entity: string): ServiceBusSender {
  let sender = senders.get(entity);
  if (!sender) {
    sender = client.createSender(entity);
    senders.set(entity, sender);
  }
  return sender;
}

export function createReceiver(source: ReceiveSource, options?: ServiceBusReceiverOptions): ServiceBusReceiver {
  return source.kind === "queue"
    ? client.createReceiver(source.queue!, options)
    : client.createReceiver(source.topic!, source.subscription!, options);
}

export interface SendRequest {
  target: string;
  body: string;
  /** Parse `body` as JSON and send it as an object with contentType application/json. */
  json?: boolean;
  count?: number;
  messageId?: string;
  correlationId?: string;
  subject?: string;
  contentType?: string;
  replyTo?: string;
  replyToSessionId?: string;
  sessionId?: string;
  to?: string;
  applicationProperties?: Record<string, string | number | boolean>;
}

/** Drops empty strings so optional form fields don't end up as "" on the message. */
function clean<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== "")) as T;
}

export async function send(req: SendRequest): Promise<MessageView[]> {
  const body = req.json ? JSON.parse(req.body) : req.body;
  const count = Math.max(1, Math.min(req.count ?? 1, 1000));
  const messages: ServiceBusMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      clean({
        body,
        contentType: req.contentType || (req.json ? "application/json" : "text/plain"),
        // With count > 1 a fixed messageId would trip duplicate detection, so suffix it.
        messageId: req.messageId && count > 1 ? `${req.messageId}-${i + 1}` : req.messageId,
        correlationId: req.correlationId,
        subject: req.subject,
        replyTo: req.replyTo,
        replyToSessionId: req.replyToSessionId,
        sessionId: req.sessionId,
        to: req.to,
        applicationProperties:
          req.applicationProperties && Object.keys(req.applicationProperties).length
            ? req.applicationProperties
            : undefined,
      }),
    );
  }

  await getSender(req.target).sendMessages(messages);
  const views = messages.map(toView);
  for (const view of views) record("sent", req.target, "sent", view);
  return views;
}

export async function peek(source: ReceiveSource, deadLetter: boolean, max = 50): Promise<MessageView[]> {
  const receiver = createReceiver(source, deadLetter ? { subQueueType: "deadLetter" } : undefined);
  try {
    const messages = await receiver.peekMessages(max);
    return messages.map(toView);
  } finally {
    await receiver.close();
  }
}

/** Removes all messages by receiving them in receiveAndDelete mode. Returns the number removed. */
export async function purge(source: ReceiveSource, deadLetter: boolean): Promise<number> {
  const receiver = createReceiver(source, {
    receiveMode: "receiveAndDelete",
    subQueueType: deadLetter ? "deadLetter" : undefined,
  });
  let removed = 0;
  try {
    for (;;) {
      const batch = await receiver.receiveMessages(100, { maxWaitTimeInMs: 1000 });
      if (batch.length === 0) break;
      removed += batch.length;
    }
  } finally {
    await receiver.close();
  }
  record("info", source.id, `purged ${removed} message(s)${deadLetter ? " from dead-letter queue" : ""}`);
  return removed;
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([...senders.values()].map((s) => s.close()));
  await client.close();
}
