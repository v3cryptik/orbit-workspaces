import mongoose, { Schema, type Types } from "mongoose";
import { createHash } from "node:crypto";
import { runSystem, runWorkspace, tenantGuard } from "./tenant.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Role = "owner" | "admin" | "member" | "guest";
const id = Schema.Types.ObjectId;
const User = mongoose.model(
  "User",
  new Schema(
    {
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      passwordHash: { type: String, required: true, select: false },
    },
    { timestamps: true },
  ),
);
const Session = mongoose.model(
  "Session",
  new Schema({
    userId: { type: id, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  }),
);
const Workspace = mongoose.model(
  "Workspace",
  new Schema(
    {
      name: { type: String, required: true },
      slug: { type: String, required: true, unique: true },
      description: { type: String, default: "" },
      ownerId: { type: id, required: true },
      plan: { type: String, default: "Free" },
    },
    { timestamps: true },
  ),
);
type TenantRecord = {
  workspaceId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
type MembershipRecord = TenantRecord & { userId: Types.ObjectId; role: Role };
type ActivityRecord = TenantRecord & {
  actorId: Types.ObjectId;
  actorName: string;
  action: string;
  detail: string;
  projectId?: Types.ObjectId;
  meta?: Record<string, unknown>;
};
type InvitationRecord = TenantRecord & {
  email: string;
  role: Exclude<Role, "owner">;
  invitedBy: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  revokedAt?: Date;
};
function tenantModel<T extends TenantRecord>(
  name: string,
  fields: Record<string, any>,
  indexes: { fields: any; options?: any }[] = [],
) {
  const schema = new Schema<T>(
    {
      workspaceId: { type: id, required: true, index: true },
      ...fields,
    } as any,
    { timestamps: true },
  );
  indexes.forEach((index) => schema.index(index.fields, index.options));
  schema.plugin(tenantGuard);
  return mongoose.model<T>(name, schema);
}
const Membership = tenantModel<MembershipRecord>(
  "Membership",
  {
    userId: { type: id, required: true },
    role: {
      type: String,
      enum: ["owner", "admin", "member", "guest"],
      required: true,
    },
  },
  [{ fields: { workspaceId: 1, userId: 1 }, options: { unique: true } }],
);
const Activity = tenantModel<ActivityRecord>(
  "Activity",
  {
    actorId: { type: id, required: true },
    actorName: { type: String, required: true },
    action: { type: String, required: true },
    detail: { type: String, required: true },
    projectId: { type: id, index: true },
    meta: { type: Schema.Types.Mixed },
  },
  [{ fields: { workspaceId: 1, createdAt: -1 } }],
);
const Invitation = tenantModel<InvitationRecord>("Invitation", {
  email: { type: String, required: true },
  role: { type: String, enum: ["admin", "member", "guest"], required: true },
  invitedBy: { type: id, required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt: Date,
  revokedAt: Date,
});
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const publicUser = (user: any) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
});
const publicWorkspace = (workspace: any, role: string) => ({
  id: String(workspace._id),
  name: workspace.name,
  slug: workspace.slug,
  description: workspace.description,
  plan: workspace.plan,
  createdAt: workspace.createdAt,
  role,
});
export async function initializeModels() {
  await Promise.all(
    [User, Session, Workspace, Membership, Activity, Invitation].map((model) =>
      model.init(),
    ),
  );
  await (await import("./work-data.ts")).initializeWorkModels();
  await (
    await import("./collaboration-data.ts")
  ).initializeCollaborationModels();
  await (await import("./mail.ts")).initializeMailModel();
  await (await import("./planning-data.ts")).initializePlanningModels();
  await (await import("./storage.ts")).initializeStorageModel();
}
export async function findUser(email: string) {
  return User.findOne({ email }).select("+passwordHash");
}
export async function createUser(
  name: string,
  email: string,
  passwordHash: string,
) {
  return User.create({ name, email, passwordHash });
}
export async function userById(userId: string) {
  return User.findById(userId);
}
export async function createSession(userId: string) {
  return Session.create({
    userId,
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });
}
export async function validSession(sessionId: string, userId: string) {
  return Session.exists({
    _id: sessionId,
    userId,
    expiresAt: { $gt: new Date() },
  });
}
export async function removeSession(sessionId: string) {
  await Session.deleteOne({ _id: sessionId });
}
export async function listWorkspaces(userId: string) {
  const memberships = await runSystem(() => Membership.find({ userId }).lean());
  const workspaces = await Workspace.find({
    _id: { $in: memberships.map((m) => m.workspaceId) },
  })
    .sort({ createdAt: 1 })
    .lean();
  return workspaces.map((workspace) =>
    publicWorkspace(
      workspace,
      memberships.find((m) => String(m.workspaceId) === String(workspace._id))!
        .role,
    ),
  );
}
export async function accessWorkspace(workspaceId: string, userId: string) {
  if (!mongoose.isValidObjectId(workspaceId))
    throw new ApiError(404, "Workspace not found.");
  const member = await runSystem(() =>
    Membership.findOne({ workspaceId, userId }).lean(),
  );
  if (!member) throw new ApiError(404, "Workspace not found.");
  const workspace = await Workspace.findById(workspaceId).lean();
  if (!workspace) throw new ApiError(404, "Workspace not found.");
  return { workspace: publicWorkspace(workspace, member.role), member };
}
export async function logActivity(
  actor: { id: string; name: string },
  action: string,
  detail: string,
  workspaceId: string,
  session?: mongoose.ClientSession,
  context?: { projectId: string; meta: Record<string, unknown> },
) {
  await Activity.create(
    [
      {
        workspaceId,
        actorId: actor.id,
        actorName: actor.name,
        action,
        detail,
        ...context,
      },
    ],
    { session },
  );
}
export async function createWorkspace(
  actor: { id: string; name: string },
  name: string,
  slug: string,
  description: string,
) {
  const workspaceId = new mongoose.Types.ObjectId();
  await mongoose.connection.transaction(async (session) => {
    await Workspace.create(
      [{ _id: workspaceId, ownerId: actor.id, name, slug, description }],
      { session },
    );
    await runWorkspace(String(workspaceId), async () => {
      await Membership.create(
        [{ workspaceId, userId: actor.id, role: "owner" }],
        { session },
      );
      await logActivity(
        actor,
        "workspace.created",
        "created this workspace",
        String(workspaceId),
        session,
      );
    });
  });
  return (await accessWorkspace(String(workspaceId), actor.id)).workspace;
}
export async function workspaceMembers() {
  const members = await Membership.find().sort({ createdAt: 1 }).lean();
  const users = await User.find({
    _id: { $in: members.map((member) => member.userId) },
  }).lean();
  return members.map((member) => ({
    id: String(member._id),
    role: member.role as Role,
    joinedAt: member.createdAt,
    user: publicUser(
      users.find((user) => String(user._id) === String(member.userId)),
    ),
  }));
}
export async function activities(actor?: { id: string; role: string }) {
  const filter =
    actor?.role === "guest"
      ? {
          $or: [
            { projectId: { $exists: false } },
            {
              projectId: {
                $in: await (
                  await import("./work-data.ts")
                ).visibleActivityProjectIds(actor.id),
              },
            },
          ],
        }
      : {};
  const timePrivacy =
    actor?.role === "guest"
      ? { action: { $not: /^time\./ } }
      : actor?.role === "member"
        ? { $or: [{ action: { $not: /^time\./ } }, { actorId: actor.id }] }
        : {};
  return Activity.find({ $and: [filter, timePrivacy] })
    .sort({ createdAt: -1, _id: -1 })
    .limit(50)
    .select("-workspaceId -__v")
    .lean();
}
export async function membershipFor(
  userId: string,
  session?: mongoose.ClientSession,
) {
  if (!/^[a-f\d]{24}$/i.test(userId)) return null;
  return Membership.findOne({ userId })
    .session(session ?? null)
    .lean();
}
export async function invites() {
  return Invitation.find({
    usedAt: null,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .select("email role expiresAt createdAt")
    .lean();
}
export async function updateWorkspace(
  workspaceId: string,
  actor: { id: string; name: string },
  values: { name: string; description: string },
) {
  await mongoose.connection.transaction(async (session) => {
    await Workspace.updateOne(
      { _id: workspaceId },
      { $set: values },
      { session, runValidators: true },
    );
    await logActivity(
      actor,
      "workspace.updated",
      "updated workspace details",
      workspaceId,
      session,
    );
  });
}
export async function changeMember(
  workspaceId: string,
  actor: { id: string; name: string },
  actorRole: Role,
  memberId: string,
  newRole: Role | null,
) {
  if (!mongoose.isValidObjectId(memberId))
    throw new ApiError(404, "Member not found.");
  await mongoose.connection.transaction(async (session) => {
    const member = await Membership.findById(memberId).session(session);
    if (!member) throw new ApiError(404, "Member not found.");
    if (member.role === "owner")
      throw new ApiError(
        403,
        "The workspace owner cannot be removed or demoted.",
      );
    if (
      actorRole !== "owner" &&
      (member.role === "admin" || newRole === "admin")
    )
      throw new ApiError(403, "Only the owner can manage admins.");
    if (String(member.userId) === actor.id)
      throw new ApiError(
        403,
        "Ask another workspace manager to change your access.",
      );
    const user = await User.findById(member.userId).session(session);
    if (newRole)
      await Membership.updateOne(
        { _id: memberId },
        { $set: { role: newRole } },
        { session, runValidators: true },
      );
    else await Membership.deleteOne({ _id: memberId }, { session });
    await logActivity(
      actor,
      newRole ? "member.role_changed" : "member.removed",
      newRole
        ? `changed ${user?.name}'s role to ${newRole}`
        : `removed ${user?.name} from the workspace`,
      workspaceId,
      session,
    );
  });
}
export async function createInvite(
  workspaceId: string,
  actor: { id: string; name: string },
  email: string,
  role: Role,
  token: string,
  expiresAt: Date,
  mailPayload?: string,
) {
  const existingUser = await User.findOne({ email });
  if (existingUser && (await Membership.exists({ userId: existingUser._id })))
    throw new ApiError(409, "This person is already a workspace member.");
  await mongoose.connection.transaction(async (session) => {
    await Invitation.updateMany(
      { email, usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    const [invitation] = await Invitation.create(
      [
        {
          workspaceId,
          email,
          role,
          invitedBy: actor.id,
          tokenHash: tokenHash(token),
          expiresAt,
        },
      ],
      { session },
    );
    if (mailPayload)
      await (
        await import("./mail.ts")
      ).queueInvitationMail(
        workspaceId,
        String(invitation._id),
        email,
        role,
        mailPayload,
        expiresAt,
        session,
      );
    await logActivity(
      actor,
      "member.invited",
      `invited ${email} as ${role}`,
      workspaceId,
      session,
    );
  });
}
export async function revokeInvite(
  workspaceId: string,
  actor: { id: string; name: string },
  actorRole: Role,
  invitationId: string,
) {
  if (!mongoose.isValidObjectId(invitationId))
    throw new ApiError(404, "Invitation not found.");
  await mongoose.connection.transaction(async (session) => {
    const invite = await Invitation.findOne({
      _id: invitationId,
      usedAt: null,
      revokedAt: null,
    }).session(session);
    if (!invite) throw new ApiError(404, "Invitation not found.");
    if (invite.role === "admin" && actorRole !== "owner")
      throw new ApiError(403, "Only the owner can manage admin invitations.");
    await Invitation.updateOne(
      { _id: invite._id },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await logActivity(
      actor,
      "invitation.revoked",
      `revoked the invitation for ${invite.email}`,
      workspaceId,
      session,
    );
  });
}
export async function acceptInvite(
  workspaceId: string,
  actor: { id: string; name: string; email: string },
  token: string,
) {
  return runWorkspace(workspaceId, async () => {
    await mongoose.connection.transaction(async (session) => {
      const invitation = await Invitation.findOneAndUpdate(
        {
          tokenHash: tokenHash(token),
          email: actor.email,
          usedAt: null,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        },
        { $set: { usedAt: new Date() } },
        { new: true, session },
      );
      if (!invitation)
        throw new ApiError(
          400,
          "This invitation is expired, already used, revoked, or belongs to another email.",
        );
      if (await Membership.exists({ userId: actor.id }).session(session))
        throw new ApiError(409, "You are already a member of this workspace.");
      await Membership.create(
        [{ workspaceId, userId: actor.id, role: invitation.role }],
        { session },
      );
      await logActivity(
        actor,
        "member.joined",
        "joined the workspace",
        workspaceId,
        session,
      );
    });
    return (await accessWorkspace(workspaceId, actor.id)).workspace;
  });
}
export async function invitationPending(invitationId: string) {
  return !!(await Invitation.exists({
    _id: invitationId,
    usedAt: null,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }));
}
