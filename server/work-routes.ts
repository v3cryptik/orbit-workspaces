import { Router, type Request } from "express";
import { z } from "zod";
import * as work from "./work-data.ts";
import { taskStatuses, taskPriorities } from "../shared/work.ts";

const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "Invalid resource identifier.");
const revision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const projectValues = z
  .object({
    name: z.string().trim().min(2).max(80),
    key: z
      .string()
      .trim()
      .regex(
        /^[A-Z][A-Z0-9]{1,7}$/,
        "Use a 2–8 character uppercase project key, starting with a letter.",
      ),
    description: z.string().trim().max(1000).default(""),
    leadId: objectId.nullable().default(null),
    guestIds: z
      .array(objectId)
      .max(100)
      .transform((ids) => [...new Set(ids)])
      .default([]),
  })
  .strict();
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= "1900-01-01" &&
      value <= "9999-12-31"
    );
  }, "Enter a valid calendar date.")
  .nullable();
const taskValues = z
  .object({
    title: z.string().trim().min(1).max(180),
    description: z.string().trim().max(8000).default(""),
    status: z.enum(taskStatuses).default("todo"),
    priority: z.enum(taskPriorities).default("medium"),
    assigneeId: objectId.nullable().default(null),
    labels: z
      .array(z.string().trim().min(1).max(24))
      .max(8)
      .transform((labels) => [
        ...new Set(labels.map((label) => label.toLowerCase())),
      ])
      .default([]),
    dueDate: dueDate.default(null),
    estimateHours: z.number().min(0).max(10000).nullable().default(null),
  })
  .strict();
export function workRouter(actorFor: (req: Request) => work.Actor) {
  const router = Router({ mergeParams: true });
  router.get("/my-tasks", async (req, res) =>
    res.json(await work.myTasks(actorFor(req))),
  );
  router.get("/projects", async (req, res) =>
    res.json({ projects: await work.listProjects(actorFor(req)) }),
  );
  router.post("/projects", async (req, res) =>
    res
      .status(201)
      .json(
        await work.createProject(actorFor(req), projectValues.parse(req.body)),
      ),
  );
  router.get("/projects/:projectId/board", async (req, res) =>
    res.json(
      await work.projectBoard(String(req.params.projectId), actorFor(req)),
    ),
  );
  router.get("/projects/:projectId/tasks", async (req, res) => {
    const filters = z
      .object({
        status: z.enum(taskStatuses).optional(),
        priority: z.enum(taskPriorities).optional(),
        assignee: z.union([objectId, z.literal("unassigned")]).optional(),
        label: z.string().trim().max(24).optional(),
        q: z.string().trim().max(180).optional(),
        parentTaskId: objectId.optional(),
        sprintId: z.union([objectId, z.literal("none")]).optional(),
      })
      .strict()
      .parse(req.query);
    const snapshot = await work.projectBoard(
      String(req.params.projectId),
      actorFor(req),
    );
    const tasks = snapshot.tasks.filter(
      (task) =>
        task.parentTaskId === (filters.parentTaskId ?? null) &&
        (!filters.status || task.status === filters.status) &&
        (!filters.sprintId ||
          (filters.sprintId === "none"
            ? !task.sprintId
            : task.sprintId === filters.sprintId)) &&
        (!filters.priority || task.priority === filters.priority) &&
        (!filters.assignee ||
          (filters.assignee === "unassigned"
            ? !task.assigneeId
            : task.assigneeId === filters.assignee)) &&
        (!filters.label || task.labels.includes(filters.label.toLowerCase())) &&
        (!filters.q ||
          `${snapshot.project.key}-${task.number} ${task.title} ${task.description} ${task.labels.join(" ")}`
            .toLowerCase()
            .includes(filters.q.toLowerCase())),
    );
    res.json({
      project: snapshot.project,
      tasks,
      boardVersion: snapshot.project.boardVersion,
    });
  });
  router.patch("/projects/:projectId", async (req, res) => {
    const values = projectValues
      .omit({ key: true })
      .extend({ status: z.enum(["active", "archived"]), revision })
      .strict()
      .parse(req.body);
    res.json(
      await work.updateProject(
        String(req.params.projectId),
        actorFor(req),
        values,
      ),
    );
  });
  router.delete("/projects/:projectId", async (req, res) => {
    const values = z
      .object({ revision, boardVersion: revision })
      .strict()
      .parse(req.body);
    await work.deleteProject(
      String(req.params.projectId),
      actorFor(req),
      values.revision,
      values.boardVersion,
    );
    res.status(204).end();
  });
  router.post("/projects/:projectId/tasks", async (req, res) => {
    const values = taskValues
      .extend({
        parentTaskId: objectId.nullable().default(null),
        boardVersion: revision,
      })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(
        await work.createTask(
          String(req.params.projectId),
          actorFor(req),
          values,
        ),
      );
  });
  router.patch("/projects/:projectId/tasks/:taskId", async (req, res) => {
    const values = taskValues
      .extend({ revision, boardVersion: revision })
      .strict()
      .parse(req.body);
    res.json(
      await work.updateTask(
        String(req.params.projectId),
        String(req.params.taskId),
        actorFor(req),
        values,
      ),
    );
  });
  router.patch("/projects/:projectId/tasks/:taskId/move", async (req, res) => {
    const values = z
      .object({
        status: z.enum(taskStatuses),
        beforeId: objectId.nullable(),
        boardVersion: revision,
      })
      .strict()
      .parse(req.body);
    res.json(
      await work.moveTask(
        String(req.params.projectId),
        String(req.params.taskId),
        actorFor(req),
        values,
      ),
    );
  });
  router.delete("/projects/:projectId/tasks/:taskId", async (req, res) => {
    const values = z
      .object({ revision, boardVersion: revision })
      .strict()
      .parse(req.body);
    res.json(
      await work.deleteTask(
        String(req.params.projectId),
        String(req.params.taskId),
        actorFor(req),
        values.revision,
        values.boardVersion,
      ),
    );
  });
  return router;
}
