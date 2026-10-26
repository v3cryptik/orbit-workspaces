import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import pino from "pino";
import pinoHttp from "pino-http";
import { z, ZodError } from "zod";
import * as db from "./data.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { runWorkspace } from "./tenant.ts";
import { workRouter } from "./work-routes.ts";
import { planningRouter } from "./planning-routes.ts";
import {
  collaborationRouter,
  type CollaborationServices,
} from "./collaboration-routes.ts";
import { configuredStore, LocalStore } from "./storage.ts";
import { MailService } from "./mail.ts";
import type { LiveEvents } from "./realtime.ts";

type Auth = { id: string; name: string; email: string; sid: string };
type AuthedRequest = Request & {
  auth: Auth;
  workspace: Awaited<ReturnType<typeof db.accessWorkspace>>["workspace"];
};
export type AppConfig = {
  secret: string;
  origin: string;
  production?: boolean;
  testing?: boolean;
  services?: CollaborationServices;
};
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const password = z.string().min(10, "Use at least 10 characters.").max(128);
const name = z.string().trim().min(2).max(80);
const workspaceBody = z
  .object({
    name,
    slug: z
      .string()
      .trim()
      .min(3)
      .max(50)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lowercase letters, numbers, and single hyphens.",
      ),
    description: z.string().trim().max(300).default(""),
  })
  .strict();
const role = z.enum(["admin", "member", "guest"]);
const cookieName = "orbit_session";
const issuer = "orbit";

