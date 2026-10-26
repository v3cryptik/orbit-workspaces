import "dotenv/config";
import express from "express";
import { resolve } from "node:path";
import { createApp, apiErrorHandler } from "./app.ts";
import { connectDatabase } from "./database.ts";
import { createServer as createHttpServer } from "node:http";
import { attachRealtime } from "./realtime.ts";
import { cleanFiles } from "./collaboration-data.ts";
import type { CollaborationServices } from "./collaboration-routes.ts";

const port = Number(process.env.PORT ?? 4173);
const production = process.env.NODE_ENV === "production";
const database = await connectDatabase();
const app = createApp({
  secret: database.secret,
  origin: process.env.APP_ORIGIN ?? `http://localhost:${port}`,
  production,
});
if (production) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use(apiErrorHandler);
const server = createHttpServer(app);
const live = await attachRealtime(server, {
  secret: database.secret,
  origin: process.env.APP_ORIGIN ?? `http://localhost:${port}`,
  redisUrl: process.env.REDIS_URL,
});
app.locals.live = live;
const services = app.locals.services as CollaborationServices;
let working = false;
const worker = setInterval(async () => {
  if (working) return;
  working = true;
  try {
    await services.mail.process((workspaceId) => live.publish({ workspaceId }));
    await cleanFiles(services.store);
  } catch {
    console.error("Background delivery will retry.");
  } finally {
    working = false;
  }
}, 2000);
worker.unref();
server.listen(port, production ? "0.0.0.0" : "127.0.0.1", () =>
  console.log(`\nOrbit is ready → http://localhost:${port}\n`),
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    clearInterval(worker);
    await live.close();
    server.close();
    await database.close();
    process.exit(0);
  });
