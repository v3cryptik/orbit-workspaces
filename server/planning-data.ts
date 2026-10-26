import mongoose, { Schema, type ClientSession } from "mongoose";
import { tenantGuard } from "./tenant.ts";
import { ApiError, logActivity, workspaceMembers } from "./data.ts";
import {
  accessProject,
  accessTask,
  planningTasks,
  assignPlanningTasks,
  lockBoard,
  lockCollaboration,
  listProjects,
  publicTask,
  type Actor,
} from "./work-data.ts";
import type {
  Sprint,
  SprintValues,
  ProgressPoint,
  SprintReport,
  TimeEntry,
  Timesheet,
  Workload,
} from "../shared/planning.ts";

const oid = Schema.Types.ObjectId;
function model(
  name: string,
  fields: Record<string, any>,
  indexes: { fields: Record<string, any>; options?: any }[] = [],
) {
  const schema = new Schema<any>(
    { workspaceId: { type: oid, required: true, index: true }, ...fields },
    { timestamps: true },
  );
  indexes.forEach(({ fields, options }) => schema.index(fields, options));
  schema.plugin(tenantGuard);
  return mongoose.model<any>(name, schema);
}
const metrics = {
  totalTasks: Number,
  doneTasks: Number,
  totalHours: Number,
  doneHours: Number,
  unestimated: Number,
};
const SprintModel = model(
  "Sprint",
  {
    projectId: { type: oid, required: true },
    name: String,
    goal: String,
    startDate: String,
    endDate: String,
    status: {
      type: String,
      enum: ["planned", "active", "completed"],
      default: "planned",
    },
    revision: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    frozen: metrics,
  },
  [
    {
      fields: { workspaceId: 1, projectId: 1, status: 1 },
      options: { unique: true, partialFilterExpression: { status: "active" } },
    },
  ],
);
const Progress = model(
  "SprintProgress",
  { projectId: oid, sprintId: oid, at: Date, ...metrics },
  [{ fields: { workspaceId: 1, sprintId: 1, at: 1 } }],
);
const TimeLog = model(
  "TimeLog",
  {
    projectId: oid,
    taskId: oid,
    taskTitle: String,
    taskCode: String,
    userId: oid,
    userName: String,
    date: String,
    minutes: Number,
    note: String,
    source: { type: String, enum: ["manual", "timer"] },
    revision: { type: Number, default: 0 },
  },
  [{ fields: { workspaceId: 1, userId: 1, date: 1 } }],
);
const TimeDay = model(
  "TimeDay",
  { userId: oid, date: String, minutes: { type: Number, default: 0 } },
  [
    {
      fields: { workspaceId: 1, userId: 1, date: 1 },
      options: { unique: true },
    },
  ],
);
const TimerModel = model(
  "WorkTimer",
  {
    projectId: oid,
    taskId: oid,
    taskTitle: String,
    startedAt: Date,
    userId: oid,
  },
  [{ fields: { workspaceId: 1, userId: 1 }, options: { unique: true } }],
);
export async function initializePlanningModels() {
  await Promise.all(
    [SprintModel, Progress, TimeLog, TimeDay, TimerModel].map((m) => m.init()),
  );
}
const str = (id: any) => (id == null ? null : String(id));
const manager = (actor: Actor) => ["owner", "admin"].includes(actor.role);
function manage(actor: Actor) {
  if (!manager(actor))
    throw new ApiError(403, "Only owners and admins can manage sprints.");
}
function writer(actor: Actor) {
  if (actor.role === "guest")
    throw new ApiError(403, "Guests cannot access time tracking.");
}
function validId(id: string) {
  if (!/^[a-f\d]{24}$/i.test(id)) throw new ApiError(404, "Record not found.");
}
const today = () => new Date().toISOString().slice(0, 10);
const dayMs = 86400000;
function sums(tasks: any[]) {
  const roots = tasks.filter((t) => !t.parentTaskId);
  return {
    totalTasks: roots.length,
    doneTasks: roots.filter((t) => t.status === "done").length,
    totalHours: roots.reduce((n, t) => n + (t.estimateHours ?? 0), 0),
    doneHours: roots
      .filter((t) => t.status === "done")
      .reduce((n, t) => n + (t.estimateHours ?? 0), 0),
    unestimated: roots.filter((t) => t.estimateHours == null).length,
  };
}
function publicSprint(s: any, tasks: any[]): Sprint {
  const counts =
    s.status === "completed"
      ? s.frozen
      : sums(tasks.filter((t) => str(t.sprintId) === str(s._id)));
  return {
    id: String(s._id),
    projectId: String(s.projectId),
    name: s.name,
    goal: s.goal,
    startDate: s.startDate,
    endDate: s.endDate,
    status: s.status,
    revision: s.revision,
    startedAt: s.startedAt?.toISOString() ?? null,
    completedAt: s.completedAt?.toISOString() ?? null,
    totalTasks: counts?.totalTasks ?? 0,
    doneTasks: counts?.doneTasks ?? 0,
    totalHours: counts?.totalHours ?? 0,
    doneHours: counts?.doneHours ?? 0,
    unestimated: counts?.unestimated ?? 0,
  };
}
async function sprintFor(
  projectId: string,
  id: string,
  session?: ClientSession,
) {
  validId(id);
  const sprint = await SprintModel.findOne({ _id: id, projectId }).session(
    session ?? null,
  );
  if (!sprint) throw new ApiError(404, "Sprint not found.");
  return sprint;
}
async function activeProject(
  projectId: string,
  actor: Actor,
  session: ClientSession,
) {
  const p = await accessProject(projectId, actor, session);
  if (p.status !== "active")
    throw new ApiError(
      409,
      "Restore this project before changing planning or time entries.",
    );
  return p;
}
async function event(
  actor: Actor,
  projectId: string,
  action: string,
  detail: string,
  session: ClientSession,
) {
  await logActivity(actor, action, detail, actor.workspaceId, session, {
    projectId,
    meta: {},
  });
}
export async function planning(projectId: string, actor: Actor) {
  // Read all planning values from one snapshot, so boardVersion also protects sprint scope changes.
  return mongoose.connection.transaction(
    async (session) => {
      const project = await accessProject(projectId, actor, session);
      const tasks = await planningTasks(projectId, session);
      const sprints = await SprintModel.find({ projectId })
        .sort({ startDate: -1, _id: -1 })
        .session(session)
        .lean();
      return {
        sprints: sprints.map((s) => publicSprint(s, tasks)),
        tasks: tasks.map(publicTask),
        boardVersion: project.boardVersion,
      };
    },
    { readConcern: { level: "snapshot" } },
  );
}
export async function createSprint(
  projectId: string,
  actor: Actor,
  values: SprintValues,
) {
  manage(actor);
  await mongoose.connection.transaction(async (session) => {
    await activeProject(projectId, actor, session);
    await lockCollaboration(projectId, session);
    await SprintModel.create(
      [{ ...values, workspaceId: actor.workspaceId, projectId }],
      { session },
    );
    await event(
      actor,
      projectId,
      "sprint.created",
      `created sprint ${values.name}`,
      session,
    );
  });
  return planning(projectId, actor);
}
export async function editSprint(
  projectId: string,
  id: string,
  actor: Actor,
  values: SprintValues & { revision: number },
) {
  manage(actor);
  await mongoose.connection.transaction(async (session) => {
    await activeProject(projectId, actor, session);
    const s = await sprintFor(projectId, id, session);
    if (s.status !== "planned")
      throw new ApiError(409, "Only planned sprints can be edited.");
    await lockCollaboration(projectId, session);
    const { revision, ...changes } = values;
    const result = await SprintModel.updateOne(
      { _id: id, revision },
      { $set: changes, $inc: { revision: 1 } },
      { session },
    );
    if (!result.modifiedCount)
      throw new ApiError(409, "This sprint changed. Reload before saving.");
    await event(
      actor,
      projectId,
      "sprint.updated",
      `updated sprint ${values.name}`,
      session,
    );
  });
  return planning(projectId, actor);
}
export async function assignSprint(
  projectId: string,
  actor: Actor,
  values: { sprintId: string | null; taskIds: string[]; boardVersion: number },
) {
  manage(actor);
  await mongoose.connection.transaction(async (session) => {
    await activeProject(projectId, actor, session);
    if (
      values.sprintId &&
      (await sprintFor(projectId, values.sprintId, session)).status ===
        "completed"
    )
      throw new ApiError(409, "Completed sprint scope is locked.");
    const tasks = await planningTasks(projectId, session);
    const selected = tasks.filter((t) =>
      values.taskIds.includes(String(t._id)),
    );
    if (
      selected.length !== values.taskIds.length ||
      selected.some((t) => t.parentTaskId)
    )
      throw new ApiError(
        400,
        "Choose top-level tasks from this project. Subtasks follow their parent.",
      );
    const completed = await SprintModel.find({ projectId, status: "completed" })
      .select("_id")
      .session(session)
      .lean();
    if (
      selected.some((t) =>
        completed.some((s) => str(s._id) === str(t.sprintId)),
      )
    )
      throw new ApiError(
        409,
        "Tasks retained in a completed sprint cannot be reassigned.",
      );
    await lockBoard(projectId, values.boardVersion, session);
    await assignPlanningTasks(
      projectId,
      values.taskIds,
      values.sprintId,
      session,
    );
    await recordSprintProgress(projectId, session);
    await event(
      actor,
      projectId,
      "sprint.scope",
      `updated sprint allocation for ${selected.length} task${selected.length === 1 ? "" : "s"}`,
      session,
    );
  });
  return planning(projectId, actor);
}
export async function startSprint(
  projectId: string,
  id: string,
  actor: Actor,
  values: { revision: number; boardVersion: number },
) {
  manage(actor);
  await mongoose.connection.transaction(async (session) => {
    await activeProject(projectId, actor, session);
    const s = await sprintFor(projectId, id, session);
    if (s.status !== "planned" || s.revision !== values.revision)
      throw new ApiError(409, "This sprint changed. Reload before starting.");
    if (today() < s.startDate || today() > s.endDate)
      throw new ApiError(
        409,
        "Set planned dates to include today (UTC) before starting.",
      );
    if (
      await SprintModel.exists({ projectId, status: "active" }).session(session)
    )
      throw new ApiError(409, "Complete the active sprint first.");
    const tasks = (await planningTasks(projectId, session)).filter(
      (t) => str(t.sprintId) === id && !t.parentTaskId,
    );
    if (!tasks.length)
      throw new ApiError(
        409,
        "Add at least one task before starting this sprint.",
      );
    await lockBoard(projectId, values.boardVersion, session);
    await SprintModel.updateOne(
      { _id: id },
      {
        $set: { status: "active", startedAt: new Date() },
        $inc: { revision: 1 },
      },
      { session },
    );
    await recordSprintProgress(projectId, session);
    await event(
      actor,
      projectId,
      "sprint.started",
      `started sprint ${s.name}`,
      session,
    );
  });
  return planning(projectId, actor);
}
export async function completeSprint(
  projectId: string,
  id: string,
  actor: Actor,
  values: { revision: number; boardVersion: number; carryToId: string | null },
) {
  manage(actor);
  await mongoose.connection.transaction(async (session) => {
    await activeProject(projectId, actor, session);
    const s = await sprintFor(projectId, id, session);
    if (s.status !== "active" || s.revision !== values.revision)
      throw new ApiError(
        409,
        "Only the current active sprint can be completed. Reload and try again.",
      );
    if (
      values.carryToId &&
      (await sprintFor(projectId, values.carryToId, session)).status !==
        "planned"
    )
      throw new ApiError(
        400,
        "Carry unfinished tasks to a planned sprint or the backlog.",
      );
    await lockBoard(projectId, values.boardVersion, session);
    const tasks = (await planningTasks(projectId, session)).filter(
      (t) => str(t.sprintId) === id && !t.parentTaskId,
    );
    const frozen = sums(tasks);
    await recordSprintProgress(projectId, session, true);
    await SprintModel.updateOne(
      { _id: id },
      {
        $set: { status: "completed", completedAt: new Date(), frozen },
        $inc: { revision: 1 },
      },
      { session },
    );
    await assignPlanningTasks(
      projectId,
      tasks.filter((t) => t.status !== "done").map((t) => String(t._id)),
      values.carryToId,
      session,
    );
    await event(
      actor,
      projectId,
      "sprint.completed",
      `completed sprint ${s.name}: ${frozen.doneTasks}/${frozen.totalTasks} tasks done`,
      session,
    );
  });
  return planning(projectId, actor);
}
export async function recordSprintProgress(
  projectId: string,
  session: ClientSession,
  force = false,
) {
  const sprint = await SprintModel.findOne({ projectId, status: "active" })
    .session(session)
    .lean<any>();
  if (!sprint) return;
  const counts = sums(
    (await planningTasks(projectId, session)).filter(
      (t) => str(t.sprintId) === str(sprint._id),
    ),
  );
  const last = await Progress.findOne({ sprintId: sprint._id })
    .sort({ at: -1, _id: -1 })
    .session(session)
    .lean<any>();
  if (
    !force &&
    last &&
    Object.keys(counts).every(
      (key) => last[key] === counts[key as keyof typeof counts],
    )
  )
    return;
  await Progress.create(
    [
      {
        workspaceId: sprint.workspaceId,
        projectId,
        sprintId: sprint._id,
        at: new Date(),
        ...counts,
      },
    ],
    { session },
  );
}
export async function sprintReport(
  projectId: string,
  id: string,
  actor: Actor,
): Promise<SprintReport> {
  return mongoose.connection.transaction(
    async (session) => {
      await accessProject(projectId, actor, session);
      const sprint = publicSprint(
        await sprintFor(projectId, id, session),
        await planningTasks(projectId, session),
      );
      const raw = await Progress.find({ sprintId: id, projectId })
        .sort({ at: 1, _id: 1 })
        .session(session)
        .lean();
      const points: ProgressPoint[] = raw.map((p) => ({
        at: p.at.toISOString(),
        totalTasks: p.totalTasks,
        doneTasks: p.doneTasks,
        remainingTasks: p.totalTasks - p.doneTasks,
        totalHours: p.totalHours,
        doneHours: p.doneHours,
        remainingHours: p.totalHours - p.doneHours,
        unestimated: p.unestimated,
      }));
      const start = Date.parse(`${sprint.startDate}T00:00:00Z`),
        end = Date.parse(`${sprint.endDate}T00:00:00Z`);
      const observedEnd = sprint.completedAt
        ? sprint.completedAt.slice(0, 10)
        : today();
      const days = Array.from(
        { length: Math.round((end - start) / dayMs) + 1 },
        (_, index) => {
          const date = new Date(start + index * dayMs)
            .toISOString()
            .slice(0, 10);
          const point = [...points]
            .reverse()
            .find((p) => p.at.slice(0, 10) <= date);
          return {
            date,
            ideal: Number(
              (
                (points[0]?.remainingTasks ?? 0) *
                (1 - index / Math.max(1, (end - start) / dayMs))
              ).toFixed(2),
            ),
            remaining:
              point && date <= observedEnd ? point.remainingTasks : null,
          };
        },
      );
      return { sprint, points, days };
    },
    { readConcern: { level: "snapshot" } },
  );
}
export async function velocity(projectId: string, actor: Actor) {
  await accessProject(projectId, actor);
  const completed = await SprintModel.find({ projectId, status: "completed" })
    .sort({ completedAt: -1 })
    .limit(12)
    .lean();
  return { sprints: completed.reverse().map((s) => publicSprint(s, [])) };
}
export async function workload(
  projectId: string,
  actor: Actor,
): Promise<Workload> {
  writer(actor);
  await accessProject(projectId, actor);
  const tasks = (await planningTasks(projectId)).filter(
    (t) => !t.parentTaskId && t.status !== "done",
  );
  const members = await workspaceMembers();
  const ids = [...new Set(tasks.map((t) => str(t.assigneeId)))];
  const rows = ids
    .map((id) => {
      const assigned = tasks.filter((t) => str(t.assigneeId) === id);
      return {
        userId: id,
        name: id
          ? (members.find((m) => m.user.id === id)?.user.name ??
            "Former member")
          : "Unassigned",
        tasks: assigned.length,
        estimatedHours: assigned.reduce(
          (n, t) => n + (t.estimateHours ?? 0),
          0,
        ),
        unestimated: assigned.filter((t) => t.estimateHours == null).length,
        overdue: assigned.filter((t) => t.dueDate && t.dueDate < today())
          .length,
      };
    })
    .sort((a, b) => b.estimatedHours - a.estimatedHours || b.tasks - a.tasks);
  return { rows, totalOpen: tasks.length };
}
async function budget(
  actor: Actor,
  date: string,
  delta: number,
  session: ClientSession,
) {
  if (!delta) return;
  if (!(await TimeDay.exists({ userId: actor.id, date }).session(session)))
    await TimeDay.create(
      [{ workspaceId: actor.workspaceId, userId: actor.id, date, minutes: 0 }],
      { session },
    );
  const result = await TimeDay.updateOne(
    {
      userId: actor.id,
      date,
      minutes: { $gte: Math.max(0, -delta), $lte: 1440 - Math.max(0, delta) },
    },
    { $inc: { minutes: delta } },
    { session },
  );
  if (!result.modifiedCount)
    throw new ApiError(
      409,
      "A person can log at most 24 hours per UTC date across this workspace. Adjust existing entries first.",
    );
}
export type LogValues = { date: string; minutes: number; note: string };
export async function addTime(
  projectId: string,
  taskId: string,
  actor: Actor,
  values: LogValues,
) {
  writer(actor);
  await mongoose.connection.transaction(async (session) => {
    const { project, task } = await accessTask(
      projectId,
      taskId,
      actor,
      true,
      session,
    );
    await lockCollaboration(projectId, session);
    await budget(actor, values.date, values.minutes, session);
    await TimeLog.create(
      [
        {
          ...values,
          workspaceId: actor.workspaceId,
          projectId,
          taskId,
          taskTitle: task.title,
          taskCode: `${project.key}-${task.number}`,
          userId: actor.id,
          userName: actor.name,
          source: "manual",
        },
      ],
      { session },
    );
    await event(
      actor,
      projectId,
      "time.logged",
      `logged ${values.minutes} minutes on ${project.key}-${task.number}`,
      session,
    );
  });
}
export async function editTime(
  id: string,
  actor: Actor,
  values: LogValues & { revision: number },
) {
  writer(actor);
  validId(id);
  await mongoose.connection.transaction(async (session) => {
    const log = await TimeLog.findOne({ _id: id, userId: actor.id }).session(
      session,
    );
    if (!log) throw new ApiError(404, "Time entry not found.");
    await activeProject(String(log.projectId), actor, session);
    await lockCollaboration(String(log.projectId), session);
    if (log.revision !== values.revision)
      throw new ApiError(409, "This time entry changed. Reload before saving.");
    if (log.date === values.date)
      await budget(actor, log.date, values.minutes - log.minutes, session);
    else {
      await budget(actor, log.date, -log.minutes, session);
      await budget(actor, values.date, values.minutes, session);
    }
    await TimeLog.updateOne(
      { _id: id, revision: values.revision },
      {
        $set: { date: values.date, minutes: values.minutes, note: values.note },
        $inc: { revision: 1 },
      },
      { session },
    );
    await event(
      actor,
      String(log.projectId),
      "time.updated",
      `updated own time entry for ${log.taskCode}`,
      session,
    );
  });
}
export async function deleteTime(id: string, actor: Actor, revision: number) {
  writer(actor);
  validId(id);
  await mongoose.connection.transaction(async (session) => {
    const log = await TimeLog.findOne({
      _id: id,
      userId: actor.id,
      revision,
    }).session(session);
    if (!log)
      throw new ApiError(
        409,
        "Time entry changed or is not yours. Reload and try again.",
      );
    await activeProject(String(log.projectId), actor, session);
    await lockCollaboration(String(log.projectId), session);
    await budget(actor, log.date, -log.minutes, session);
    await TimeLog.deleteOne({ _id: id, revision }).session(session);
    await event(
      actor,
      String(log.projectId),
      "time.removed",
      `removed own time entry for ${log.taskCode}`,
      session,
    );
  });
}
export async function currentTimer(actor: Actor) {
  const timer = await TimerModel.findOne({ userId: actor.id }).lean<any>();
  return timer
    ? {
        id: String(timer._id),
        projectId: String(timer.projectId),
        taskId: String(timer.taskId),
        taskTitle: timer.taskTitle,
        startedAt: timer.startedAt.toISOString(),
      }
    : null;
}
export async function startTimer(
  projectId: string,
  taskId: string,
  actor: Actor,
) {
  writer(actor);
  await mongoose.connection.transaction(async (session) => {
    const { task } = await accessTask(projectId, taskId, actor, true, session);
    await lockCollaboration(projectId, session);
    if (await TimerModel.exists({ userId: actor.id }).session(session))
      throw new ApiError(
        409,
        "Stop your running timer before starting another.",
      );
    await TimerModel.create(
      [
        {
          workspaceId: actor.workspaceId,
          projectId,
          taskId,
          taskTitle: task.title,
          startedAt: new Date(),
          userId: actor.id,
        },
      ],
      { session },
    );
  });
  return currentTimer(actor);
}
export async function stopTimer(
  actor: Actor,
  id: string,
  note: string,
  discard: boolean,
) {
  writer(actor);
  validId(id);
  await mongoose.connection.transaction(async (session) => {
    const timer = await TimerModel.findOne({
      _id: id,
      userId: actor.id,
    }).session(session);
    if (!timer)
      throw new ApiError(
        409,
        "This timer was already stopped. Reload and try again.",
      );
    if (!discard) {
      // Cap abandoned timers at 24 hours; split at UTC midnight for consistent timesheets.
      const { project, task } = await accessTask(
        String(timer.projectId),
        String(timer.taskId),
        actor,
        false,
        session,
      );
      await lockCollaboration(String(timer.projectId), session);
      let cursor = new Date(timer.startedAt).getTime();
      let minutes = Math.min(
        1440,
        Math.max(1, Math.floor((Date.now() - cursor) / 60000)),
      );
      while (minutes > 0) {
        const date = new Date(cursor).toISOString().slice(0, 10);
        const midnight = Date.parse(`${date}T00:00:00Z`) + dayMs;
        const chunk = Math.min(
          minutes,
          Math.max(1, Math.ceil((midnight - cursor) / 60000)),
        );
        await budget(actor, date, chunk, session);
        await TimeLog.create(
          [
            {
              workspaceId: actor.workspaceId,
              projectId: timer.projectId,
              taskId: timer.taskId,
              taskTitle: task.title,
              taskCode: `${project.key}-${task.number}`,
              userId: actor.id,
              userName: actor.name,
              date,
              minutes: chunk,
              note,
              source: "timer",
            },
          ],
          { session },
        );
        minutes -= chunk;
        cursor = midnight;
      }
      await event(
        actor,
        String(timer.projectId),
        "time.logged",
        `saved timer on ${project.key}-${task.number}`,
        session,
      );
    }
    await TimerModel.deleteOne({ _id: id, userId: actor.id }).session(session);
  });
}
export async function timesheet(
  actor: Actor,
  filters: {
    from: string;
    to: string;
    scope: "mine" | "team";
    projectId?: string;
    userId?: string;
  },
): Promise<Timesheet> {
  writer(actor);
  if ((filters.scope === "team" || filters.userId) && !manager(actor))
    throw new ApiError(403, "Only owners and admins can review team time.");
  const projects = await listProjects(actor);
  if (filters.projectId) await accessProject(filters.projectId, actor);
  const logs = await TimeLog.find({
    projectId: {
      $in: filters.projectId ? [filters.projectId] : projects.map((p) => p.id),
    },
    ...(filters.scope === "mine"
      ? { userId: actor.id }
      : filters.userId
        ? { userId: filters.userId }
        : {}),
    date: { $gte: filters.from, $lte: filters.to },
  })
    .sort({ date: -1, createdAt: -1 })
    .limit(10001)
    .lean();
  if (logs.length > 10000)
    throw new ApiError(
      400,
      "Choose a smaller date range or project to review fewer than 10,000 entries.",
    );
  const entries: TimeEntry[] = logs.map((l) => ({
    id: String(l._id),
    projectId: String(l.projectId),
    projectName: projects.find((p) => p.id === String(l.projectId))?.name ?? "",
    taskId: String(l.taskId),
    taskTitle: l.taskTitle,
    taskCode: l.taskCode,
    userId: String(l.userId),
    userName: l.userName,
    date: l.date,
    minutes: l.minutes,
    note: l.note,
    revision: l.revision,
    source: l.source,
  }));
  const daily = new Map<string, number>(),
    people = new Map<
      string,
      { userId: string; userName: string; minutes: number }
    >();
  entries.forEach((e) => {
    daily.set(e.date, (daily.get(e.date) ?? 0) + e.minutes);
    const p = people.get(e.userId) ?? {
      userId: e.userId,
      userName: e.userName,
      minutes: 0,
    };
    p.minutes += e.minutes;
    people.set(e.userId, p);
  });
  return {
    entries,
    totalMinutes: entries.reduce((n, l) => n + l.minutes, 0),
    daily: [...daily]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, minutes]) => ({ date, minutes })),
    people: [...people.values()],
    timer: await currentTimer(actor),
  };
}
export async function cleanupTaskTime(
  projectId: string,
  taskIds: string[],
  session: ClientSession,
) {
  // Retain logged history and its task labels after task deletion; stop orphaned timers.
  await TimerModel.deleteMany({ projectId, taskId: { $in: taskIds } }).session(
    session,
  );
}
export async function cleanupPlanning(
  projectId: string,
  session: ClientSession,
) {
  const logs = await TimeLog.find({ projectId }).session(session).lean();
  for (const log of logs)
    await budget(
      { id: String(log.userId), workspaceId: String(log.workspaceId) } as Actor,
      log.date,
      -log.minutes,
      session,
    );
  for (const m of [SprintModel, Progress, TimeLog, TimerModel])
    await m.deleteMany({ projectId }).session(session);
}
