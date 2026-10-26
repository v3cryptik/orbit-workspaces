import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { once } from "node:events";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import { io, type Socket } from "socket.io-client";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import { createApp, apiErrorHandler } from "../app.ts";
import { initializeModels } from "../data.ts";
import { attachRealtime } from "../realtime.ts";
import { MailService } from "../mail.ts";
import { cleanFiles } from "../collaboration-data.ts";
import { runWorkspace } from "../tenant.ts";
import { LocalStore, S3Store, type ObjectStore } from "../storage.ts";
import type { BoardSnapshot } from "../../shared/work.ts";

class MemoryStore implements ObjectStore {
  values = new Map<string, Buffer>();
  async put(key: string, value: Buffer) {
    this.values.set(key, value);
  }
  async get(key: string) {
    const value = this.values.get(key);
    if (!value) throw new Error("Not found");
    return value;
  }
  async remove(key: string) {
    this.values.delete(key);
  }
}
const secret = randomBytes(48).toString("hex");
const store = new MemoryStore();
const mail = new MailService(secret, { testing: true });
const app = createApp({
  secret,
  origin: "http://localhost:4173",
  testing: true,
  services: { store, mail },
});
app.use(apiErrorHandler);
const server = createServer(app);
let live: Awaited<ReturnType<typeof attachRealtime>>;
let database: MongoMemoryReplSet;
let base: string;
type Account = {
  agent: ReturnType<typeof supertest.agent>;
  id: string;
  email: string;
  name: string;
  cookie: string;
  workspaceId: string;
  token: string;
};
let owner: Account, teammate: Account, guest: Account, foreign: Account;
let snapshot: BoardSnapshot;
let projectId: string;
let taskId: string;
const sockets: Socket[] = [];
const mark = (request: supertest.Test) => request.set("x-orbit-request", "1");
function call(
  user: Account,
  method: "get" | "post" | "patch" | "delete",
  path: string,
) {
  return mark(user.agent[method](`/api/w/${user.workspaceId}${path}`)).set(
    "x-workspace-token",
    user.token,
  );
}
async function account(name: string): Promise<Account> {
  const agent = supertest.agent(app);
  const email = `${name.toLowerCase()}@example.test`;
  const result = await mark(agent.post("/api/auth/register"))
    .send({ name, email, password: randomBytes(24).toString("hex") })
    .expect(201);
  return {
    agent,
    id: result.body.user.id,
    email,
    name,
    cookie: result.headers["set-cookie"][0].split(";")[0],
    workspaceId: "",
    token: "",
  };
}
async function scope(user: Account, workspaceId: string) {
  user.workspaceId = workspaceId;
  user.token = (
    await mark(
      user.agent.post(`/api/workspaces/${workspaceId}/session`),
    ).expect(200)
  ).body.token;
}
async function invite(email: string, role = "member") {
  const result = await call(owner, "post", "/invites")
    .send({ email, role })
    .expect(201);
  return new URL(result.body.url).searchParams.get("invite")!;
}
async function join(user: Account, role = "member") {
  const token = await invite(user.email, role);
  await mark(user.agent.post("/api/invites/accept"))
    .send({ token })
    .expect(200);
  await scope(user, owner.workspaceId);
}
async function board() {
  return (await call(owner, "get", `/projects/${projectId}/board`).expect(200))
    .body as BoardSnapshot;
}
const taskPath = () => `/projects/${projectId}/tasks/${taskId}`;
async function connected(user: Account, extra: Record<string, unknown> = {}) {
  const socket = io(base, {
    path: "/api/socket.io",
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { origin: "http://localhost:4173", cookie: user.cookie },
    auth: { token: user.token },
    ...extra,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Socket connection timeout")),
      3000,
    );
    const success = () => finish();
    const failed = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("connect", success);
      socket.off("connect_error", failed);
      error ? reject(error) : resolve();
    };
    socket.once("connect", success);
    socket.once("connect_error", failed);
  });
  return socket;
}
function event(socket: Socket, name: string) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, listener);
      reject(new Error(`Missing ${name}`));
    }, 3000);
    const listener = (value: unknown) => {
      clearTimeout(timeout);
      resolve(value);
    };
    socket.once(name, listener);
  });
}
before(
  async () => {
    process.env.MONGOMS_DOWNLOAD_DIR = resolve(".local/mongodb-binaries");
    database = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(database.getUri("orbit-collaboration-tests"));
    await initializeModels();
    live = await attachRealtime(server, {
      secret,
      origin: "http://localhost:4173",
    });
    app.locals.live = live;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    owner = await account("Owner");
    teammate = await account("Teammate");
    guest = await account("Guest");
    foreign = await account("Foreign");
    const ws = (
      await mark(owner.agent.post("/api/workspaces"))
        .send({ name: "Collaboration", slug: "collaboration" })
        .expect(201)
    ).body.workspace;
    await scope(owner, ws.id);
    await join(teammate);
    await join(guest, "guest");
    const other = (
      await mark(foreign.agent.post("/api/workspaces"))
        .send({ name: "Other team", slug: "other-team" })
        .expect(201)
    ).body.workspace;
    await scope(foreign, other.id);
    snapshot = (
      await call(owner, "post", "/projects")
        .send({ name: "Product release", key: "PROD", guestIds: [guest.id] })
        .expect(201)
    ).body;
    projectId = snapshot.project.id;
    snapshot = (
      await call(owner, "post", `/projects/${projectId}/tasks`)
        .send({
          title: "Build collaboration",
          boardVersion: snapshot.project.boardVersion,
        })
        .expect(201)
    ).body;
    taskId = snapshot.tasks[0].id;
  },
  { timeout: 240000 },
);
after(async () => {
  for (const socket of sockets) socket.disconnect();
  await live?.close();
  await mongoose.disconnect();
  await database?.stop();
});

