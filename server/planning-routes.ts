import { Router, type Request } from "express";
import { z } from "zod";
import * as planning from "./planning-data.ts";
import type { Actor } from "./work-data.ts";
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid resource identifier.");
const revision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= "2000-01-01" &&
      value <= "2100-12-31"
    );
  }, "Enter a valid calendar date between 2000 and 2100.");
const sprintFields = {
  name: z.string().trim().min(2).max(80),
  goal: z.string().trim().max(1000).default(""),
  startDate: date,
  endDate: date,
};
const datesValid = (v: { startDate: string; endDate: string }) =>
  v.endDate >= v.startDate &&
  Date.parse(v.endDate) - Date.parse(v.startDate) <= 89 * 86400000;
const log = z
  .object({
    date: date.refine(
      (value) => value <= new Date().toISOString().slice(0, 10),
      "Time entries cannot be in the future (UTC).",
    ),
    minutes: z.number().int().min(1).max(1440),
    note: z.string().trim().max(1000).default(""),
  })
  .strict();
export function planningRouter(actorFor: (req: Request) => Actor) {
  const router = Router({ mergeParams: true });
  router.get("/projects/:projectId/sprints", async (req, res) =>
    res.json(
      await planning.planning(String(req.params.projectId), actorFor(req)),
    ),
  );
  router.post("/projects/:projectId/sprints", async (req, res) => {
    const values = z
      .object(sprintFields)
      .strict()
      .refine(datesValid, "A sprint must last between 1 and 90 calendar days.")
      .parse(req.body);
    res
      .status(201)
      .json(
        await planning.createSprint(
          String(req.params.projectId),
          actorFor(req),
          values,
        ),
      );
  });
  router.patch("/projects/:projectId/sprints/:sprintId", async (req, res) => {
    const values = z
      .object({ ...sprintFields, revision })
      .strict()
      .refine(datesValid, "A sprint must last between 1 and 90 calendar days.")
      .parse(req.body);
    res.json(
      await planning.editSprint(
        String(req.params.projectId),
        String(req.params.sprintId),
        actorFor(req),
        values,
      ),
    );
  });
  router.patch("/projects/:projectId/sprint-tasks", async (req, res) => {
    const values = z
      .object({
        sprintId: id.nullable(),
        taskIds: z
          .array(id)
          .min(1)
          .max(500)
          .refine(
            (ids) => new Set(ids).size === ids.length,
            "Choose distinct task identifiers.",
          ),
        boardVersion: revision,
      })
      .strict()
      .parse(req.body);
    res.json(
      await planning.assignSprint(
        String(req.params.projectId),
        actorFor(req),
        values,
      ),
    );
  });
  router.post(
    "/projects/:projectId/sprints/:sprintId/start",
    async (req, res) =>
      res.json(
        await planning.startSprint(
          String(req.params.projectId),
          String(req.params.sprintId),
          actorFor(req),
          z
            .object({ revision, boardVersion: revision })
            .strict()
            .parse(req.body),
        ),
      ),
  );
  router.post(
    "/projects/:projectId/sprints/:sprintId/complete",
    async (req, res) =>
      res.json(
        await planning.completeSprint(
          String(req.params.projectId),
          String(req.params.sprintId),
          actorFor(req),
          z
            .object({
              revision,
              boardVersion: revision,
              carryToId: id.nullable(),
            })
            .strict()
            .parse(req.body),
        ),
      ),
  );
  router.get(
    "/projects/:projectId/reports/burndown/:sprintId",
    async (req, res) =>
      res.json(
        await planning.sprintReport(
          String(req.params.projectId),
          String(req.params.sprintId),
          actorFor(req),
        ),
      ),
  );
  router.get("/projects/:projectId/reports/velocity", async (req, res) =>
    res.json(
      await planning.velocity(String(req.params.projectId), actorFor(req)),
    ),
  );
  router.get("/projects/:projectId/reports/workload", async (req, res) =>
    res.json(
      await planning.workload(String(req.params.projectId), actorFor(req)),
    ),
  );
  router.post("/projects/:projectId/tasks/:taskId/time", async (req, res) => {
    await planning.addTime(
      String(req.params.projectId),
      String(req.params.taskId),
      actorFor(req),
      log.parse(req.body),
    );
    res.status(201).json({ saved: true });
  });
  router.patch("/time/:id", async (req, res) => {
    await planning.editTime(
      String(req.params.id),
      actorFor(req),
      log.extend({ revision }).parse(req.body),
    );
    res.json({ saved: true });
  });
  router.delete("/time/:id", async (req, res) => {
    await planning.deleteTime(
      String(req.params.id),
      actorFor(req),
      z.object({ revision }).strict().parse(req.body).revision,
    );
    res.status(204).end();
  });
  router.get("/timesheet", async (req, res) => {
    const filters = z
      .object({
        from: date,
        to: date,
        scope: z.enum(["mine", "team"]).default("mine"),
        projectId: id.optional(),
        userId: id.optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.to >= v.from &&
          Date.parse(v.to) - Date.parse(v.from) <= 91 * 86400000,
        "Choose a date range of up to 92 days.",
      )
      .parse(req.query);
    res.json(await planning.timesheet(actorFor(req), filters));
  });
  router.post("/projects/:projectId/tasks/:taskId/timer", async (req, res) => {
    z.object({}).strict().parse(req.body);
    res
      .status(201)
      .json({
        timer: await planning.startTimer(
          String(req.params.projectId),
          String(req.params.taskId),
          actorFor(req),
        ),
      });
  });
  router.post("/timer/:id/stop", async (req, res) => {
    const values = z
      .object({
        note: z.string().trim().max(1000).default(""),
        discard: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    await planning.stopTimer(
      actorFor(req),
      String(req.params.id),
      values.note,
      values.discard,
    );
    res.json({ saved: !values.discard });
  });
  return router;
}
