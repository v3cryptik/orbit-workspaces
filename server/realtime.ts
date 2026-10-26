import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { accessWorkspace, validSession } from "./data.ts";
import { accessProject, type Actor } from "./work-data.ts";
import { runWorkspace } from "./tenant.ts";
export type Invalidation = {
  workspaceId: string;
  projectId?: string;
  kind?: string;
};
export interface LiveEvents {
  publish(event: Invalidation): Promise<void>;
  revokeSession(sessionId: string): void;
}
export async function attachRealtime(
  server: HttpServer,
  config: { secret: string; origin: string; redisUrl?: string },
): Promise<LiveEvents & { close(): Promise<void> }> {
  const io = new Server(server, {
    path: "/api/socket.io",
    maxHttpBufferSize: 4096,
    serveClient: false,
    cors: { origin: config.origin, credentials: true },
    allowRequest: (req, callback) =>
      callback(null, req.headers.origin === config.origin),
  });
  let redis: ReturnType<typeof createClient> | undefined;
  let subscriber: typeof redis;
  if (config.redisUrl) {
    redis = createClient({ url: config.redisUrl });
    redis.on("error", () => {});
    subscriber = redis.duplicate();
    subscriber.on("error", () => {});
    await Promise.all([redis.connect(), subscriber.connect()]);
    io.adapter(createAdapter(redis, subscriber));
  }
  const verify = (token: string, audience: string) =>
    jwt.verify(token, config.secret, {
      issuer: "orbit",
      audience,
      algorithms: ["HS256"],
    }) as JwtPayload;
  async function identity(socket: any): Promise<Actor> {
    const payload = verify(socket.handshake.auth.token, "workspace");
    const cookie = String(socket.request.headers.cookie ?? "")
      .split(";")
      .find((part: string) => part.trim().startsWith("orbit_session="))
      ?.trim()
      .slice("orbit_session=".length);
    if (!cookie) throw new Error("Sign in required.");
    const session = verify(decodeURIComponent(cookie), "session");
    if (
      payload.sub !== session.sub ||
      payload.sid !== session.sid ||
      typeof payload.workspaceId !== "string" ||
      typeof session.sub !== "string" ||
      typeof session.sid !== "string" ||
      !(await validSession(session.sid, session.sub))
    )
      throw new Error("Session expired.");
    const { workspace } = await accessWorkspace(
      payload.workspaceId,
      session.sub,
    );
    socket.data.sid = session.sid;
    return {
      id: session.sub,
      name: "",
      role: workspace.role as Actor["role"],
      workspaceId: workspace.id,
    };
  }
  io.use(async (socket, next) => {
    try {
      socket.data.actor = await identity(socket);
      next();
    } catch {
      next(new Error("Live access could not be verified."));
    }
  });
  io.on("connection", (socket) => {
    let packetCount = 0;
    let packetWindow = Date.now();
    socket.use((_packet, next) => {
      if (Date.now() - packetWindow > 10000) {
        packetWindow = Date.now();
        packetCount = 0;
      }
      next(
        ++packetCount <= 30 ? undefined : new Error("Too many live requests."),
      );
    });
    socket.join(`workspace:${socket.data.actor.workspaceId}`);
    socket.on("auth:check", async (ack: unknown) => {
      try {
        socket.data.actor = await identity(socket);
        if (typeof ack === "function") ack({ ok: true });
      } catch {
        socket.emit("access:revoked");
        socket.disconnect(true);
      }
    });
    socket.on("project:watch", async (value: unknown, ack: unknown) => {
      try {
        socket.data.actor = await identity(socket);
        if (typeof value !== "string" || value.length !== 24) throw new Error();
        await runWorkspace(socket.data.actor.workspaceId, () =>
          accessProject(value, socket.data.actor),
        );
        socket.data.projectId = value;
        if (typeof ack === "function") ack({ ok: true });
      } catch {
        if (typeof ack === "function") ack({ ok: false });
      }
    });
    // There are no client-authoritative mutation or arbitrary room-join events.
  });
  async function local(event: Invalidation) {
    const sockets = [...io.of("/").sockets.values()].filter(
      (socket) => socket.data.actor?.workspaceId === event.workspaceId,
    );
    await Promise.all(
      sockets.map(async (socket) => {
        try {
          const actor = await identity(socket);
          socket.data.actor = actor;
          if (event.projectId) {
            try {
              await runWorkspace(actor.workspaceId, () =>
                accessProject(event.projectId!, actor),
              );
            } catch {
              socket.emit("workspace:changed");
              return;
            }
            socket.emit(event.kind ?? "project:changed", {
              projectId: event.projectId,
            });
          }
          socket.emit("workspace:changed");
          socket.emit("notification:new");
        } catch {
          socket.emit("access:revoked");
          socket.disconnect(true);
        }
      }),
    );
  }
  io.on("orbit:invalidate", (event: Invalidation) => {
    void local(event);
  });
  io.on("orbit:logout", (sessionId: string) => revokeLocal(sessionId));
  const revokeLocal = (sid: string) => {
    for (const socket of io.of("/").sockets.values())
      if (socket.data.sid === sid) {
        socket.emit("access:revoked");
        socket.disconnect(true);
      }
  };
  const timer = setInterval(() => {
    void Promise.all(
      [...io.of("/").sockets.values()].map(async (socket) => {
        try {
          await identity(socket);
        } catch {
          socket.emit("access:revoked");
          socket.disconnect(true);
        }
      }),
    );
  }, 30000);
  timer.unref();
  return {
    async publish(event) {
      await local(event);
      if (redis) io.serverSideEmit("orbit:invalidate", event);
    },
    revokeSession(sid) {
      revokeLocal(sid);
      if (redis) io.serverSideEmit("orbit:logout", sid);
    },
    async close() {
      clearInterval(timer);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (subscriber?.isOpen) await subscriber.quit();
      if (redis?.isOpen) await redis.quit();
    },
  };
}