test("authenticated live connections receive committed task changes in a second client", async () => {
  const socket = await connected(teammate);
  const received = event(socket, "task:moved");
  const current = await board();
  await call(owner, "patch", `${taskPath()}/move`)
    .send({
      status: "in_progress",
      beforeId: null,
      boardVersion: current.project.boardVersion,
    })
    .expect(200);
  assert.deepEqual(await received, { projectId });
  assert.equal(
    (await board()).tasks.find((task) => task.id === taskId)!.status,
    "in_progress",
  );
});
test("socket handshake rejects a missing cookie, swapped workspace token, or foreign origin", async () => {
  for (const extra of [
    { extraHeaders: { origin: "http://localhost:4173" } },
    { auth: { token: foreign.token } },
    {
      extraHeaders: {
        origin: "https://attacker.example",
        cookie: owner.cookie,
      },
    },
  ])
    await assert.rejects(() => connected(owner, extra));
});
test("another tenant cannot subscribe to a private project or receive its change signals", async () => {
  const socket = await connected(foreign);
  assert.deepEqual(
    await socket.timeout(1000).emitWithAck("project:watch", projectId),
    { ok: false },
  );
  let leaked = false;
  socket.on("comment:new", () => {
    leaked = true;
  });
  await call(owner, "post", `${taskPath()}/comments`)
    .send({ body: "Private update." })
    .expect(201);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(leaked, false);
});
test("failed task mutations do not emit a committed task event", async () => {
  const socket = await connected(owner);
  let emitted = false;
  socket.on("task:moved", () => {
    emitted = true;
  });
  await call(owner, "patch", `${taskPath()}/move`)
    .send({ status: "done", beforeId: null, boardVersion: 0 })
    .expect(409);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(emitted, false);
});
test("mentions create private, persistent notifications and live comment signals", async () => {
  const socket = await connected(teammate);
  const received = event(socket, "comment:new");
  const result = await call(owner, "post", `${taskPath()}/comments`)
    .send({
      body: "@Teammate please review the keyboard flow.",
      mentionIds: [teammate.id],
    })
    .expect(201);
  assert.ok(
    result.body.comments.some((comment: any) =>
      comment.body.includes("@Teammate"),
    ),
  );
  assert.deepEqual(await received, { projectId });
  const inbox = await call(teammate, "get", "/notifications").expect(200);
  assert.equal(inbox.body.unread, 1);
  assert.equal(inbox.body.notifications[0].kind, "mention");
  assert.equal(inbox.body.notifications[0].taskId, taskId);
  assert.equal(
    (await call(owner, "get", "/notifications").expect(200)).body.unread,
    0,
  );
});
test("forged, foreign, and unselected mentions fail validation without adding comments", async () => {
  for (const values of [
    { body: "No name included", mentionIds: [teammate.id] },
    { body: "@Foreign", mentionIds: [foreign.id] },
  ])
    await call(owner, "post", `${taskPath()}/comments`)
      .send(values)
      .expect(400);
});
test("guests read shared comments but cannot write comments or read private project comments", async () => {
  await call(guest, "get", `${taskPath()}/collaboration`).expect(200);
  await call(guest, "post", `${taskPath()}/comments`)
    .send({ body: "No guest writing" })
    .expect(403);
  const privateProject = (
    await call(owner, "post", "/projects")
      .send({ name: "Private planning", key: "PRIV" })
      .expect(201)
  ).body;
  await call(
    guest,
    "get",
    `/projects/${privateProject.project.id}/tasks/${taskId}/collaboration`,
  ).expect(404);
});
test("comment edits require ownership and a current revision and avoid duplicate mention notifications", async () => {
  const data = await call(owner, "get", `${taskPath()}/collaboration`).expect(
    200,
  );
  const comment = data.body.comments.find((value: any) =>
    value.mentionIds.includes(teammate.id),
  );
  await call(teammate, "patch", `${taskPath()}/comments/${comment.id}`)
    .send({ body: "Changed by someone else", revision: 0 })
    .expect(403);
  await call(owner, "patch", `${taskPath()}/comments/${comment.id}`)
    .send({
      body: "@Teammate please review the updated flow.",
      mentionIds: [teammate.id],
      revision: 0,
    })
    .expect(200);
  await call(owner, "patch", `${taskPath()}/comments/${comment.id}`)
    .send({ body: "Stale edit", revision: 0 })
    .expect(409);
  assert.equal(
    (
      await call(teammate, "get", "/notifications").expect(200)
    ).body.notifications.filter((value: any) => value.kind === "mention")
      .length,
    1,
  );
});
test('comment removal requires author or manager access and respects the revision', async () => {
  const created = await call(owner, 'post', `${taskPath()}/comments`).send({ body: 'A removable test comment.' }).expect(201);
  const comment = created.body.comments.find((value: any) => value.body === 'A removable test comment.');
  await call(teammate, 'delete', `${taskPath()}/comments/${comment.id}`).send({ revision: 0 }).expect(403);
  await call(owner, 'delete', `${taskPath()}/comments/${comment.id}`).send({ revision: 9 }).expect(409);
  await call(owner, 'delete', `${taskPath()}/comments/${comment.id}`).send({ revision: 0 }).expect(200);
});
test("notifications may be marked read only by their recipient", async () => {
  const inbox = await call(teammate, "get", "/notifications").expect(200);
  const id = inbox.body.notifications[0].id;
  await call(owner, "patch", `/notifications/${id}/read`).send({}).expect(404);
  await call(teammate, "patch", `/notifications/${id}/read`)
    .send({})
    .expect(200);
  assert.equal(
    (await call(teammate, "get", "/notifications").expect(200)).body.unread,
    0,
  );
});
test("task assignments create a notification only when the assignee changes", async () => {
  let current = await board();
  const task = current.tasks.find((task) => task.id === taskId)!;
  const {
    title,
    description,
    status,
    priority,
    labels,
    dueDate,
    estimateHours,
  } = task;
  current = (
    await call(owner, "patch", taskPath())
      .send({
        title,
        description,
        status,
        priority,
        labels,
        dueDate,
        estimateHours,
        assigneeId: teammate.id,
        revision: task.revision,
        boardVersion: current.project.boardVersion,
      })
      .expect(200)
  ).body;
  const task2 = current.tasks.find((task) => task.id === taskId)!;
  await call(owner, "patch", taskPath())
    .send({
      title,
      description,
      status,
      priority,
      labels,
      dueDate,
      estimateHours,
      assigneeId: teammate.id,
      revision: task2.revision,
      boardVersion: current.project.boardVersion,
    })
    .expect(200);
  assert.equal(
    (
      await call(teammate, "get", "/notifications").expect(200)
    ).body.notifications.filter((value: any) => value.kind === "assignment")
      .length,
    1,
  );
});
test("attachments upload, list, and download through protected endpoints without exposing object keys", async () => {
  const result = await call(owner, "post", `${taskPath()}/attachments`)
    .attach("file", Buffer.from("A local reference document."), "reference.txt")
    .expect(201);
  const file = result.body.attachments[0];
  assert.equal(file.filename, "reference.txt");
  assert.equal(file.objectKey, undefined);
  const download = await call(
    teammate,
    "get",
    `${taskPath()}/attachments/${file.id}/download`,
  ).expect(200);
  assert.equal(download.body.toString(), "A local reference document.");
  assert.match(download.headers["content-disposition"], /^attachment;/);
  assert.equal(download.headers["x-content-type-options"], "nosniff");
  await call(
    foreign,
    "get",
    `${taskPath()}/attachments/${file.id}/download`,
  ).expect(404);
});
test("attachment validation rejects executable content, MIME mismatches, and oversized files", async () => {
  await call(owner, "post", `${taskPath()}/attachments`)
    .attach("file", Buffer.from("<script>alert(1)</script>"), "script.html")
    .expect(400);
  await call(owner, "post", `${taskPath()}/attachments`)
    .attach("file", Buffer.from("not a PDF"), "fake.pdf")
    .expect(400);
  await call(owner, "post", `${taskPath()}/attachments`)
    .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1, 65), "large.txt")
    .expect(413);
});
test("only the uploader or a manager can remove a file and cleanup follows committed metadata removal", async () => {
  const uploaded = await call(teammate, "post", `${taskPath()}/attachments`)
    .attach("file", Buffer.from("Teammate file"), "teammate.txt")
    .expect(201);
  const file = uploaded.body.attachments.find(
    (value: any) => value.filename === "teammate.txt",
  );
  await call(guest, "delete", `${taskPath()}/attachments/${file.id}`).expect(
    403,
  );
  const before = store.values.size;
  await call(teammate, "delete", `${taskPath()}/attachments/${file.id}`).expect(
    200,
  );
  await cleanFiles(store);
  assert.equal(store.values.size, before - 1);
  await call(
    owner,
    "get",
    `${taskPath()}/attachments/${file.id}/download`,
  ).expect(404);
});
test("archiving makes comments and uploads read-only", async () => {
  let current = await board();
  const project = current.project;
  const values = {
    name: project.name,
    description: project.description,
    leadId: project.leadId,
    guestIds: project.guestIds,
    status: "archived",
    revision: project.revision,
  };
  await call(owner, "patch", `/projects/${projectId}`).send(values).expect(200);
  await call(owner, "post", `${taskPath()}/comments`)
    .send({ body: "No archived writes" })
    .expect(409);
  await call(owner, "post", `${taskPath()}/attachments`)
    .attach("file", Buffer.from("Blocked"), "blocked.txt")
    .expect(409);
  current = await board();
  await call(owner, "patch", `/projects/${projectId}`)
    .send({ ...values, status: "active", revision: current.project.revision })
    .expect(200);
});
test("guest grant revocation filters old notifications and stops project-specific live events", async () => {
  await call(owner, "post", `${taskPath()}/comments`)
    .send({ body: "@Guest review this shared task.", mentionIds: [guest.id] })
    .expect(201);
  assert.equal(
    (await call(guest, "get", "/notifications").expect(200)).body.unread,
    1,
  );
  const socket = await connected(guest);
  let leaked = false;
  socket.on("comment:new", () => {
    leaked = true;
  });
  const current = await board();
  await call(owner, "patch", `/projects/${projectId}`)
    .send({
      name: current.project.name,
      description: "",
      leadId: null,
      guestIds: [],
      status: "active",
      revision: current.project.revision,
    })
    .expect(200);
  await call(owner, "post", `${taskPath()}/comments`)
    .send({ body: "Hidden after guest revocation." })
    .expect(201);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(leaked, false);
  assert.equal(
    (await call(guest, "get", "/notifications").expect(200)).body.notifications
      .length,
    0,
  );
});
test("local invitation mail is captured privately and its token is encrypted at rest", async () => {
  const token = await invite("local-mail@example.test");
  await mail.process();
  const list = await call(owner, "get", "/mail").expect(200);
  const delivery = list.body.deliveries.find(
    (value: any) => value.email === "local-mail@example.test",
  );
  assert.equal(delivery.status, "local");
  const preview = await call(
    owner,
    "get",
    `/mail/${delivery.id}/preview`,
  ).expect(200);
  assert.ok(preview.body.url.includes(token));
  const stored = await runWorkspace(owner.workspaceId, () =>
    mongoose.model("InvitationEmail").findById(delivery.id).lean(),
  );
  assert.ok(!JSON.stringify(stored).includes(token));
  await call(teammate, "get", "/mail").expect(403);
  await call(foreign, "get", `/mail/${delivery.id}/preview`).expect(404);
});
test("revoked invitations are cancelled by the delivery worker", async () => {
  await invite("revoked-mail@example.test");
  const invitations = await call(owner, "get", "/invites").expect(200);
  const pending = invitations.body.invites.find(
    (value: any) => value.email === "revoked-mail@example.test",
  );
  await call(owner, "delete", `/invites/${pending._id}`).expect(204);
  await mail.process();
  const list = await call(owner, "get", "/mail").expect(200);
  assert.equal(
    list.body.deliveries.find(
      (value: any) => value.email === "revoked-mail@example.test",
    ).status,
    "cancelled",
  );
});
test("SMTP transport sends the queued invitation over a real local SMTP connection", async () => {
  const messages: string[] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, callback) {
      let body = "";
      stream.on("data", (chunk) => {
        body += chunk.toString();
      });
      stream.on("end", () => {
        messages.push(body);
        callback();
      });
    },
  });
  smtp.listen(0, "127.0.0.1");
  await once(smtp.server, "listening");
  try {
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: (smtp.server.address() as any).port,
      secure: false,
      ignoreTLS: true,
    });
    const sender = new MailService(secret, {
      transport,
      from: "orbit@example.test",
    });
    await invite("smtp-wire@example.test");
    await sender.process();
    assert.ok(
      messages.some(
        (message) =>
          message.includes("smtp-wire@example.test") &&
          message.includes("Accept your invitation"),
      ),
    );
    const list = await call(owner, "get", "/mail").expect(200);
    assert.equal(
      list.body.deliveries.find(
        (value: any) => value.email === "smtp-wire@example.test",
      ).status,
      "sent",
    );
    transport.close();
  } finally {
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  }
});
test('failed email delivery retains the job and a manager can retry it safely', async () => {
  await invite('retry-mail@example.test');
  const failing = new MailService(secret, { from: 'orbit@example.test', transport: { sendMail: async () => { throw new Error('Simulated provider failure'); } } as any });
  await failing.process(); const deliveries = (await call(owner, 'get', '/mail').expect(200)).body.deliveries;
  const job = deliveries.find((value: any) => value.email === 'retry-mail@example.test'); assert.equal(job.status, 'failed'); assert.equal(job.attempts, 1);
  await call(teammate, 'post', `/mail/${job.id}/retry`).expect(403); await call(owner, 'post', `/mail/${job.id}/retry`).expect(204);
  await mail.process(); const retried = (await call(owner, 'get', '/mail').expect(200)).body.deliveries.find((value: any) => value.id === job.id); assert.equal(retried.status, 'local');
});
test("logout immediately revokes the active socket session", async () => {
  const user = await account("LogoutWire");
  await join(user);
  const socket = await connected(user);
  const revoked = event(socket, "access:revoked");
  await mark(user.agent.post("/api/auth/logout")).expect(204);
  await revoked;
});
test("My Tasks returns only the signed-in member assignments in accessible active projects", async () => {
  const mine = await call(teammate, "get", "/my-tasks").expect(200);
  assert.ok(mine.body.tasks.some((task: any) => task.id === taskId));
  assert.ok(
    mine.body.tasks.every((task: any) => task.assigneeId === teammate.id),
  );
  assert.equal(
    (await call(foreign, "get", "/my-tasks").expect(200)).body.tasks.length,
    0,
  );
});
test("removing a member revokes their connected socket before future project events", async () => {
  const user = await account("RemovedWire");
  await join(user);
  const socket = await connected(user);
  const revoked = event(socket, "access:revoked");
  const members = await call(owner, "get", "/members").expect(200);
  const member = members.body.members.find(
    (value: any) => value.user.id === user.id,
  );
  await call(owner, "delete", `/members/${member.id}`).expect(204);
  await revoked;
});
test("project deletion cascades collaboration records and queues file cleanup", async () => {
  const current = await board();
  await call(owner, "patch", `/projects/${projectId}`)
    .send({
      name: current.project.name,
      description: "",
      leadId: null,
      guestIds: [],
      status: "archived",
      revision: current.project.revision,
    })
    .expect(200);
  const archived = await board();
  await call(owner, "delete", `/projects/${projectId}`)
    .send({
      revision: archived.project.revision,
      boardVersion: archived.project.boardVersion,
    })
    .expect(204);
  await cleanFiles(store);
  assert.equal(store.values.size, 0);
  assert.equal(
    (await call(teammate, "get", "/notifications").expect(200)).body
      .notifications.length,
    0,
  );
});
test("collaboration models all require tenant scope", async () => {
  for (const name of [
    "Comment",
    "Attachment",
    "Notification",
    "FileDeletion",
    "InvitationEmail",
  ])
    await assert.rejects(
      () => mongoose.model(name).find().exec(),
      /workspace context/,
    );
});
test("local storage rejects traversal keys and S3 adapter keeps its configured bucket and private object path", async () => {
  await assert.rejects(
    () => new LocalStore().get("../secrets"),
    /Invalid storage key/,
  );
  const objects = new Map<string, Buffer>();
  const fake = {
    async send(command: any) {
      const { Key, Body, Bucket } = command.input;
      assert.equal(Bucket, "private-test");
      if (command.constructor.name === "PutObjectCommand") {
        objects.set(Key, Body);
        return {};
      }
      if (command.constructor.name === "DeleteObjectCommand") {
        objects.delete(Key);
        return {};
      }
      return { Body: { transformToByteArray: async () => objects.get(Key) } };
    },
  };
  const s3 = new S3Store("private-test", fake as any);
  const key = `${owner.workspaceId}/${randomUUID()}`;
  await s3.put(key, Buffer.from("S3 fixture"));
  assert.equal((await s3.get(key)).toString(), "S3 fixture");
  await s3.remove(key);
  assert.equal(objects.size, 0);
});
