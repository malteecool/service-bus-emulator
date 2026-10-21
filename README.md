# Service Bus emulator + mock responder

Local setup for developing against Azure Service Bus without a real namespace:

- **`emulator/`**: Microsoft's official [Service Bus emulator](https://github.com/Azure/azure-service-bus-emulator-installer) in Docker. Queues, topics and subscriptions are defined in `emulator/config.json`.
- **`app/`**: a small Node/TypeScript app with a web UI that sends test messages and acts as a **mock integration layer**: it listens on queues/subscriptions and logs, replies to, abandons or dead-letters what arrives.

## 1. Start the emulator

Copy `emulator/.env.example` to `emulator/.env`, then set `ACCEPT_EULA="Y"` and choose a strong `SQL_PASSWORD` (8+ characters from at least 3 of: uppercase, lowercase, digits, symbols). `.env` is git-ignored.

Then either use the **Emulator** controls in the app's header (Start / Stop / Restart / Pull latest / Logs; works with Docker or Podman, see below), or run compose yourself:

```bash
docker compose -p microsoft-azure-servicebus-emulator -f emulator/docker-compose.yaml up -d
```

The emulator listens for AMQP on `localhost:5672`. It reads `emulator/config.json` at startup, so restart it after changing entities (and restart the app too, so it picks up the new names).

### Docker or Podman

The app works with **Docker** or **Podman**. The engine selector in the header defaults to `auto`: Docker if its daemon responds, otherwise Podman. Set `CONTAINER_ENGINE=docker|podman` to choose at startup.

- **Docker** uses `docker compose` (Compose v2) if available, otherwise the standalone `docker-compose`.
- **Podman** uses `podman compose` (Podman 4.7+, which needs a provider such as podman-compose or docker-compose installed), otherwise `podman-compose`. On Windows and macOS, the Podman machine must be running (`podman machine start`).

Status and logs use plain `docker`/`podman` commands on the fixed container names (`servicebus-emulator`, `sqledge`), so they work the same whichever compose tool created the containers. Containers are always created under the project name `microsoft-azure-servicebus-emulator`, so the app's controls and manual commands manage the same containers. The status badge shows container state plus the emulator's health endpoint on port 5300; hover over it for details. Command output appears in the activity feed.

## 2. Start the app

Requires Node 20+.

```bash
cd app
npm install
npm run dev
```

Open http://localhost:3000.

| Env var | Default | |
|---|---|---|
| `SB_CONNECTION_STRING` | emulator connection string | Any Service Bus connection string |
| `EMULATOR_CONFIG` | `../emulator/config.json` | Where queue/topic names are read from |
| `PORT` | `3000` | UI/API port |
| `RESPONDERS_FILE` | `responders.json` | Saved responder defaults |
| `CONTAINER_ENGINE` | `auto` | `docker`, `podman` or `auto` |
| `EMULATOR_COMPOSE` | `../emulator/docker-compose.yaml` | Compose file used by the Emulator controls |
| `EMULATOR_HTTP_PORT` | `5300` | Emulator health/management port |

## Using the UI

**Send**: pick a queue or topic, write a body (JSON or text), optionally set `correlationId`, `replyTo`, `subject`, application properties and so on, and send one or many. Save frequently used messages as templates (stored in your browser).

**Mock responders**: one per queue and topic subscription. Choose a mode:

| Mode | Behaviour |
|---|---|
| `off` | Not listening; messages stay in the queue (use **Peek** to see them) |
| `log` | Receive, log and complete |
| `reply` | Send a reply, then complete. The reply goes to the message's `replyTo`, or a fixed target set in *Reply settings*. Its `correlationId` is the request's `correlationId` (or `messageId` if none), and its `sessionId` is the request's `replyToSessionId` |
| `abandon` | Abandon the message, so it's redelivered until `MaxDeliveryCount`, then dead-lettered. Good for testing retry handling |
| `deadletter` | Dead-letter immediately |

*Delay ms* waits before acting on each message, to simulate a slow downstream system. Keep it below the entity's `LockDuration`.

The reply body is a template. Leave it blank to echo the request. Placeholders: `{{body}}`, `{{body.some.path}}`, `{{props.someProperty}}`, `{{messageId}}`, `{{correlationId}}`, `{{subject}}`, `{{now}}`, `{{uuid}}` (a new random ID per reply). With *Reply body is JSON* checked, values are inserted as JSON, so don't quote them:

```json
{ "orderId": {{body.orderId}}, "status": "accepted", "processedAt": {{now}} }
```

**Save as defaults** writes the current responder settings to `app/responders.json`, which is loaded on startup. Commit it to share a mock setup.

**Edit config** (in the header) edits `emulator/config.json` without touching JSON by hand:

- Add, rename and delete queues, topics and subscriptions, and edit their properties. The forms are generated from the emulator's own config schema (`app/src/emulator-config.schema.json`, copied from Microsoft's installer repo), including descriptions and defaults.
- Subscription rules (correlation/SQL filters) are edited as JSON. A **Raw JSON** view edits the whole file.
- Changes are validated as you type: the schema (types, limits, name format) plus duplicate names (case-insensitive), the 50 queues + topics limit, and forwarding targets that must exist. Durations outside the emulator's documented ranges show as warnings.
- **Save** writes the file (the previous version is kept as `config.json.bak`) and refreshes the app's send targets and responders right away.
- **Save & apply to emulator** also recreates the emulator containers, since the emulator only reads its config at startup. Any messages in the emulator are lost.

**Peek / Peek DLQ** shows messages in a queue or subscription (or its dead-letter queue) without consuming them, and lets you purge them.

**Activity** is a live feed (Server-Sent Events) of everything sent, received and replied, with full message properties and bodies.

## Example: request/reply

1. Set the `queue.1` responder to `reply`.
2. Send to `queue.1` with `replyTo` = `queue.replies`.
3. The activity feed shows the request being received and the reply sent. Peek `queue.replies` to see it, or point your own service at `queue.replies`.

## API

The UI is a thin client over a JSON API, which is handy for scripts and tests:

- `GET /api/entities`: send targets, receive sources, modes
- `POST /api/send`: `{ target, body, json?, count?, messageId?, correlationId?, subject?, replyTo?, sessionId?, applicationProperties? }`
- `GET /api/responders`, `PATCH /api/responders?id=<source>` with a partial config, `POST /api/responders/save`
- `GET /api/peek?id=<source>&dlq=true|false`, `POST /api/purge?id=<source>&dlq=true|false`
- `GET /api/activity`, `DELETE /api/activity`, `GET /api/events` (SSE)
- `GET /api/config`, `GET /api/config/schema`, `POST /api/config/validate`, `PUT /api/config?apply=true|false`
- `GET /api/emulator` (container status), `PUT /api/emulator/engine` with `{ engine: "auto"|"docker"|"podman" }`, `POST /api/emulator/up|down|restart|recreate|pull`, `GET /api/emulator/logs?service=emulator|sqledge`

The server only listens on `127.0.0.1` and rejects cross-origin requests, since the API can run docker commands.

Subscription ids look like `topic.1/subscriptions/subscription.1`.

## Credits

Originally based on [alex-wolf-ps/service-bus-emulator](https://github.com/alex-wolf-ps/service-bus-emulator), licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). The C# sample has since been replaced by the Node/TypeScript app.
