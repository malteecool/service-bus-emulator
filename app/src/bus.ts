import {
  ServiceBusClient,
  type ServiceBusMessage,
  type ServiceBusReceiver,
  type ServiceBusReceiverOptions,
  type ServiceBusSender,
} from "@azure/service-bus";
import { settings, type ReceiveSource } from "./config.ts";
import { record, toView, type MessageView } from "./events.ts";


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

/** The entity a connection string is scoped to (`EntityPath=`), or undefined for namespace-level ones. */
export function entityPathOf(connectionString: string): string | undefined {
  return /(?:^|;)\s*EntityPath=([^;]+)/i.exec(connectionString)?.[1]?.trim() || undefined;
}

/**
 * Service Bus connections for one environment (the local emulator or a real namespace).
 * Holds a namespace-level client and/or entity-level clients: a connection string with
 * `EntityPath=orders` has a key that's only valid for the `orders` queue/topic, so it gets its own
 * client that's used for that entity only.
 */
export class Bus {
  private namespaceClient?: ServiceBusClient;
  private readonly entityClients = new Map<string, ServiceBusClient>();
  private readonly senders = new Map<string, ServiceBusSender>();

  constructor(
    readonly env: string,
    connectionStrings: string | string[],
  ) {
    // Fail fast: the default retry policy can take ~90s to report that the emulator isn't running.
    const options = { retryOptions: { maxRetries: 2, retryDelayInMs: 500, timeoutInMs: 10_000 } };
    for (const cs of [connectionStrings].flat()) {
      const entity = entityPathOf(cs);
      if (entity) this.entityClients.set(entity.toLowerCase(), new ServiceBusClient(cs, options));
      else this.namespaceClient ??= new ServiceBusClient(cs, options);
    }
  }

  /** The client allowed to access `entity` (a queue or topic name). */
  clientFor(entity: string): ServiceBusClient {
    const client = this.entityClients.get(entity.toLowerCase()) ?? this.namespaceClient;
    if (!client) throw new Error(`No connection string in this environment covers "${entity}"`);
    return client;
  }

  getSender(entity: string): ServiceBusSender {
    let sender = this.senders.get(entity);
    if (!sender) {
      sender = this.clientFor(entity).createSender(entity);
      this.senders.set(entity, sender);
    }
    return sender;
  }

  createReceiver(source: ReceiveSource, options?: ServiceBusReceiverOptions): ServiceBusReceiver {
    return source.kind === "queue"
      ? this.clientFor(source.queue!).createReceiver(source.queue!, options)
      : this.clientFor(source.topic!).createReceiver(source.topic!, source.subscription!, options);
  }

  async send(req: SendRequest): Promise<MessageView[]> {
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

    await this.getSender(req.target).sendMessages(messages);
    const views = messages.map(toView);
    for (const view of views) record("sent", req.target, "sent", view, this.env);
    return views;
  }

  async peek(source: ReceiveSource, deadLetter: boolean, max = 50): Promise<MessageView[]> {
    const receiver = this.createReceiver(source, deadLetter ? { subQueueType: "deadLetter" } : undefined);
    try {
      const messages = await receiver.peekMessages(max);
      return messages.map(toView);
    } finally {
      await receiver.close();
    }
  }

  /** Removes all messages by receiving them in receiveAndDelete mode. Returns the number removed. */
  async purge(source: ReceiveSource, deadLetter: boolean): Promise<number> {
    const receiver = this.createReceiver(source, {
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
    record("info", source.id, `purged ${removed} message(s)${deadLetter ? " from dead-letter queue" : ""}`, undefined, this.env);
    return removed;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.senders.values()].map((s) => s.close()));
    const clients = [...this.entityClients.values(), ...(this.namespaceClient ? [this.namespaceClient] : [])];
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}

/** The local emulator; mock responders always run against this one. */
export const localBus = new Bus("local", settings.connectionString);
