import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { errorMessage, peek, purge, send, type SendRequest } from "./bus.ts";
import { getEntities, reloadEntities, settings } from "./config.ts";
import * as containers from "./containers.ts";
import { readConfig, schema, validateConfig, writeConfig, type EmulatorConfig } from "./emulator-config.ts";
import { clearHistory, getHistory, record, subscribe, type Activity } from "./events.ts";
import { getSource, listResponders, MODES, saveDefaults, syncResponders, updateResponder } from "./responders.ts";

export function createApp(): Hono {
  const app = new Hono();

  app.onError((err, c) => c.json({ error: errorMessage(err) }, 400));

  // The API can run docker commands, so only accept requests from this UI: block other sites
  // (cross-origin POSTs) and DNS-rebinding (unexpected Host header).
  app.use("/api/*", async (c, next) => {
    const hostname = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return c.json({ error: "forbidden host" }, 403);
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && origin && new URL(origin).host !== c.req.header("host")) {
      return c.json({ error: "cross-origin request blocked" }, 403);
    }
    await next();
  });

  app.get("/api/entities", (c) =>
    c.json({ ...getEntities(), modes: MODES, configPath: settings.emulatorConfigPath }),
  );

  app.post("/api/send", async (c) => {
    const req = await c.req.json<SendRequest>();
    const sent = await send(req);
    return c.json({ sent: sent.length });
  });

  app.get("/api/responders", (c) => c.json(listResponders()));

  // Source ids contain slashes (topic/subscriptions/sub), so they're passed as a query parameter.
  app.patch("/api/responders", async (c) => {
    const config = await updateResponder(c.req.query("id") ?? "", await c.req.json());
    return c.json(config);
  });

  app.post("/api/responders/save", (c) => c.json({ path: saveDefaults() }));

  app.get("/api/peek", async (c) => {
    const source = getSource(c.req.query("id") ?? "");
    if (!source) return c.json({ error: "unknown source" }, 404);
    return c.json(await peek(source, c.req.query("dlq") === "true"));
  });

  app.post("/api/purge", async (c) => {
    const source = getSource(c.req.query("id") ?? "");
    if (!source) return c.json({ error: "unknown source" }, 404);
    return c.json({ removed: await purge(source, c.req.query("dlq") === "true") });
  });

  app.get("/api/emulator", async (c) => c.json(await containers.status()));
  app.put("/api/emulator/engine", async (c) => {
    await containers.setEngine((await c.req.json<{ engine: containers.EngineChoice }>()).engine);
    return c.json(await containers.status());
  });
  app.post("/api/emulator/:action", async (c) => {
    await containers.run(c.req.param("action") as containers.Action);
    return c.json({ started: true }, 202);
  });
  app.get("/api/emulator/logs", async (c) => c.text(await containers.logs(c.req.query("service"))));

  app.get("/api/config", (c) => c.json(readConfig()));
  app.get("/api/config/schema", (c) => c.json(schema));
  app.post("/api/config/validate", async (c) => c.json(validateConfig(await c.req.json())));

  // Saves Config.json; with ?apply=true also recreates the emulator so it loads the new config.
  app.put("/api/config", async (c) => {
    const result = writeConfig(await c.req.json<EmulatorConfig>());
    if (result.errors.length) return c.json(result, 422);
    await syncResponders(reloadEntities().sources);
    record("info", "config", "emulator config saved");
    const apply = c.req.query("apply") === "true";
    if (apply) await containers.run("recreate");
    return c.json({ ...result, saved: true, applying: apply });
  });

  app.get("/api/activity", (c) => c.json(getHistory()));
  app.delete("/api/activity", (c) => {
    clearHistory();
    return c.body(null, 204);
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: Activity[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = subscribe((a) => {
        queue.push(a);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      while (!stream.aborted) {
        if (queue.length === 0) {
          // Wake on the next activity, or every 25s to send a keep-alive comment.
          await new Promise<void>((res) => {
            wake = res;
            setTimeout(res, 25_000);
          });
          wake = undefined;
          if (queue.length === 0 && !stream.aborted) await stream.write(": ping\n\n");
          continue;
        }
        const a = queue.shift()!;
        await stream.writeSSE({ event: "activity", data: JSON.stringify(a), id: String(a.id) });
      }
    }),
  );

  app.use("/*", serveStatic({ root: "./public" }));

  return app;
}
