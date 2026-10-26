import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import jwt from "jsonwebtoken";
import { resolve } from "node:path";
import { createApp, apiErrorHandler } from "../app.ts";
import { initializeModels } from "../data.ts";
import { runWorkspace, tenantGuard } from "../tenant.ts";

const secret = randomBytes(48).toString("hex");
const app = createApp({
  secret,
  origin: "http://localhost:4173",
  testing: true,
});
app.use(apiErrorHandler);
type Agent = ReturnType<typeof supertest.agent>;
type Account = {
  agent: Agent;
  user: { id: string; name: string; email: string };
  password: string;
};
type Space = { id: string; token: string };
let database: MongoMemoryReplSet;
let alice: Account,
  bob: Account,
  member: Account,
  admin: Account,
  guest: Account;
let spaceA: Space, spaceB: Space;
const mutation = (test: supertest.Test) => test.set("x-orbit-request", "1");
const scoped = (test: supertest.Test, space: Space) =>
  mutation(test).set("x-workspace-token", space.token);
async function account(name: string): Promise<Account> {
  const agent = supertest.agent(app);
  const password = randomBytes(24).toString("hex");
  const result = await mutation(agent.post("/api/auth/register"))
    .send({ name, email: `${name.toLowerCase()}@example.test`, password })
    .expect(201);
  return { agent, password, user: result.body.user };
}
async function makeSpace(
  owner: Account,
  name: string,
  slug: string,
): Promise<Space> {
  const result = await mutation(owner.agent.post("/api/workspaces"))
    .send({ name, slug, description: `${name} private description` })
    .expect(201);
  const session = await mutation(
    owner.agent.post(`/api/workspaces/${result.body.workspace.id}/session`),
  ).expect(200);
  return { id: result.body.workspace.id, token: session.body.token };
}
async function invite(account: Account, role: string) {
  const response = await scoped(
    alice.agent.post(`/api/w/${spaceA.id}/invites`),
    spaceA,
  )
    .send({ email: account.user.email, role })
    .expect(201);
  return new URL(response.body.url).searchParams.get("invite")!;
}
async function join(account: Account, role: string) {
  const token = await invite(account, role);
  await mutation(account.agent.post("/api/invites/accept"))
    .send({ token })
    .expect(200);
  const result = await mutation(
    account.agent.post(`/api/workspaces/${spaceA.id}/session`),
  ).expect(200);
  return { id: spaceA.id, token: result.body.token };
}
let memberSpace: Space, adminSpace: Space, guestSpace: Space;
before(
  async () => {
    process.env.MONGOMS_DOWNLOAD_DIR = resolve(".local/mongodb-binaries");
    database = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(database.getUri("orbit-security-tests"));
    await initializeModels();
    alice = await account("Alice");
    bob = await account("Bob");
    member = await account("Member");
    admin = await account("Admin");
    guest = await account("Guest");
    spaceA = await makeSpace(alice, "Alpha Team", "alpha-team");
    spaceB = await makeSpace(bob, "Beta Team", "beta-team");
    memberSpace = await join(member, "member");
    adminSpace = await join(admin, "admin");
    guestSpace = await join(guest, "guest");
  },
  { timeout: 240000 },
);
after(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

test("anonymous requests cannot read workspaces", async () => {
  await supertest(app).get("/api/workspaces").expect(401);
});
test("registration normalizes email and never returns a password hash", async () => {
  const result = await mutation(supertest(app).post("/api/auth/register"))
    .send({
      name: "Case User",
      email: "UPPER@example.test",
      password: randomBytes(16).toString("hex"),
    })
    .expect(201);
  assert.equal(result.body.user.email, "upper@example.test");
  assert.equal(result.body.user.passwordHash, undefined);
  assert.match(result.headers["set-cookie"][0], /HttpOnly/);
  assert.match(result.headers["set-cookie"][0], /SameSite=Strict/);
  assert.match(result.headers["set-cookie"][0], /Path=\/api/);
});
test("invalid credentials return a generic error", async () => {
  const result = await mutation(supertest(app).post("/api/auth/login"))
    .send({ email: alice.user.email, password: "incorrect-password" })
    .expect(401);
  assert.equal(result.body.error, "Email or password is incorrect.");
});
test("correct credentials establish an authenticated session", async () => {
  const agent = supertest.agent(app);
  await mutation(agent.post("/api/auth/login"))
    .send({ email: alice.user.email, password: alice.password })
    .expect(200);
  const result = await agent.get("/api/auth/me").expect(200);
  assert.equal(result.body.user.id, alice.user.id);
});
test("weak passwords and unknown request fields are rejected", async () => {
  await mutation(supertest(app).post("/api/auth/register"))
    .send({ name: "Nope", email: "weak@example.test", password: "short" })
    .expect(400);
  await mutation(alice.agent.post("/api/workspaces"))
    .send({ name: "Injected", slug: "injected", ownerId: bob.user.id })
    .expect(400);
});
test("CSRF protection rejects missing request marker and foreign origin", async () => {
  await alice.agent
    .post("/api/workspaces")
    .send({ name: "Blocked", slug: "blocked" })
    .expect(403);
  await mutation(alice.agent.post("/api/workspaces"))
    .set("origin", "https://attacker.example")
    .send({ name: "Blocked", slug: "blocked" })
    .expect(403);
});
test("workspace listing only returns current memberships", async () => {
  const result = await alice.agent.get("/api/workspaces").expect(200);
  assert.deepEqual(
    result.body.workspaces.map((w: any) => w.id),
    [spaceA.id],
  );
});
test("a user cannot mint a token for another workspace", async () => {
  await mutation(
    alice.agent.post(`/api/workspaces/${spaceB.id}/session`),
  ).expect(404);
});
test("workspace token must match the path", async () => {
  await scoped(alice.agent.get(`/api/w/${spaceB.id}/overview`), spaceA).expect(
    403,
  );
});
test("workspace token must match the signed-in user and session", async () => {
  await scoped(bob.agent.get(`/api/w/${spaceA.id}/overview`), spaceA).expect(
    403,
  );
});
test("workspace endpoints fail closed without a scoped token", async () => {
  await alice.agent.get(`/api/w/${spaceA.id}/members`).expect(401);
});
test("expired workspace tokens cannot read workspace data", async () => {
  const token = jwt.sign(
    { sub: alice.user.id, workspaceId: spaceA.id },
    secret,
    { issuer: "orbit", audience: "workspace", expiresIn: -1 },
  );
  await scoped(alice.agent.get(`/api/w/${spaceA.id}/overview`), {
    id: spaceA.id,
    token,
  }).expect(401);
});
test("overview, members, and activity never leak the second workspace", async () => {
  for (const endpoint of ["overview", "members", "activity"]) {
    const result = await scoped(
      alice.agent.get(`/api/w/${spaceA.id}/${endpoint}`),
      spaceA,
    ).expect(200);
    const body = JSON.stringify(result.body);
    assert.ok(!body.includes("Beta Team"));
    assert.ok(!body.includes(bob.user.email));
  }
});
test("body-supplied workspace ownership is rejected", async () => {
  await scoped(alice.agent.patch(`/api/w/${spaceA.id}/settings`), spaceA)
    .send({ name: "Injection", description: "", workspaceId: spaceB.id })
    .expect(400);
});
test("member and guest cannot change settings, invite, or list pending invitations", async () => {
  for (const [user, space] of [
    [member, memberSpace],
    [guest, guestSpace],
  ] as const) {
    await scoped(user.agent.patch(`/api/w/${space.id}/settings`), space)
      .send({ name: "No access", description: "" })
      .expect(403);
    await scoped(user.agent.post(`/api/w/${space.id}/invites`), space)
      .send({ email: "no@example.test", role: "member" })
      .expect(403);
    await scoped(user.agent.get(`/api/w/${space.id}/invites`), space).expect(
      403,
    );
  }
});
test("owner cannot be removed or demoted", async () => {
  const result = await scoped(
    alice.agent.get(`/api/w/${spaceA.id}/members`),
    spaceA,
  ).expect(200);
  const owner = result.body.members.find((m: any) => m.role === "owner");
  await scoped(
    alice.agent.delete(`/api/w/${spaceA.id}/members/${owner.id}`),
    spaceA,
  ).expect(403);
  await scoped(
    alice.agent.patch(`/api/w/${spaceA.id}/members/${owner.id}`),
    spaceA,
  )
    .send({ role: "member" })
    .expect(403);
});
test("admin cannot promote members to admin or issue admin invitations", async () => {
  const result = await scoped(
    admin.agent.get(`/api/w/${spaceA.id}/members`),
    adminSpace,
  ).expect(200);
  const target = result.body.members.find(
    (m: any) => m.user.id === member.user.id,
  );
  await scoped(
    admin.agent.patch(`/api/w/${spaceA.id}/members/${target.id}`),
    adminSpace,
  )
    .send({ role: "admin" })
    .expect(403);
  await scoped(admin.agent.post(`/api/w/${spaceA.id}/invites`), adminSpace)
    .send({ email: "other-admin@example.test", role: "admin" })
    .expect(403);
});
test("admin cannot revoke an invitation granting admin access", async () => {
  const newcomer = await account("FutureAdmin");
  await invite(newcomer, "admin");
  const list = await scoped(
    alice.agent.get(`/api/w/${spaceA.id}/invites`),
    spaceA,
  ).expect(200);
  const pending = list.body.invites.find(
    (entry: any) => entry.email === newcomer.user.email,
  );
  await scoped(
    admin.agent.delete(`/api/w/${spaceA.id}/invites/${pending._id}`),
    adminSpace,
  ).expect(403);
});
test("admin can update ordinary workspace details", async () => {
  await scoped(admin.agent.patch(`/api/w/${spaceA.id}/settings`), adminSpace)
    .send({
      name: "Alpha Team",
      description: "Updated by an authorised admin.",
    })
    .expect(200);
});
test("resource IDs from another tenant return not found", async () => {
  const foreign = await scoped(
    bob.agent.get(`/api/w/${spaceB.id}/members`),
    spaceB,
  ).expect(200);
  await scoped(
    alice.agent.delete(
      `/api/w/${spaceA.id}/members/${foreign.body.members[0].id}`,
    ),
    spaceA,
  ).expect(404);
});
test("role changes apply even while an old workspace token remains valid", async () => {
  const result = await scoped(
    alice.agent.get(`/api/w/${spaceA.id}/members`),
    spaceA,
  ).expect(200);
  const target = result.body.members.find(
    (m: any) => m.user.id === admin.user.id,
  );
  await scoped(
    alice.agent.patch(`/api/w/${spaceA.id}/members/${target.id}`),
    spaceA,
  )
    .send({ role: "member" })
    .expect(200);
  await scoped(admin.agent.post(`/api/w/${spaceA.id}/invites`), adminSpace)
    .send({ email: "stale@example.test", role: "guest" })
    .expect(403);
});
test("removed member loses access with their existing workspace token", async () => {
  const result = await scoped(
    alice.agent.get(`/api/w/${spaceA.id}/members`),
    spaceA,
  ).expect(200);
  const target = result.body.members.find(
    (m: any) => m.user.id === member.user.id,
  );
  await scoped(
    alice.agent.delete(`/api/w/${spaceA.id}/members/${target.id}`),
    spaceA,
  ).expect(204);
  await scoped(
    member.agent.get(`/api/w/${spaceA.id}/overview`),
    memberSpace,
  ).expect(404);
});
test("invitation is bound to its intended email", async () => {
  const token = await invite(member, "member");
  await mutation(bob.agent.post("/api/invites/accept"))
    .send({ token })
    .expect(400);
});
test("invitation acceptance is atomic and single-use under concurrent requests", async () => {
  const token = await invite(member, "member");
  const results = await Promise.all([
    mutation(member.agent.post("/api/invites/accept")).send({ token }),
    mutation(member.agent.post("/api/invites/accept")).send({ token }),
  ]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.ok(results.every((result) => [200, 400, 409].includes(result.status)));
  await mutation(member.agent.post("/api/invites/accept"))
    .send({ token })
    .expect(400);
});
test("revoked invitations cannot be accepted", async () => {
  const newcomer = await account("Revoked");
  const token = await invite(newcomer, "guest");
  const list = await scoped(
    alice.agent.get(`/api/w/${spaceA.id}/invites`),
    spaceA,
  ).expect(200);
  const invitation = list.body.invites.find(
    (entry: any) => entry.email === newcomer.user.email,
  );
  await scoped(
    alice.agent.delete(`/api/w/${spaceA.id}/invites/${invitation._id}`),
    spaceA,
  ).expect(204);
  await mutation(newcomer.agent.post("/api/invites/accept"))
    .send({ token })
    .expect(400);
});
test("expired or tampered invitation signatures are rejected", async () => {
  const token = jwt.sign(
    { workspaceId: spaceA.id, email: bob.user.email },
    secret,
    { issuer: "orbit", audience: "invitation", expiresIn: -1 },
  );
  await mutation(bob.agent.post("/api/invites/accept"))
    .send({ token })
    .expect(400);
  await mutation(bob.agent.post("/api/invites/accept"))
    .send({ token: `${token}corrupted` })
    .expect(400);
});
test("duplicate workspace slug does not leave a partial membership", async () => {
  await mutation(alice.agent.post("/api/workspaces"))
    .send({ name: "Duplicate", slug: "beta-team" })
    .expect(409);
  const result = await alice.agent.get("/api/workspaces").expect(200);
  assert.equal(result.body.workspaces.length, 1);
});
test("logout revokes a copied session cookie", async () => {
  const user = await account("Logout");
  const login = await mutation(supertest(app).post("/api/auth/login"))
    .send({ email: user.user.email, password: user.password })
    .expect(200);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  await mutation(supertest(app).post("/api/auth/logout"))
    .set("Cookie", cookie)
    .expect(204);
  await supertest(app).get("/api/auth/me").set("Cookie", cookie).expect(401);
});
test("tenant query guard rejects unscoped reads and writes and filters aggregates", async () => {
  const schema = new mongoose.Schema({
    workspaceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    value: String,
  });
  schema.plugin(tenantGuard);
  const Probe = mongoose.model("GuardProbe", schema);
  await Probe.init();
  await assert.rejects(() => Probe.find().exec(), /workspace context/);
  await assert.rejects(
    () => Probe.create({ workspaceId: spaceA.id, value: "unscoped" }),
    /workspace context/,
  );
  await runWorkspace(spaceA.id, () =>
    Probe.create({ workspaceId: spaceA.id, value: "alpha" }),
  );
  await runWorkspace(spaceB.id, () =>
    Probe.create({ workspaceId: spaceB.id, value: "beta" }),
  );
  const values = await runWorkspace(spaceA.id, () => Probe.find().lean());
  assert.deepEqual(
    values.map((v) => v.value),
    ["alpha"],
  );
  const aggregate = await runWorkspace(spaceA.id, () =>
    Probe.aggregate([{ $count: "count" }]),
  );
  assert.equal(aggregate[0].count, 1);
  await assert.rejects(
    () =>
      runWorkspace(spaceA.id, () =>
        Probe.updateOne({}, { $set: { workspaceId: spaceB.id } }).exec(),
      ),
    /immutable/,
  );
  await assert.rejects(
    () =>
      runWorkspace(spaceA.id, () =>
        Probe.create({ workspaceId: spaceB.id, value: "mismatch" }),
      ),
    /invalid document workspace/,
  );
  await assert.rejects(
    () =>
      runWorkspace(spaceA.id, () =>
        Probe.aggregate([{ $unionWith: "guardprobes" }]).exec(),
      ),
    /cross-collection/,
  );
  await assert.rejects(
    () =>
      runWorkspace(spaceA.id, () =>
        Probe.bulkWrite([{ deleteMany: { filter: {} } }]),
      ),
    /bulkWrite/,
  );
  await assert.rejects(
    () =>
      runWorkspace(spaceA.id, () =>
        Probe.insertMany([{ workspaceId: spaceB.id, value: "foreign-insert" }]),
      ),
    /invalid document workspace/,
  );
  const alpha = await runWorkspace(spaceA.id, () => Probe.findOne());
  assert.ok(alpha);
  alpha.workspaceId = new mongoose.Types.ObjectId(spaceB.id);
  await assert.rejects(
    () => runWorkspace(spaceA.id, () => alpha.save()),
    /invalid document workspace/,
  );
  await runWorkspace(spaceA.id, () => Probe.deleteMany({}).exec());
  assert.equal(await runWorkspace(spaceB.id, () => Probe.countDocuments()), 1);
});