export function createApp(config: AppConfig) {
  if (config.secret.length < 32)
    throw new Error("JWT_SECRET must contain at least 32 characters.");
  const app = express();
  // Explicit opt-in for the single trusted Render reverse proxy. Never trust all proxies.
  if (process.env.TRUST_PROXY_HOPS && !config.testing) {
    const hops = Number(process.env.TRUST_PROXY_HOPS);
    if (!Number.isInteger(hops) || hops < 1 || hops > 3)
      throw new Error("TRUST_PROXY_HOPS must be 1, 2, or 3.");
    app.set("trust proxy", hops);
  }
  const services = config.services ?? {
    store: config.testing
      ? new LocalStore()
      : configuredStore(config.production),
    mail: new MailService(config.secret, config),
  };
  app.locals.services = services;
  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      logger: pino({ level: config.testing ? "silent" : "info" }),
      genReqId: () => randomUUID(),
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          path: req.url?.split("?")[0],
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => !req.url?.startsWith("/api") },
    }),
  );
  app.use((req, res, next) => {
    res.set("X-Request-Id", String(req.id));
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: config.production
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:"],
              connectSrc: ["'self'", config.origin.replace(/^http/, "ws")],
              upgradeInsecureRequests: null,
            },
          }
        : false,
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (
        req.get("x-orbit-request") !== "1" ||
        (req.get("origin") && req.get("origin") !== config.origin)
      )
        throw new db.ApiError(403, "Request origin could not be verified.");
    }
    next();
  });
  if (!config.testing)
    app.use(
      "/api",
      rateLimit({
        windowMs: 60_000,
        limit: 600,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many requests. Please try again shortly." },
      }),
    );
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    skip: () => !!config.testing,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "Too many sign-in attempts. Please try again in 15 minutes.",
    },
  });
  const sign = (payload: object, audience: string, expiresIn: number) =>
    jwt.sign(payload, config.secret, {
      issuer,
      audience,
      expiresIn,
      algorithm: "HS256",
    });
  const verify = (token: string, audience: string) =>
    jwt.verify(token, config.secret, {
      issuer,
      audience,
      algorithms: ["HS256"],
    }) as JwtPayload;
  async function establishSession(user: any, res: Response) {
    const session = await db.createSession(String(user._id));
    const token = sign(
      { sub: String(user._id), sid: String(session._id) },
      "session",
      7 * 86400,
    );
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: !!config.production,
      sameSite: "strict",
      maxAge: 7 * 86400000,
      path: "/api",
    });
    return db.publicUser(user);
  }
  async function authenticate(
    req: Request,
    _res: Response,
    next: NextFunction,
  ) {
    try {
      const token = req.cookies[cookieName];
      if (!token) throw new Error();
      const payload = verify(token, "session");
      if (
        typeof payload.sub !== "string" ||
        typeof payload.sid !== "string" ||
        !(await db.validSession(payload.sid, payload.sub))
      )
        throw new Error();
      const user = await db.userById(payload.sub);
      if (!user) throw new Error();
      (req as AuthedRequest).auth = {
        ...db.publicUser(user),
        sid: payload.sid,
      };
      next();
    } catch {
      next(new db.ApiError(401, "Please sign in to continue."));
    }
  }
  const auth = (req: Request) => (req as AuthedRequest).auth;
  app.get("/api/health", (_req, res) => res.json({ status: "ok", phase: 4 }));
  app.post("/api/auth/register", authLimiter, async (req, res) => {
    const values = z.object({ name, email, password }).strict().parse(req.body);
    const user = await db.createUser(
      values.name,
      values.email,
      await hashPassword(values.password),
    );
    res.status(201).json({ user: await establishSession(user, res) });
  });
  app.post("/api/auth/login", authLimiter, async (req, res) => {
    const values = z
      .object({ email, password: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    const user = await db.findUser(values.email);
    // Perform the same expensive password derivation even for an unknown email.
    const fallback = "00000000000000000000000000000000:" + "0".repeat(128);
    const valid = await verifyPassword(
      values.password,
      user?.passwordHash ?? fallback,
    );
    if (!user || !valid)
      throw new db.ApiError(401, "Email or password is incorrect.");
    res.json({ user: await establishSession(user, res) });
  });
  app.get("/api/auth/me", authenticate, (req, res) => {
    const { sid: _sid, ...user } = auth(req);
    res.json({ user });
  });
  app.post("/api/auth/logout", authenticate, async (req, res) => {
    await db.removeSession(auth(req).sid);
    (app.locals.live as LiveEvents | undefined)?.revokeSession(auth(req).sid);
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: !!config.production,
      sameSite: "strict",
      path: "/api",
    });
    res.status(204).end();
  });
  app.get("/api/workspaces", authenticate, async (req, res) =>
    res.json({ workspaces: await db.listWorkspaces(auth(req).id) }),
  );
  app.post("/api/workspaces", authenticate, async (req, res) => {
    const values = workspaceBody.parse(req.body);
    res.status(201).json({
      workspace: await db.createWorkspace(
        auth(req),
        values.name,
        values.slug,
        values.description,
      ),
    });
  });
  app.post("/api/workspaces/:id/session", authenticate, async (req, res) => {
    const { workspace } = await db.accessWorkspace(
      String(req.params.id),
      auth(req).id,
    );
    res.json({
      workspace,
      token: sign(
        { sub: auth(req).id, sid: auth(req).sid, workspaceId: workspace.id },
        "workspace",
        3600,
      ),
      expiresIn: 3600,
    });
  });
  app.post("/api/invites/accept", authenticate, async (req, res) => {
    const { token } = z
      .object({ token: z.string().min(20).max(2048) })
      .strict()
      .parse(req.body);
    let payload: JwtPayload;
    try {
      payload = verify(token, "invitation");
    } catch {
      throw new db.ApiError(400, "This invitation is invalid or expired.");
    }
    if (
      typeof payload.workspaceId !== "string" ||
      payload.email !== auth(req).email
    )
      throw new db.ApiError(
        400,
        "Sign in with the email address this invitation was sent to.",
      );
    res.json({
      workspace: await db.acceptInvite(payload.workspaceId, auth(req), token),
    });
  });

  const router = express.Router({ mergeParams: true });
  router.use(authenticate, async (req, _res, next) => {
    let payload: JwtPayload;
    try {
      payload = verify(req.get("x-workspace-token") ?? "", "workspace");
    } catch {
      throw new db.ApiError(
        401,
        "Your workspace session expired. Please reload.",
      );
    }
    const workspaceId = String(req.params.workspaceId);
    if (
      payload.sub !== auth(req).id ||
      payload.sid !== auth(req).sid ||
      payload.workspaceId !== workspaceId
    )
      throw new db.ApiError(
        403,
        "This session belongs to a different workspace.",
      );
    const { workspace } = await db.accessWorkspace(workspaceId, auth(req).id);
    (req as AuthedRequest).workspace = workspace;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const projectId = req.path.match(
        /^\/projects\/([a-f\d]{24})(?:\/|$)/i,
      )?.[1];
      const kind = req.path.endsWith("/move")
        ? "task:moved"
        : req.path.includes("/comments")
          ? "comment:new"
          : req.path.includes("/tasks")
            ? "task:updated"
            : "project:changed";
      resChanged(req, app, workspaceId, projectId, kind);
    }
    runWorkspace(workspaceId, () => next());
  });
  const workspace = (req: Request) => (req as AuthedRequest).workspace;
  function manager(req: Request, _res: Response, next: NextFunction) {
    if (!["owner", "admin"].includes(workspace(req).role))
      throw new db.ApiError(
        403,
        "You need owner or admin access for this action.",
      );
    next();
  }
  router.get("/overview", async (req, res) => {
    const members = await db.workspaceMembers();
    const activity = await db.activities({
      id: auth(req).id,
      role: workspace(req).role,
    });
    res.json({
      workspace: workspace(req),
      members,
      activity: activity.slice(0, 8),
      stats: { members: members.length },
      permissions: {
        manageMembers: ["owner", "admin"].includes(workspace(req).role),
        editWorkspace: ["owner", "admin"].includes(workspace(req).role),
      },
    });
  });
  router.get("/members", async (_req, res) =>
    res.json({ members: await db.workspaceMembers() }),
  );
  router.get("/activity", async (req, res) =>
    res.json({
      activity: await db.activities({
        id: auth(req).id,
        role: workspace(req).role,
      }),
    }),
  );
  router.patch("/settings", manager, async (req, res) => {
    const values = z
      .object({ name, description: z.string().trim().max(300) })
      .strict()
      .parse(req.body);
    await db.updateWorkspace(workspace(req).id, auth(req), values);
    res.json({
      workspace: (await db.accessWorkspace(workspace(req).id, auth(req).id))
        .workspace,
    });
  });
  router.patch("/members/:id", manager, async (req, res) => {
    const values = z.object({ role }).strict().parse(req.body);
    await db.changeMember(
      workspace(req).id,
      auth(req),
      workspace(req).role as db.Role,
      String(req.params.id),
      values.role,
    );
    res.json({ members: await db.workspaceMembers() });
  });
  router.delete("/members/:id", manager, async (req, res) => {
    await db.changeMember(
      workspace(req).id,
      auth(req),
      workspace(req).role as db.Role,
      String(req.params.id),
      null,
    );
    res.status(204).end();
  });
  router.get("/invites", manager, async (_req, res) =>
    res.json({ invites: await db.invites() }),
  );
  router.post("/invites", manager, async (req, res) => {
    const values = z.object({ email, role }).strict().parse(req.body);
    if (values.role === "admin" && workspace(req).role !== "owner")
      throw new db.ApiError(403, "Only the owner can invite admins.");
    const token = sign(
      {
        workspaceId: workspace(req).id,
        email: values.email,
        nonce: randomUUID(),
      },
      "invitation",
      48 * 3600,
    );
    const expiresAt = new Date(Date.now() + 48 * 3600000);
    await db.createInvite(
      workspace(req).id,
      auth(req),
      values.email,
      values.role,
      token,
      expiresAt,
      services.mail.invitation(
        workspace(req).name,
        auth(req).name,
        values.role,
        `${config.origin}/?invite=${encodeURIComponent(token)}`,
      ),
    );
    res.status(201).json({
      url: `${config.origin}/?invite=${encodeURIComponent(token)}`,
      expiresAt,
      delivery:
        services.mail.mode === "disabled"
          ? "disabled"
          : services.mail.mode === "local"
            ? "local"
            : "queued",
    });
  });
  router.delete("/invites/:id", manager, async (req, res) => {
    await db.revokeInvite(
      workspace(req).id,
      auth(req),
      workspace(req).role as db.Role,
      String(req.params.id),
    );
    res.status(204).end();
  });
  router.use(
    workRouter((req) => ({
      ...auth(req),
      role: workspace(req).role as db.Role,
      workspaceId: workspace(req).id,
    })),
  );
  router.use(
    collaborationRouter(
      (req) => ({
        ...auth(req),
        role: workspace(req).role as db.Role,
        workspaceId: workspace(req).id,
      }),
      services,
      config.testing,
    ),
  );
  router.use(
    planningRouter((req) => ({
      ...auth(req),
      role: workspace(req).role as db.Role,
      workspaceId: workspace(req).id,
    })),
  );
  app.use("/api/w/:workspaceId", router);
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  return app;
}

function resChanged(
  req: Request,
  app: express.Express,
  workspaceId: string,
  projectId: string | undefined,
  kind: string,
) {
  req.res?.once("finish", () => {
    if (req.res!.statusCode < 300)
      void (app.locals.live as LiveEvents | undefined)
        ?.publish({ workspaceId, projectId, kind })
        .catch(() => req.log?.warn("Live refresh unavailable"));
  });
}

export function apiErrorHandler(
  error: any,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (error instanceof ZodError) {
    res
      .status(400)
      .json({ error: error.issues[0]?.message ?? "Invalid request." });
    return;
  }
  if (error?.name === "MulterError") {
    res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "Files must be 10 MB or smaller."
          : "Upload exactly one file without extra fields.",
    });
    return;
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error?.code === 11000) {
    res.status(409).json({
      error:
        "That email, workspace address, project key, or membership already exists.",
    });
    return;
  }
  if (error instanceof db.ApiError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON." });
    return;
  }
  if (error?.type === "entity.too.large") {
    res.status(413).json({ error: "Request is too large." });
    return;
  }
  req.log?.error({ err: error }, "Request failed");
  res.status(500).json({
    error: "Something went wrong. Please try again.",
    requestId: req.id,
  });
}
