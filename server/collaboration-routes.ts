import { Router, type Request } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import * as collaboration from "./collaboration-data.ts";
import { ApiError } from "./data.ts";
import { accessTask, type Actor } from "./work-data.ts";
import { maxFileSize, type ObjectStore } from "./storage.ts";
import { MailService } from "./mail.ts";
export type CollaborationServices = { store: ObjectStore; mail: MailService };
const commentBody = z
  .object({
    body: z.string().trim().min(1).max(4000),
    mentionIds: z
      .array(z.string().regex(/^[a-f\d]{24}$/i))
      .max(10)
      .transform((ids) => [...new Set(ids)])
      .default([]),
  })
  .strict();
const revision = z.number().int().min(0);
export function collaborationRouter(
  actorFor: (req: Request) => Actor,
  services: CollaborationServices,
  testing = false,
) {
  const router = Router({ mergeParams: true });
  router.get("/notifications", async (req, res) =>
    res.json(await collaboration.inbox(actorFor(req))),
  );
  router.patch("/notifications/read", async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await collaboration.readNotifications(actorFor(req)));
  });
  router.patch("/notifications/:id/read", async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(
      await collaboration.readNotifications(
        actorFor(req),
        String(req.params.id),
      ),
    );
  });
  router.get("/mail", async (req, res) =>
    res.json(await services.mail.list(actorFor(req))),
  );
  router.get("/mail/:id/preview", async (req, res) =>
    res.json(await services.mail.preview(actorFor(req), String(req.params.id))),
  );
  router.post("/mail/:id/retry", async (req, res) => {
    await services.mail.retry(actorFor(req), String(req.params.id));
    res.status(204).end();
  });
  const path = "/projects/:projectId/tasks/:taskId";
  const ids = (req: Request) =>
    [String(req.params.projectId), String(req.params.taskId)] as const;
  router.get(`${path}/collaboration`, async (req, res) =>
    res.json(await collaboration.taskCollaboration(actorFor(req), ...ids(req))),
  );
  router.post(`${path}/comments`, async (req, res) =>
    res
      .status(201)
      .json(
        await collaboration.comment(
          actorFor(req),
          ...ids(req),
          commentBody.parse(req.body),
        ),
      ),
  );
  router.patch(`${path}/comments/:id`, async (req, res) => {
    const { revision: value, ...body } = commentBody
      .extend({ revision })
      .strict()
      .parse(req.body);
    res.json(
      await collaboration.comment(actorFor(req), ...ids(req), body, {
        id: String(req.params.id),
        revision: value,
      }),
    );
  });
  router.delete(`${path}/comments/:id`, async (req, res) => {
    const values = z.object({ revision }).strict().parse(req.body);
    res.json(
      await collaboration.deleteComment(
        actorFor(req),
        ...ids(req),
        String(req.params.id),
        values.revision,
      ),
    );
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSize, files: 1, fields: 0, parts: 1 },
  }).single("file");
  router.post(
    `${path}/attachments`,
    rateLimit({
      windowMs: 60000,
      limit: 10,
      skip: () => testing,
      keyGenerator: (req) => `${actorFor(req).workspaceId}:${actorFor(req).id}`,
      message: { error: "Please wait before uploading more files." },
    }),
    async (req, _res, next) => {
      await accessTask(...ids(req), actorFor(req), true);
      next();
    },
    upload,
    async (req, res) => {
      if (!req.file) throw new ApiError(400, "Choose a file to attach.");
      res
        .status(201)
        .json(
          await collaboration.addAttachment(
            actorFor(req),
            ...ids(req),
            req.file.originalname,
            req.file.buffer,
            services.store,
          ),
        );
    },
  );
  router.get(`${path}/attachments/:id/download`, async (req, res) => {
    const file = await collaboration.attachment(
      actorFor(req),
      ...ids(req),
      String(req.params.id),
    );
    const bytes = await services.store.get(file.objectKey);
    res
      .set("Content-Type", "application/octet-stream")
      .set(
        "Content-Disposition",
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      )
      .set("X-Content-Type-Options", "nosniff")
      .set("Content-Security-Policy", "sandbox; default-src 'none'");
    res.send(bytes);
  });
  router.delete(`${path}/attachments/:id`, async (req, res) =>
    res.json(
      await collaboration.deleteAttachment(
        actorFor(req),
        ...ids(req),
        String(req.params.id),
      ),
    ),
  );
  return router;
}
