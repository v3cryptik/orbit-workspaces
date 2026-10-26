import mongoose, { Schema, type ClientSession } from "mongoose";
import { randomUUID } from "node:crypto";
import {
  ApiError,
  logActivity,
  membershipFor,
  workspaceMembers,
} from "./data.ts";
import { tenantGuard, runSystem } from "./tenant.ts";
import { accessTask, accessibleProjectIds, type Actor } from "./work-data.ts";
import type { ObjectStore } from "./storage.ts";
import { validateFile } from "./storage.ts";
const id = Schema.Types.ObjectId;
function model(
  name: string,
  fields: Record<string, any>,
  indexes: Record<string, any>[] = [],
) {
  const schema = new Schema<any>(
    { workspaceId: { type: id, required: true, index: true }, ...fields },
    { timestamps: true },
  );
  schema.plugin(tenantGuard);
  indexes.forEach((index) => schema.index(index));
  return mongoose.model<any>(name, schema);
}
const Comment = model(
  "Comment",
  {
    projectId: { type: id, required: true },
    taskId: { type: id, required: true },
    body: { type: String, required: true },
    mentionIds: [String],
    authorId: { type: id, required: true },
    authorName: String,
    revision: { type: Number, default: 0 },
  },
  [{ workspaceId: 1, taskId: 1, createdAt: 1 }],
);
const Attachment = model(
  "Attachment",
  {
    projectId: { type: id, required: true },
    taskId: { type: id, required: true },
    objectKey: { type: String, required: true },
    filename: String,
    size: Number,
    uploadedBy: { type: id, required: true },
    uploaderName: String,
  },
  [{ workspaceId: 1, taskId: 1 }],
);
const Notification = model(
  "Notification",
  {
    userId: { type: id, required: true },
    projectId: { type: id, required: true },
    taskId: { type: id, required: true },
    kind: { type: String, enum: ["mention", "assignment"], required: true },
    actorName: String,
    title: String,
    readAt: { type: Date, default: null },
  },
  [{ workspaceId: 1, userId: 1, createdAt: -1 }],
);
const FileDeletion = model("FileDeletion", {
  objectKey: String,
  attempts: { type: Number, default: 0 },
  nextAt: { type: Date, default: Date.now },
});
export async function initializeCollaborationModels() {
  await Promise.all(
    [Comment, Attachment, Notification, FileDeletion].map((model) =>
      model.init(),
    ),
  );
}
function validId(value: string) {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new ApiError(404, "Item not found.");
}
const publicComment = (value: any) => ({
  id: String(value._id),
  body: value.body,
  mentionIds: value.mentionIds,
  authorId: String(value.authorId),
  authorName: value.authorName,
  revision: value.revision,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
});
const publicAttachment = (value: any) => ({
  id: String(value._id),
  filename: value.filename,
  size: value.size,
  uploadedBy: String(value.uploadedBy),
  uploaderName: value.uploaderName,
  createdAt: value.createdAt,
});
async function event(
  actor: Actor,
  projectId: string,
  taskId: string,
  action: string,
  detail: string,
  session: ClientSession,
) {
  await logActivity(actor, action, detail, actor.workspaceId, session, {
    projectId,
    meta: { taskId },
  });
}
export async function taskCollaboration(
  actor: Actor,
  projectId: string,
  taskId: string,
) {
  await accessTask(projectId, taskId, actor);
  const comments = await Comment.find({ projectId, taskId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(100)
    .lean();
  const attachments = await Attachment.find({ projectId, taskId })
    .sort({ createdAt: -1 })
    .lean();
  return {
    comments: comments.reverse().map(publicComment),
    attachments: attachments.map(publicAttachment),
  };
}
async function validateMentions(
  actor: Actor,
  projectId: string,
  body: string,
  mentionIds: string[],
  session: ClientSession,
) {
  const members = await workspaceMembers();
  for (const userId of mentionIds) {
    const member = members.find((member) => member.user.id === userId);
    if (!member || !body.includes(`@${member.user.name}`))
      throw new ApiError(
        400,
        "Choose current teammates from the mention menu.",
      );
    if (
      !(
        await accessibleProjectIds(
          { ...actor, id: userId, role: member.role },
          session,
        )
      ).some((id) => String(id) === projectId)
    )
      throw new ApiError(
        400,
        "A mentioned teammate must have access to this project.",
      );
  }
}
export async function comment(
  actor: Actor,
  projectId: string,
  taskId: string,
  values: { body: string; mentionIds: string[] },
  edit?: { id: string; revision: number },
) {
  await mongoose.connection.transaction(async (session) => {
    const { project, task } = await accessTask(
      projectId,
      taskId,
      actor,
      true,
      session,
    );
    await (
      await import("./work-data.ts")
    ).lockCollaboration(projectId, session);
    await validateMentions(
      actor,
      projectId,
      values.body,
      values.mentionIds,
      session,
    );
    let oldMentions: string[] = [];
    if (edit) {
      validId(edit.id);
      const existing = await Comment.findOne({
        _id: edit.id,
        projectId,
        taskId,
      }).session(session);
      if (!existing) throw new ApiError(404, "Comment not found.");
      if (String(existing.authorId) !== actor.id)
        throw new ApiError(403, "You can edit only your own comments.");
      if (existing.revision !== edit.revision)
        throw new ApiError(
          409,
          "This comment changed. Reload it before saving your draft.",
        );
      oldMentions = existing.mentionIds;
      await Comment.updateOne(
        { _id: edit.id, revision: edit.revision },
        { $set: values, $inc: { revision: 1 } },
        { session },
      );
    } else
      await Comment.create(
        [
          {
            ...values,
            workspaceId: actor.workspaceId,
            projectId,
            taskId,
            authorId: actor.id,
            authorName: actor.name,
          },
        ],
        { session },
      );
    for (const userId of values.mentionIds.filter(
      (userId) => userId !== actor.id && !oldMentions.includes(userId),
    ))
      await Notification.create(
        [
          {
            workspaceId: actor.workspaceId,
            projectId,
            taskId,
            userId,
            kind: "mention",
            actorName: actor.name,
            title: `${project.key}-${task.number}: ${task.title}`,
          },
        ],
        { session },
      );
    await event(
      actor,
      projectId,
      taskId,
      edit ? "comment.updated" : "comment.created",
      `${edit ? "edited a comment on" : "commented on"} ${project.key}-${task.number}`,
      session,
    );
  });
  return taskCollaboration(actor, projectId, taskId);
}
export async function deleteComment(
  actor: Actor,
  projectId: string,
  taskId: string,
  commentId: string,
  revision: number,
) {
  validId(commentId);
  await mongoose.connection.transaction(async (session) => {
    const { project, task } = await accessTask(
      projectId,
      taskId,
      actor,
      true,
      session,
    );
    await (
      await import("./work-data.ts")
    ).lockCollaboration(projectId, session);
    const existing = await Comment.findOne({
      _id: commentId,
      projectId,
      taskId,
    }).session(session);
    if (!existing) throw new ApiError(404, "Comment not found.");
    if (
      String(existing.authorId) !== actor.id &&
      !["owner", "admin"].includes(actor.role)
    )
      throw new ApiError(
        403,
        "Only the author or a workspace manager can remove this comment.",
      );
    if (existing.revision !== revision)
      throw new ApiError(
        409,
        "This comment changed. Reload before removing it.",
      );
    await Comment.deleteOne({ _id: commentId }).session(session);
    await event(
      actor,
      projectId,
      taskId,
      "comment.deleted",
      `removed a comment from ${project.key}-${task.number}`,
      session,
    );
  });
  return taskCollaboration(actor, projectId, taskId);
}
export async function notifyAssignment(
  actor: Actor,
  projectId: string,
  taskId: string,
  assigneeId: string | null,
  previous: string | null,
  title: string,
  session: ClientSession,
) {
  if (assigneeId && assigneeId !== previous && assigneeId !== actor.id)
    await Notification.create(
      [
        {
          workspaceId: actor.workspaceId,
          projectId,
          taskId,
          userId: assigneeId,
          kind: "assignment",
          actorName: actor.name,
          title,
        },
      ],
      { session },
    );
}
export async function inbox(actor: Actor) {
  const projectIds = await accessibleProjectIds(actor);
  const filter = { userId: actor.id, projectId: { $in: projectIds } };
  const records = await Notification.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(100)
    .lean();
  const unread = await Notification.countDocuments({ ...filter, readAt: null });
  return {
    unread,
    notifications: records.map((value) => ({
      id: String(value._id),
      projectId: String(value.projectId),
      taskId: String(value.taskId),
      kind: value.kind,
      actorName: value.actorName,
      title: value.title,
      readAt: value.readAt,
      createdAt: value.createdAt,
    })),
  };
}
export async function readNotifications(actor: Actor, notificationId?: string) {
  if (notificationId) validId(notificationId);
  const projectIds = await accessibleProjectIds(actor);
  const result = await Notification.updateMany(
    {
      userId: actor.id,
      projectId: { $in: projectIds },
      ...(notificationId ? { _id: notificationId } : {}),
    },
    { $set: { readAt: new Date() } },
  );
  if (notificationId && !result.matchedCount)
    throw new ApiError(404, "Notification not found.");
  return inbox(actor);
}
export async function addAttachment(
  actor: Actor,
  projectId: string,
  taskId: string,
  original: string,
  bytes: Buffer,
  store: ObjectStore,
) {
  await accessTask(projectId, taskId, actor, true);
  const filename = validateFile(original, bytes);
  const objectKey = `${actor.workspaceId}/${randomUUID()}`;
  await store.put(objectKey, bytes);
  try {
    await mongoose.connection.transaction(async (session) => {
      const { project, task } = await accessTask(
        projectId,
        taskId,
        actor,
        true,
        session,
      );
      // Take the same project write lock as task deletion/archive to serialize cleanup races.
      await (
        await import("./work-data.ts")
      ).lockCollaboration(projectId, session);
      if (
        (await Attachment.countDocuments({ projectId, taskId }).session(
          session,
        )) >= 20
      )
        throw new ApiError(400, "A task can have at most 20 attachments.");
      await Attachment.create(
        [
          {
            workspaceId: actor.workspaceId,
            projectId,
            taskId,
            objectKey,
            filename,
            size: bytes.length,
            uploadedBy: actor.id,
            uploaderName: actor.name,
          },
        ],
        { session },
      );
      await event(
        actor,
        projectId,
        taskId,
        "attachment.added",
        `attached ${filename} to ${project.key}-${task.number}`,
        session,
      );
    });
  } catch (error) {
    await store.remove(objectKey).catch(() => {});
    throw error;
  }
  return taskCollaboration(actor, projectId, taskId);
}
export async function attachment(
  actor: Actor,
  projectId: string,
  taskId: string,
  attachmentId: string,
) {
  validId(attachmentId);
  await accessTask(projectId, taskId, actor);
  const file = await Attachment.findOne({
    _id: attachmentId,
    projectId,
    taskId,
  }).lean<{ objectKey: string; filename: string }>();
  if (!file) throw new ApiError(404, "Attachment not found.");
  return file;
}
export async function deleteAttachment(
  actor: Actor,
  projectId: string,
  taskId: string,
  attachmentId: string,
) {
  await mongoose.connection.transaction(async (session) => {
    await accessTask(projectId, taskId, actor, true, session);
    await (
      await import("./work-data.ts")
    ).lockCollaboration(projectId, session);
    validId(attachmentId);
    const file = await Attachment.findOne({
      _id: attachmentId,
      projectId,
      taskId,
    }).session(session);
    if (!file) throw new ApiError(404, "Attachment not found.");
    if (
      String(file.uploadedBy) !== actor.id &&
      !["owner", "admin"].includes(actor.role)
    )
      throw new ApiError(
        403,
        "Only the uploader or a workspace manager can remove this file.",
      );
    await FileDeletion.create(
      [{ workspaceId: actor.workspaceId, objectKey: file.objectKey }],
      { session },
    );
    await Attachment.deleteOne({ _id: attachmentId }).session(session);
    await event(
      actor,
      projectId,
      taskId,
      "attachment.deleted",
      `removed ${file.filename}`,
      session,
    );
  });
  return taskCollaboration(actor, projectId, taskId);
}
export async function cleanupCollaboration(
  projectId: string,
  session: ClientSession,
  taskIds?: string[],
) {
  const filter = {
    projectId,
    ...(taskIds ? { taskId: { $in: taskIds } } : {}),
  };
  for (const file of await Attachment.find(filter).session(session).lean())
    await FileDeletion.create(
      [{ workspaceId: file.workspaceId, objectKey: file.objectKey }],
      { session },
    );
  await Attachment.deleteMany(filter).session(session);
  await Comment.deleteMany(filter).session(session);
  await Notification.deleteMany(filter).session(session);
}
export async function cleanFiles(store: ObjectStore) {
  // Internal maintenance is the only global access to this tenant-owned deletion queue.
  const records = await runSystem(() =>
    FileDeletion.find({ nextAt: { $lte: new Date() } })
      .limit(20)
      .lean(),
  );
  for (const record of records) {
    try {
      await store.remove(record.objectKey);
      await runSystem(() => FileDeletion.deleteOne({ _id: record._id }));
    } catch {
      await runSystem(() =>
        FileDeletion.updateOne(
          { _id: record._id },
          {
            $inc: { attempts: 1 },
            $set: { nextAt: new Date(Date.now() + 60000) },
          },
        ),
      );
    }
  }
}
