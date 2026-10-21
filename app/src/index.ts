import { serve } from "@hono/node-server";
import { reloadEntities, settings } from "./config.ts";
import { closeAll, loadEnvironments } from "./environments.ts";
import { stopAll, syncResponders } from "./responders.ts";
import { createApp } from "./server.ts";

const entities = reloadEntities();
console.log(
  `Loaded ${entities.targets.length} send target(s) and ${entities.sources.length} receive source(s) from ${settings.emulatorConfigPath}`,
);

await syncResponders(entities.sources);
loadEnvironments();

// Localhost only: the API can run docker commands.
const server = serve({ fetch: createApp().fetch, port: settings.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Service Bus mock UI: http://localhost:${info.port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await stopAll();
  await closeAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
