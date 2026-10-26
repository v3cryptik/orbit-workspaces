import mongoose, { Schema, type ClientSession } from "mongoose";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { tenantGuard, runSystem, runWorkspace } from "./tenant.ts";
import { ApiError, invitationPending } from "./data.ts";
import type { Actor } from "./work-data.ts";
const schema = new Schema<any>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },
    invitationId: { type: Schema.Types.ObjectId, required: true },
    email: String,
    role: String,
    encrypted: String,
    status: { type: String, default: "queued" },
    attempts: { type: Number, default: 0 },
    nextAt: { type: Date, default: Date.now },
    leaseUntil: Date,
    sentAt: Date,
    expiresAt: { type: Date, expires: 0 },
  },
  { timestamps: true },
);
schema.plugin(tenantGuard);
schema.index({ workspaceId: 1, createdAt: -1 });
const Email = mongoose.model<any>("InvitationEmail", schema);
export async function initializeMailModel() {
  await Email.init();
}
export async function queueInvitationMail(
  workspaceId: string,
  invitationId: string,
  email: string,
  role: string,
  encrypted: string,
  expiresAt: Date,
  session: ClientSession,
) {
  await Email.create(
    [{ workspaceId, invitationId, email, role, encrypted, expiresAt }],
    { session },
  );
}
type Envelope = { subject: string; text: string; url: string };
export class MailService {
  readonly mode: "local" | "smtp";
  private key: Buffer;
  private transport?: Transporter<any>;
  private from: string;
  constructor(
    secret: string,
    options: {
      production?: boolean;
      testing?: boolean;
      transport?: Transporter;
      from?: string;
    } = {},
  ) {
    this.key = createHash("sha256").update(`orbit-mail:${secret}`).digest();
    this.from =
      options.from ?? process.env.SMTP_FROM ?? "Orbit <orbit@localhost>";
    this.mode =
      options.transport || (!options.testing && process.env.SMTP_HOST)
        ? "smtp"
        : "local";
    if (options.production && this.mode !== "smtp")
      throw new Error(
        "Production invitation delivery requires SMTP_HOST and SMTP_FROM.",
      );
    if (options.production && !options.from && !process.env.SMTP_FROM)
      throw new Error("Production invitation delivery requires SMTP_FROM.");
    this.transport =
      options.transport ??
      (this.mode === "smtp"
        ? nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT ?? 587),
            secure: process.env.SMTP_SECURE === "true",
            requireTLS: process.env.SMTP_SECURE !== "true",
            auth: process.env.SMTP_USER
              ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
              : undefined,
            connectionTimeout: 10000,
            socketTimeout: 15000,
          })
        : undefined);
  }
  encrypt(value: Envelope) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((value) => value.toString("base64url"))
      .join(".");
  }
  private decrypt(encrypted: string): Envelope {
    const [iv, tag, bytes] = encrypted
      .split(".")
      .map((value) => Buffer.from(value, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(bytes), decipher.final()]).toString(),
    );
  }
  invitation(workspace: string, actor: string, role: string, url: string) {
    const subject = `You're invited to ${workspace.replace(/[\r\n]/g, " ")}`;
    return this.encrypt({
      subject,
      url,
      text: `${actor} invited you to ${workspace} as ${role}.\n\nAccept your invitation:\n${url}\n\nSign in with the invited email address. This link expires in 48 hours and works once.\n\nOrbit Workspaces`,
    });
  }
  async list(actor: Actor) {
    if (!["owner", "admin"].includes(actor.role))
      throw new ApiError(
        403,
        "Only workspace managers can view invitation delivery.",
      );
    const records = await Email.find(
      actor.role === "owner" ? {} : { role: { $ne: "admin" } },
    )
      .sort({ createdAt: -1 })
      .limit(50)
      .select("-encrypted")
      .lean();
    return {
      mode: this.mode,
      deliveries: records.map((value) => ({
        id: String(value._id),
        email: value.email,
        status: value.status,
        attempts: value.attempts,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        canPreview: this.mode === "local",
      })),
    };
  }
  async job(actor: Actor, id: string) {
    if (!["owner", "admin"].includes(actor.role))
      throw new ApiError(
        403,
        "Only workspace managers can view invitation delivery.",
      );
    if (!/^[a-f\d]{24}$/i.test(id))
      throw new ApiError(404, "Delivery not found.");
    const record = await Email.findOne({
      _id: id,
      ...(actor.role === "owner" ? {} : { role: { $ne: "admin" } }),
    });
    if (!record) throw new ApiError(404, "Delivery not found.");
    return record;
  }
  async preview(actor: Actor, id: string) {
    if (this.mode !== "local")
      throw new ApiError(404, "Local mail preview is unavailable.");
    return this.decrypt((await this.job(actor, id)).encrypted);
  }
  async retry(actor: Actor, id: string) {
    const job = await this.job(actor, id);
    if (!(await invitationPending(String(job.invitationId))))
      throw new ApiError(
        409,
        "This invitation is no longer active. Create a new invitation.",
      );
    const result = await Email.updateOne(
      { _id: id, status: { $in: ["failed", "local", "cancelled"] } },
      {
        $set: { status: "queued", attempts: 0, nextAt: new Date() },
        $unset: { leaseUntil: 1 },
      },
    );
    if (!result.modifiedCount)
      throw new ApiError(
        409,
        "This delivery is already queued, sending, or sent.",
      );
  }
  async process(
    changed: (workspaceId: string) => Promise<void> = async () => {},
  ) {
    for (let index = 0; index < 10; index++) {
      const now = new Date();
      const job = await runSystem(() =>
        Email.findOneAndUpdate(
          {
            attempts: { $lt: 5 },
            nextAt: { $lte: now },
            $or: [
              { status: { $in: ["queued", "failed"] } },
              { status: "sending", leaseUntil: { $lt: now } },
            ],
          },
          {
            $set: {
              status: "sending",
              leaseUntil: new Date(Date.now() + 60000),
            },
            $inc: { attempts: 1 },
          },
          { new: true },
        ),
      );
      if (!job) break;
      await runWorkspace(String(job.workspaceId), async () => {
        try {
          if (!(await invitationPending(String(job.invitationId)))) {
            await Email.updateOne(
              { _id: job._id },
              { $set: { status: "cancelled" } },
            );
            return;
          }
          if (this.mode === "smtp") {
            const envelope = this.decrypt(job.encrypted);
            const result = await this.transport!.sendMail({
              from: this.from,
              to: job.email,
              subject: envelope.subject,
              text: envelope.text,
            });
            if (!result.accepted?.length)
              throw new Error("Recipient not accepted");
          }
          await Email.updateOne(
            { _id: job._id },
            {
              $set: {
                status: this.mode === "local" ? "local" : "sent",
                sentAt: new Date(),
              },
              $unset: { leaseUntil: 1 },
            },
          );
        } catch {
          await Email.updateOne(
            { _id: job._id },
            {
              $set: {
                status: "failed",
                nextAt: new Date(
                  Date.now() + 30000 * 2 ** Math.min(job.attempts, 5),
                ),
              },
              $unset: { leaseUntil: 1 },
            },
          );
        }
      });
      await changed(String(job.workspaceId));
    }
  }
}
