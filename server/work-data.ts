import mongoose, { Schema, type Types, type ClientSession } from "mongoose";
import { tenantGuard } from "./tenant.ts";
import { ApiError, type Role, logActivity, membershipFor } from "./data.ts";
import {
  taskStatuses,
  taskPriorities,
  statusNames,
  type Project as PublicProject,
  type Task as PublicTask,
  type ProjectValues,
  type TaskValues,
  type TaskStatus,
} from "../shared/work.ts";

export type Actor = {
  id: string;
  name: string;
  role: Role;
  workspaceId: string;
};
type TenantRecord = {
  workspaceId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
type ProjectRecord = TenantRecord & {
  name: string;
  key: string;
  description: string;
  leadId: Types.ObjectId | null;
  guestIds: Types.ObjectId[];
  status: "active" | "archived";
  boardVersion: number;
  revision: number;
  nextTaskNumber: number;
  collaborationVersion: number;
};
type TaskRecord = TenantRecord &
  Omit<
    PublicTask,
    | "id"
    | "projectId"
    | "createdBy"
    | "parentTaskId"
    | "assigneeId"
    | "sprintId"
    | "createdAt"
    | "updatedAt"
    | "completedAt"
  > & {
    projectId: Types.ObjectId;
    parentTaskId: Types.ObjectId | null;
    assigneeId: Types.ObjectId | null;
    sprintId: Types.ObjectId | null;
    createdBy: Types.ObjectId;
    completedAt: Date | null;
  };
const objectId = Schema.Types.ObjectId;
const projectSchema = new Schema<ProjectRecord>(
  {
    workspaceId: { type: objectId, required: true, index: true },
    name: { type: String, required: true },
    key: { type: String, required: true },
    description: { type: String, default: "" },
    leadId: { type: objectId, default: null },
    guestIds: { type: [objectId], default: [] },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    boardVersion: { type: Number, default: 0 },
    revision: { type: Number, default: 0 },
    nextTaskNumber: { type: Number, default: 0 },
    collaborationVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);
projectSchema.index({ workspaceId: 1, key: 1 }, { unique: true });
projectSchema.index({ workspaceId: 1, guestIds: 1, updatedAt: -1 });
projectSchema.plugin(tenantGuard);
const Project = mongoose.model<ProjectRecord>("Project", projectSchema);
const taskSchema = new Schema<TaskRecord>(
  {
    workspaceId: { type: objectId, required: true, index: true },
    projectId: { type: objectId, required: true },
    number: { type: Number, required: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    status: { type: String, enum: taskStatuses, required: true },
    priority: { type: String, enum: taskPriorities, default: "medium" },
    assigneeId: { type: objectId, default: null },
    labels: { type: [String], default: [] },
    dueDate: { type: String, default: null },
    estimateHours: { type: Number, default: null },
    order: { type: Number, required: true },
    parentTaskId: { type: objectId, default: null },
    sprintId: { type: objectId, default: null, index: true },
    revision: { type: Number, default: 0 },
    createdBy: { type: objectId, required: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
taskSchema.index({ workspaceId: 1, projectId: 1, number: 1 }, { unique: true });
taskSchema.index({
  workspaceId: 1,
  projectId: 1,
  parentTaskId: 1,
  status: 1,
  order: 1,
});
taskSchema.index({ workspaceId: 1, assigneeId: 1 });
taskSchema.plugin(tenantGuard);
const Task = mongoose.model<TaskRecord>("Task", taskSchema);
export async function initializeWorkModels() {
  await Promise.all([Project.init(), Task.init()]);
}
function checkId(value: string, noun: string) {
  if (!/^[a-f\d]{24}$/i.test(value))
    throw new ApiError(404, `${noun} not found.`);
}
export function visibleProjects(actor: Actor) {
  return actor.role === "guest" ? { guestIds: actor.id } : {};
}
function assertManager(actor: Actor) {
  if (!["owner", "admin"].includes(actor.role))
    throw new ApiError(403, "Only owners and admins can manage projects.");
}
function assertWriter(actor: Actor) {
  if (actor.role === "guest")
    throw new ApiError(403, "Guests have read-only project access.");
}
const idString = (value: Types.ObjectId | null | undefined) =>
  value ? String(value) : null;
function publicProject(
  project: any,
  taskCount = 0,
  completedCount = 0,
): PublicProject {
  return {
    id: String(project._id),
    name: project.name,
    key: project.key,
    description: project.description,
    leadId: idString(project.leadId),
    guestIds: project.guestIds.map(String),
    status: project.status,
    boardVersion: project.boardVersion,
    revision: project.revision,
    createdAt: new Date(project.createdAt).toISOString(),
    updatedAt: new Date(project.updatedAt).toISOString(),
    taskCount,
    completedCount,
  };
}
export function publicTask(task: any): PublicTask {
  return {
    id: String(task._id),
    projectId: String(task.projectId),
    number: task.number,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigneeId: idString(task.assigneeId),
    labels: task.labels,
    dueDate: task.dueDate,
    estimateHours: task.estimateHours,
    order: task.order,
    parentTaskId: idString(task.parentTaskId),
    sprintId: idString(task.sprintId),
    revision: task.revision,
    createdBy: String(task.createdBy),
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    completedAt: task.completedAt
      ? new Date(task.completedAt).toISOString()
      : null,
  };
}
async function requireProject(
  projectId: string,
  actor: Actor,
  session?: ClientSession,
) {
  checkId(projectId, "Project");
  const project = await Project.findOne({
    _id: projectId,
    ...visibleProjects(actor),
  }).session(session ?? null);
  if (!project) throw new ApiError(404, "Project not found.");
  return project;
}
async function requireTask(
  projectId: string,
  taskId: string,
  session: ClientSession,
) {
  checkId(taskId, "Task");
  const task = await Task.findOne({ _id: taskId, projectId }).session(session);
  if (!task) throw new ApiError(404, "Task not found.");
  return task;
}
function assertActive(project: { status: string }) {
  if (project.status === "archived")
    throw new ApiError(
      409,
      "This project is archived. Restore it before changing tasks.",
    );
}
async function validateProjectMembers(
  actor: Actor,
  values: Pick<ProjectValues, "leadId" | "guestIds">,
  session: ClientSession,
) {
  if (values.leadId) {
    const lead = await membershipFor(values.leadId, session);
    if (!lead || lead.role === "guest")
      throw new ApiError(
        400,
        "Choose a current workspace member as project lead.",
      );
  }
  for (const userId of values.guestIds) {
    const guest = await membershipFor(userId, session);
    if (!guest || guest.role !== "guest")
      throw new ApiError(
        400,
        "Only current workspace guests can be granted guest project access.",
      );
  }
}
async function validateAssignee(userId: string | null, session: ClientSession) {
  if (!userId) return;
  const member = await membershipFor(userId, session);
  if (!member || member.role === "guest")
    throw new ApiError(
      400,
      "Assign tasks to a current workspace owner, admin, or member.",
    );
}
export async function lockBoard(
  projectId: string,
  expectedVersion: number,
  session: ClientSession,
) {
  const locked = await Project.findOneAndUpdate(
    { _id: projectId, boardVersion: expectedVersion, status: "active" },
    { $inc: { boardVersion: 1 } },
    { new: true, session },
  );
  if (!locked)
    throw new ApiError(
      409,
      "This board changed. The latest version has been loaded; please try your change again.",
    );
  return locked;
}
async function workEvent(
  actor: Actor,
  action: string,
  detail: string,
  projectId: string,
  session: ClientSession,
  meta: Record<string, unknown> = {},
) {
  await logActivity(actor, action, detail, actor.workspaceId, session, {
    projectId,
    meta,
  });
}
export async function listProjects(actor: Actor) {
  const projects = await Project.find(visibleProjects(actor))
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  if (!projects.length) return [];
  const counts = await Task.aggregate<{
    _id: Types.ObjectId;
    total: number;
    done: number;
  }>([
    {
      $match: {
        projectId: { $in: projects.map((p) => p._id) },
        parentTaskId: null,
      },
    },
    {
      $group: {
        _id: "$projectId",
        total: { $sum: 1 },
        done: { $sum: { $cond: [{ $eq: ["$status", "done"] }, 1, 0] } },
      },
    },
  ]);
  return projects.map((project) => {
    const count = counts.find((c) => String(c._id) === String(project._id));
    return publicProject(project, count?.total, count?.done);
  });
}
export async function projectBoard(projectId: string, actor: Actor) {
  // Snapshot reads ensure tasks and boardVersion describe the same committed state.
  return mongoose.connection.transaction(
    async (session) => {
      const project = await requireProject(projectId, actor, session);
      const tasks = await Task.find({ projectId })
        .sort({ order: 1, _id: 1 })
        .session(session)
        .lean();
      const roots = tasks.filter((task) => !task.parentTaskId);
      return {
        project: publicProject(
          project,
          roots.length,
          roots.filter((task) => task.status === "done").length,
        ),
        tasks: tasks.map(publicTask),
      };
    },
    { readConcern: { level: "snapshot" } },
  );
}
export async function createProject(actor: Actor, values: ProjectValues) {
  assertManager(actor);
  const projectId = new mongoose.Types.ObjectId();
  await mongoose.connection.transaction(async (session) => {
    await validateProjectMembers(actor, values, session);
    await Project.create(
      [{ _id: projectId, workspaceId: actor.workspaceId, ...values }],
      { session },
    );
    await workEvent(
      actor,
      "project.created",
      `created ${values.name}`,
      String(projectId),
      session,
      { name: values.name, key: values.key },
    );
  });
  return projectBoard(String(projectId), actor);
}
export async function updateProject(
  projectId: string,
  actor: Actor,
  values: Omit<ProjectValues, "key"> & {
    status: "active" | "archived";
    revision: number;
  },
) {
  assertManager(actor);
  await mongoose.connection.transaction(async (session) => {
    const project = await requireProject(projectId, actor, session);
    await validateProjectMembers(actor, values, session);
    const { revision, ...changes } = values;
    const result = await Project.updateOne(
      { _id: projectId, revision },
      { $set: changes, $inc: { revision: 1, boardVersion: 1 } },
      { session, runValidators: true },
    );
    if (!result.modifiedCount)
      throw new ApiError(
        409,
        "Project details changed. Reload the latest details before saving again.",
      );
    await workEvent(
      actor,
      "project.updated",
      `updated ${project.name}`,
      projectId,
      session,
      { before: { status: project.status }, after: { status: values.status } },
    );
  });
  return projectBoard(projectId, actor);
}
export async function deleteProject(
  projectId: string,
  actor: Actor,
  revision: number,
  boardVersion: number,
) {
  assertManager(actor);
  await mongoose.connection.transaction(async (session) => {
    const project = await requireProject(projectId, actor, session);
    if (project.status !== "archived")
      throw new ApiError(409, "Archive this project before deleting it.");
    const result = await Project.deleteOne({
      _id: projectId,
      revision,
      boardVersion,
    }).session(session);
    if (!result.deletedCount)
      throw new ApiError(
        409,
        "This project changed. Reload before deleting it.",
      );
    await (
      await import("./collaboration-data.ts")
    ).cleanupCollaboration(projectId, session);
    await (
      await import("./planning-data.ts")
    ).cleanupPlanning(projectId, session);
    await Task.deleteMany({ projectId }).session(session);
    await workEvent(
      actor,
      "project.deleted",
      `deleted ${project.name} and its tasks`,
      projectId,
      session,
      { name: project.name, key: project.key },
    );
  });
}
export async function createTask(
  projectId: string,
  actor: Actor,
  values: TaskValues & { parentTaskId: string | null; boardVersion: number },
) {
  assertWriter(actor);
  await mongoose.connection.transaction(async (session) => {
    const project = await requireProject(projectId, actor, session);
    assertActive(project);
    await validateAssignee(values.assigneeId, session);
    if (values.parentTaskId) {
      const parent = await requireTask(projectId, values.parentTaskId, session);
      if (parent.parentTaskId)
        throw new ApiError(
          400,
          "Subtasks can only be added to a top-level task.",
        );
    }
    await lockBoard(projectId, values.boardVersion, session);
    const numbered = await Project.findOneAndUpdate(
      { _id: projectId },
      { $inc: { nextTaskNumber: 1 } },
      { new: true, session },
    );
    const { boardVersion: _, ...taskValues } = values;
    const order = await Task.countDocuments({
      projectId,
      parentTaskId: values.parentTaskId,
      status: values.status,
    }).session(session);
    const [task] = await Task.create(
      [
        {
          ...taskValues,
          workspaceId: actor.workspaceId,
          projectId,
          number: numbered!.nextTaskNumber,
          order,
          createdBy: actor.id,
          completedAt: values.status === "done" ? new Date() : null,
        },
      ],
      { session },
    );
    await (
      await import("./collaboration-data.ts")
    ).notifyAssignment(
      actor,
      projectId,
      String(task._id),
      values.assigneeId,
      null,
      `${project.key}-${task.number}: ${task.title}`,
      session,
    );
    await workEvent(
      actor,
      "task.created",
      `created ${project.key}-${task.number}: ${task.title}`,
      projectId,
      session,
      { taskId: String(task._id), after: publicTask(task) },
    );
  });
  return projectBoard(projectId, actor);
}
async function reorder(
  projectId: string,
  parentTaskId: Types.ObjectId | null,
  status: TaskStatus,
  session: ClientSession,
  excluding?: string,
) {
  const tasks = await Task.find({
    projectId,
    parentTaskId,
    status,
    ...(excluding ? { _id: { $ne: excluding } } : {}),
  })
    .sort({ order: 1, _id: 1 })
    .session(session);
  for (let index = 0; index < tasks.length; index++) {
    if (tasks[index].order !== index)
      await Task.updateOne(
        { _id: tasks[index]._id },
        { $set: { order: index } },
        { session },
      );
  }
}
export async function updateTask(
  projectId: string,
  taskId: string,
  actor: Actor,
  values: TaskValues & { revision: number; boardVersion: number },
) {
  assertWriter(actor);
  await mongoose.connection.transaction(async (session) => {
    const project = await requireProject(projectId, actor, session);
    assertActive(project);
    const task = await requireTask(projectId, taskId, session);
    await validateAssignee(values.assigneeId, session);
    if (task.revision !== values.revision)
      throw new ApiError(
        409,
        "This task was edited by someone else. Reload it before saving your changes.",
      );
    await lockBoard(projectId, values.boardVersion, session);
    const { revision, boardVersion: _, ...changes } = values;
    const moved = task.status !== changes.status;
    const order = moved
      ? await Task.countDocuments({
          projectId,
          parentTaskId: task.parentTaskId,
          status: changes.status,
        }).session(session)
      : task.order;
    const completedAt =
      changes.status === "done" ? (task.completedAt ?? new Date()) : null;
    await Task.updateOne(
      { _id: taskId, revision },
      { $set: { ...changes, order, completedAt }, $inc: { revision: 1 } },
      { session, runValidators: true },
    );
    if (moved)
      await reorder(projectId, task.parentTaskId, task.status, session);
    await (
      await import("./collaboration-data.ts")
    ).notifyAssignment(
      actor,
      projectId,
      taskId,
      changes.assigneeId,
      idString(task.assigneeId),
      `${project.key}-${task.number}: ${changes.title}`,
      session,
    );
    await workEvent(
      actor,
      "task.updated",
      `updated ${project.key}-${task.number}: ${changes.title}`,
      projectId,
      session,
      { taskId, before: publicTask(task), after: { ...changes, completedAt } },
    );
    await (
      await import("./planning-data.ts")
    ).recordSprintProgress(projectId, session);
  });
  return projectBoard(projectId, actor);
}
export async function moveTask(
  projectId: string,
  taskId: string,
  actor: Actor,
  values: { status: TaskStatus; beforeId: string | null; boardVersion: number },
) {
  assertWriter(actor);
  await mongoose.connection.transaction(async (session) => {
    const project = await requireProject(projectId, actor, session);
    assertActive(project);
    const task = await requireTask(projectId, taskId, session);
    if (task.parentTaskId)
      throw new ApiError(
        400,
        "Use the subtask editor to change a subtask status.",
      );
    if (values.beforeId === taskId)
      throw new ApiError(400, "A task cannot be placed before itself.");
    await lockBoard(projectId, values.boardVersion, session);
    const destination = await Task.find({
      projectId,
      parentTaskId: null,
      status: values.status,
      _id: { $ne: taskId },
    })
      .sort({ order: 1, _id: 1 })
      .session(session);
    const targetIndex = values.beforeId
      ? destination.findIndex((item) => String(item._id) === values.beforeId)
      : destination.length;
    if (targetIndex < 0)
      throw new ApiError(
        400,
        "The drop target is no longer in that column. Reload and try again.",
      );
    const completedAt =
      values.status === "done" ? (task.completedAt ?? new Date()) : null;
    destination.splice(targetIndex, 0, task);
    for (let index = 0; index < destination.length; index++) {
      const item = destination[index];
      if (String(item._id) === taskId)
        await Task.updateOne(
          { _id: taskId },
          {
            $set: { status: values.status, order: index, completedAt },
            $inc: { revision: 1 },
          },
          { session },
        );
      else if (item.order !== index)
        await Task.updateOne(
          { _id: item._id },
          { $set: { order: index } },
          { session },
        );
    }
    if (task.status !== values.status)
      await reorder(projectId, null, task.status, session);
    await workEvent(
      actor,
      "task.moved",
      `moved ${project.key}-${task.number} to ${statusNames[values.status]}`,
      projectId,
      session,
      {
        taskId,
        before: { status: task.status, order: task.order },
        after: { status: values.status, order: targetIndex, completedAt },
      },
    );
    await (
      await import("./planning-data.ts")
    ).recordSprintProgress(projectId, session);
  });
  return projectBoard(projectId, actor);
}
export async function deleteTask(
  projectId: string,
  taskId: string,
  actor: Actor,
  revision: number,
  boardVersion: number,
) {
  assertWriter(actor);
  await mongoose.connection.transaction(async (session) => {
    const project = await requireProject(projectId, actor, session);
    assertActive(project);
    const task = await requireTask(projectId, taskId, session);
    if (
      !["owner", "admin"].includes(actor.role) &&
      String(task.createdBy) !== actor.id
    )
      throw new ApiError(
        403,
        "You can only delete tasks you created. Ask a workspace manager for help.",
      );
    if (task.revision !== revision)
      throw new ApiError(409, "This task changed. Reload before deleting it.");
    await lockBoard(projectId, boardVersion, session);
    // Deleting a parent affects all its subtasks: members must own the whole subtree.
    if (
      actor.role === "member" &&
      !task.parentTaskId &&
      (await Task.exists({
        projectId,
        parentTaskId: taskId,
        createdBy: { $ne: actor.id },
      }).session(session))
    )
      throw new ApiError(
        403,
        "This task has subtasks created by teammates. Ask a workspace manager to delete it.",
      );
    const deletedTaskIds = (
      await Task.find({
        projectId,
        $or: [{ _id: taskId }, { parentTaskId: taskId }],
      })
        .select("_id")
        .session(session)
        .lean()
    ).map((item) => String(item._id));
    await (
      await import("./collaboration-data.ts")
    ).cleanupCollaboration(projectId, session, deletedTaskIds);
    await (
      await import("./planning-data.ts")
    ).cleanupTaskTime(projectId, deletedTaskIds, session);
    await Task.deleteMany({
      projectId,
      $or: [{ _id: taskId }, { parentTaskId: taskId }],
    }).session(session);
    await reorder(projectId, task.parentTaskId, task.status, session);
    await workEvent(
      actor,
      "task.deleted",
      `deleted ${project.key}-${task.number}: ${task.title}`,
      projectId,
      session,
      { taskId, before: publicTask(task) },
    );
    await (
      await import("./planning-data.ts")
    ).recordSprintProgress(projectId, session);
  });
  return projectBoard(projectId, actor);
}

export async function visibleActivityProjectIds(userId: string) {
  return (await Project.find({ guestIds: userId }).select("_id").lean()).map(
    (project) => project._id,
  );
}
export async function accessibleProjectIds(
  actor: Actor,
  session?: ClientSession,
) {
  return (
    await Project.find(visibleProjects(actor))
      .select("_id")
      .session(session ?? null)
      .lean()
  ).map((project) => project._id);
}
export async function myTasks(actor: Actor) {
  const projects = await Project.find({
    ...visibleProjects(actor),
    status: "active",
  })
    .sort({ name: 1 })
    .lean();
  const tasks = await Task.find({
    projectId: { $in: projects.map((project) => project._id) },
    assigneeId: actor.id,
  })
    .sort({ createdAt: -1 })
    .lean();
  return {
    projects: projects.map((project) => publicProject(project)),
    tasks: tasks.map(publicTask),
  };
}
export async function accessProject(
  projectId: string,
  actor: Actor,
  session?: ClientSession,
) {
  return requireProject(projectId, actor, session);
}
export async function accessTask(
  projectId: string,
  taskId: string,
  actor: Actor,
  write = false,
  session?: ClientSession,
) {
  if (write) assertWriter(actor);
  const project = await requireProject(projectId, actor, session);
  if (write) assertActive(project);
  checkId(taskId, "Task");
  const task = await Task.findOne({ _id: taskId, projectId }).session(
    session ?? null,
  );
  if (!task) throw new ApiError(404, "Task not found.");
  return { project, task };
}
export async function lockCollaboration(
  projectId: string,
  session: ClientSession,
) {
  const result = await Project.updateOne(
    { _id: projectId, status: "active" },
    { $inc: { collaborationVersion: 1 } },
    { session },
  );
  if (!result.matchedCount)
    throw new ApiError(409, "This project is no longer editable.");
}

// Planning operations keep raw work models private and share the board transaction lock.
export async function planningTasks(
  projectId: string,
  session?: ClientSession,
) {
  return Task.find({ projectId })
    .session(session ?? null)
    .lean();
}
export async function assignPlanningTasks(
  projectId: string,
  ids: string[],
  sprintId: string | null,
  session: ClientSession,
) {
  await Task.updateMany(
    { projectId, _id: { $in: ids }, parentTaskId: null },
    { $set: { sprintId }, $inc: { revision: 1 } },
    { session },
  );
}
