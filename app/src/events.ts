import type { ServiceBusMessage, ServiceBusReceivedMessage } from "@azure/service-bus";

export type ActivityKind = "sent" | "received" | "replied" | "error" | "info";

/** A plain-JSON snapshot of a message, safe to send to the browser. */
export interface MessageView {
  messageId?: string;
  correlationId?: string;
  subject?: string;
  contentType?: string;
  replyTo?: string;
  replyToSessionId?: string;
  sessionId?: string;
  to?: string;
  applicationProperties?: Record<string, unknown>;
  body: unknown;
  deliveryCount?: number;
  sequenceNumber?: string;
  enqueuedTime?: string;
  deadLetterReason?: string;
  deadLetterErrorDescription?: string;
}

export interface Activity {
  id: number;
  time: string;
  kind: ActivityKind;
  /** Queue/topic/subscription the activity relates to. */
  entity: string;
  /** Short human-readable description, e.g. "auto-reply → queue.2". */
  text: string;
  message?: MessageView;
}

const MAX_HISTORY = 500;
const history: Activity[] = [];
const listeners = new Set<(a: Activity) => void>();
let nextId = 1;

export function record(kind: ActivityKind, entity: string, text: string, message?: MessageView): Activity {
  const activity: Activity = { id: nextId++, time: new Date().toISOString(), kind, entity, text, message };
  history.push(activity);
  if (history.length > MAX_HISTORY) history.shift();
  for (const l of listeners) l(activity);
  const tag = kind.toUpperCase().padEnd(8);
  console.log(`${activity.time} ${tag} ${entity} ${text}`);
  return activity;
}

export function getHistory(): Activity[] {
  return [...history];
}

export function clearHistory(): void {
  history.length = 0;
}

export function subscribe(listener: (a: Activity) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bodies can arrive as Buffers (e.g. from .NET senders); decode them for display. */
export function normalizeBody(body: unknown): unknown {
  if (body instanceof Uint8Array) {
    const text = Buffer.from(body).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return body;
}

export function toView(msg: ServiceBusMessage | ServiceBusReceivedMessage): MessageView {
  const received = msg as Partial<ServiceBusReceivedMessage>;
  return {
    messageId: msg.messageId?.toString(),
    correlationId: msg.correlationId?.toString(),
    subject: msg.subject,
    contentType: msg.contentType,
    replyTo: msg.replyTo,
    replyToSessionId: msg.replyToSessionId,
    sessionId: msg.sessionId,
    to: msg.to,
    applicationProperties: msg.applicationProperties as Record<string, unknown> | undefined,
    body: normalizeBody(msg.body),
    deliveryCount: received.deliveryCount,
    sequenceNumber: received.sequenceNumber?.toString(),
    enqueuedTime: received.enqueuedTimeUtc?.toISOString(),
    deadLetterReason: received.deadLetterReason,
    deadLetterErrorDescription: received.deadLetterErrorDescription,
  };
}
