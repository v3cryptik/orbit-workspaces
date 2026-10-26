import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import { createApp, apiErrorHandler } from "../app.ts";
import { initializeModels } from "../data.ts";
import { MongoStore, configuredStore, maxFileSize } from "../storage.ts";
import { MailService } from "../mail.ts";
import { runWorkspace } from "../tenant.ts";
const secret = randomBytes(48).toString("hex"),
  store = new MongoStore();
const mail = new MailService(secret, {
  production: true,
  testing: true,
  mode: "disabled",
});
const app = createApp({
  secret,
  origin: "https://orbit.example.test",
  testing: true,
  services: { store, mail },
});
app.use(apiErrorHandler);
const marker = (req: supertest.Test) => req.set("x-orbit-request", "1");
let database: MongoMemoryReplSet,
  owner: any,
  outsider: any,
  projectId: string,
  taskId: string,
  attachmentId: string;
async function account(name: string) {
  const agent = supertest.agent(app),
    email = `${name}@example.test`;
  const response = await marker(agent.post("/api/auth/register"))
    .send({ name, email, password: randomBytes(24).toString("hex") })
    .expect(201);
  const workspace = (
    await marker(agent.post("/api/workspaces"))
      .send({ name: `${name} workspace`, slug: `${name}-workspace` })
      .expect(201)
  ).body.workspace;
  const token = (
    await marker(agent.post(`/api/workspaces/${workspace.id}/session`)).expect(
      200,
    )
  ).body.token;
  return {
    agent,
    email,
    id: response.body.user.id,
    workspaceId: workspace.id,
    token,
  };
}
function call(user: any, method: "get" | "post" | "delete", path: string) {
  return marker(user.agent[method](`/api/w/${user.workspaceId}${path}`)).set(
    "x-workspace-token",
    user.token,
  );
}
before(
  async () => {
    process.env.MONGOMS_DOWNLOAD_DIR = resolve(".local/mongodb-binaries");
    database = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(database.getUri("orbit-deployment-tests"));
    await initializeModels();
    owner = await account("previewowner");
    outsider = await account("previewoutsider");
    const p = (
      await call(owner, "post", "/projects")
        .send({ name: "Preview project", key: "PV" })
        .expect(201)
    ).body;
    projectId = p.project.id;
    const b = (
      await call(owner, "post", `/projects/${projectId}/tasks`)
        .send({
          title: "Test durable files",
          boardVersion: p.project.boardVersion,
        })
        .expect(201)
    ).body;
    taskId = b.tasks[0].id;
  },
  { timeout: 240000 },
);
after(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
test("production can explicitly select durable MongoDB attachment storage without a filesystem path", () => {
  const previous = process.env.FILE_STORAGE;
  process.env.FILE_STORAGE = "mongodb";
  try {
    assert.ok(configuredStore(true) instanceof MongoStore);
  } finally {
    if (previous === undefined) delete process.env.FILE_STORAGE;
    else process.env.FILE_STORAGE = previous;
  }
});
test("MongoDB objects persist across store instances and cannot overwrite an existing key", async () => {
  const key = `${owner.workspaceId}/${randomUUID()}`;
  await store.put(key, Buffer.from("Persistent preview bytes"));
  assert.equal(
    (await new MongoStore().get(key)).toString(),
    "Persistent preview bytes",
  );
  await assert.rejects(() => store.put(key, Buffer.from("overwrite")));
  assert.equal((await store.get(key)).toString(), "Persistent preview bytes");
  await store.remove(key);
  await store.remove(key);
  await assert.rejects(() => store.get(key), /File not found/);
});
test("stored-file models remain tenant guarded and reject unsafe keys or oversized content", async () => {
  await assert.rejects(
    () => mongoose.model("StoredFile").find().exec(),
    /workspace context/,
  );
  await assert.rejects(() => store.get("../secrets"), /Invalid storage key/);
  await assert.rejects(
    () =>
      store.put(
        `${owner.workspaceId}/${randomUUID()}`,
        Buffer.alloc(maxFileSize + 1),
      ),
    /10 MB/,
  );
  const key = `${owner.workspaceId}/${randomUUID()}`;
  await store.put(key, Buffer.from("Scoped"));
  await runWorkspace(outsider.workspaceId, async () => {
    assert.equal(await mongoose.model("StoredFile").countDocuments({ key }), 0);
  });
  await store.remove(key);
});
test("guarded attachment upload and download work using durable MongoDB bytes", async () => {
  const result = await call(
    owner,
    "post",
    `/projects/${projectId}/tasks/${taskId}/attachments`,
  )
    .attach("file", Buffer.from("Hosted attachment fixture"), "preview.txt")
    .expect(201);
  attachmentId = result.body.attachments[0].id;
  const response = await call(
    owner,
    "get",
    `/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/download`,
  ).expect(200);
  assert.equal(response.body.toString(), "Hosted attachment fixture");
  assert.match(response.headers["content-disposition"], /attachment/);
  await call(
    outsider,
    "get",
    `/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/download`,
  ).expect(404);
});
test("explicit link-only production mode never sends or exposes local mail and keeps invitations valid", async () => {
  const invite = await call(owner, "post", "/invites")
    .send({ email: outsider.email, role: "member" })
    .expect(201);
  assert.equal(invite.body.delivery, "disabled");
  await mail.process();
  const listing = (await call(owner, "get", "/mail").expect(200)).body;
  assert.equal(listing.mode, "disabled");
  assert.equal(listing.deliveries[0].status, "disabled");
  assert.equal(listing.deliveries[0].canPreview, false);
  const job = listing.deliveries[0].id;
  await call(owner, "get", `/mail/${job}/preview`).expect(404);
  await call(owner, "post", `/mail/${job}/retry`).expect(409);
  const token = new URL(invite.body.url).searchParams.get("invite");
  await marker(outsider.agent.post("/api/invites/accept"))
    .send({ token })
    .expect(200);
});
test("production mail still fails closed unless SMTP or explicit disabled mode is configured", () => {
  assert.throws(
    () =>
      new MailService(secret, {
        production: true,
        testing: true,
        mode: "local",
      }),
    /Production invitation/,
  );
  assert.equal(mail.mode, "disabled");
});
test("hosted preview retains Secure HttpOnly cookies and same-origin CSRF checks", async () => {
  const production = createApp({
    secret,
    origin: "https://orbit.example.test",
    production: true,
    testing: true,
    services: { store, mail },
  });
  production.use(apiErrorHandler);
  const response = await marker(
    supertest(production).post("/api/auth/register"),
  )
    .set("Origin", "https://orbit.example.test")
    .send({
      name: "Secure user",
      email: "secure@example.test",
      password: randomBytes(24).toString("hex"),
    })
    .expect(201);
  const cookie = response.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  await marker(supertest(production).post("/api/auth/login"))
    .set("Origin", "https://foreign.example.test")
    .send({ email: "secure@example.test", password: "irrelevant" })
    .expect(403);
});
