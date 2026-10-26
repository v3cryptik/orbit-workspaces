import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import { createApp, apiErrorHandler } from "../app.ts";
import { initializeModels } from "../data.ts";
import { runWorkspace } from "../tenant.ts";
import type { BoardSnapshot, Task } from "../../shared/work.ts";
import type { Sprint } from "../../shared/planning.ts";
const app = createApp({
  secret: randomBytes(48).toString("hex"),
  origin: "http://localhost:4173",
  testing: true,
});
app.use(apiErrorHandler);
type Account = {
  agent: ReturnType<typeof supertest.agent>;
  id: string;
  email: string;
  workspaceId: string;
  token: string;
};
let database: MongoMemoryReplSet,
  owner: Account,
  member: Account,
  guest: Account,
  outsider: Account;
const marker = (req: supertest.Test) => req.set("x-orbit-request", "1");
function call(
  user: Account,
  method: "get" | "post" | "patch" | "delete",
  path: string,
) {
  return marker(user.agent[method](`/api/w/${user.workspaceId}${path}`)).set(
    "x-workspace-token",
    user.token,
  );
}
async function account(name: string): Promise<Account> {
  const agent = supertest.agent(app),
    email = `${name}@example.test`;
  const result = await marker(agent.post("/api/auth/register"))
    .send({ name, email, password: randomBytes(24).toString("hex") })
    .expect(201);
  return { agent, email, id: result.body.user.id, workspaceId: "", token: "" };
}
async function workspace(user: Account, name: string) {
  user.workspaceId = (
    await marker(user.agent.post("/api/workspaces"))
      .send({ name, slug: name.toLowerCase() })
      .expect(201)
  ).body.workspace.id;
  user.token = (
    await marker(
      user.agent.post(`/api/workspaces/${user.workspaceId}/session`),
    ).expect(200)
  ).body.token;
}
async function join(user: Account, role: string) {
  const invite = await call(owner, "post", "/invites")
    .send({ email: user.email, role })
    .expect(201);
  await marker(user.agent.post("/api/invites/accept"))
    .send({ token: new URL(invite.body.url).searchParams.get("invite") })
    .expect(200);
  user.workspaceId = owner.workspaceId;
  user.token = (
    await marker(
      user.agent.post(`/api/workspaces/${user.workspaceId}/session`),
    ).expect(200)
  ).body.token;
}
const nowDate = new Date().toISOString().slice(0, 10),
  endDate = new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10);
const sprintValues = {
  name: "Iteration one",
  goal: "Ship the core flow",
  startDate: nowDate,
  endDate,
};
let counter = 0;
async function project(user = owner, guestIds: string[] = []) {
  return (
    await call(user, "post", "/projects")
      .send({ name: `Project ${++counter}`, key: `P${counter}`, guestIds })
      .expect(201)
  ).body as BoardSnapshot;
}
async function board(p: string) {
  return (await call(owner, "get", `/projects/${p}/board`).expect(200))
    .body as BoardSnapshot;
}
async function task(p: string, extra = {}) {
  const current = await board(p);
  return (
    await call(owner, "post", `/projects/${p}/tasks`)
      .send({
        title: "Work item",
        estimateHours: 4,
        ...extra,
        boardVersion: current.project.boardVersion,
      })
      .expect(201)
  ).body.tasks.at(-1) as Task;
}
async function plan(p: string, user = owner) {
  return (await call(user, "get", `/projects/${p}/sprints`).expect(200))
    .body as { sprints: Sprint[]; boardVersion: number };
}
async function sprint(p: string, extra = {}) {
  const before = await plan(p);
  const next = (
    await call(owner, "post", `/projects/${p}/sprints`)
      .send({ ...sprintValues, ...extra })
      .expect(201)
  ).body;
  return next.sprints.find(
    (s: Sprint) => !before.sprints.some((old) => old.id === s.id),
  ) as Sprint;
}
function checked(response: any) {
  return {
    ...response,
    expect(status: number) {
      assert.equal(response.status, status, JSON.stringify(response.body));
      return response;
    },
  };
}
async function allocate(p: string, s: string | null, ids: string[]) {
  const boardVersion = (await plan(p)).boardVersion;
  return checked(
    await call(owner, "patch", `/projects/${p}/sprint-tasks`).send({
      sprintId: s,
      taskIds: ids,
      boardVersion,
    }),
  );
}
async function start(p: string, s: Sprint) {
  const boardVersion = (await plan(p)).boardVersion;
  return checked(
    await call(owner, "post", `/projects/${p}/sprints/${s.id}/start`).send({
      revision: s.revision,
      boardVersion,
    }),
  );
}
async function complete(p: string, s: Sprint, carryToId: string | null = null) {
  const boardVersion = (await plan(p)).boardVersion;
  return checked(
    await call(owner, "post", `/projects/${p}/sprints/${s.id}/complete`).send({
      revision: s.revision,
      boardVersion,
      carryToId,
    }),
  );
}
async function editTask(p: string, id: string, changes = {}) {
  const b = await board(p),
    t = b.tasks.find((t) => t.id === id)!;
  const {
    title,
    description,
    status,
    priority,
    assigneeId,
    labels,
    dueDate,
    estimateHours,
  } = t;
  return checked(
    await call(owner, "patch", `/projects/${p}/tasks/${id}`).send({
      title,
      description,
      status,
      priority,
      assigneeId,
      labels,
      dueDate,
      estimateHours,
      ...changes,
      revision: t.revision,
      boardVersion: b.project.boardVersion,
    }),
  );
}
async function logTime(
  user: Account,
  p: string,
  t: string,
  minutes: number,
  extra = {},
) {
  return checked(
    await call(user, "post", `/projects/${p}/tasks/${t}/time`).send({
      date: nowDate,
      minutes,
      note: "Focused work",
      ...extra,
    }),
  );
}
async function sheet(user = owner, extra = "") {
  return (
    await call(
      user,
      "get",
      `/timesheet?from=${nowDate}&to=${nowDate}${extra}`,
    ).expect(200)
  ).body;
}
before(
  async () => {
    process.env.MONGOMS_DOWNLOAD_DIR = resolve(".local/mongodb-binaries");
    database = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(database.getUri("orbit-phase4-tests"));
    await initializeModels();
    owner = await account("owner");
    member = await account("member");
    guest = await account("guest");
    outsider = await account("outsider");
    await workspace(owner, "Planning");
    await workspace(outsider, "Elsewhere");
    await join(member, "member");
    await join(guest, "guest");
  },
  { timeout: 240000 },
);
after(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

test("sprints and reports reject foreign projects and hide private work from guests", async () => {
  const p = (await project()).project.id,
    s = await sprint(p);
  for (const user of [guest, outsider])
    for (const path of [
      `/projects/${p}/sprints`,
      `/projects/${p}/reports/velocity`,
      `/projects/${p}/reports/burndown/${s.id}`,
    ])
      await call(user, "get", path).expect(404);
  await call(outsider, "post", `/projects/${p}/sprints`)
    .send(sprintValues)
    .expect(404);
});
test("guests can read shared sprints and burndown but only managers manage planning", async () => {
  const p = (await project(owner, [guest.id])).project.id,
    s = await sprint(p);
  assert.equal((await plan(p, guest)).sprints.length, 1);
  await call(guest, "get", `/projects/${p}/reports/burndown/${s.id}`).expect(
    200,
  );
  for (const user of [guest, member])
    await call(user, "post", `/projects/${p}/sprints`)
      .send(sprintValues)
      .expect(403);
  await call(guest, "get", `/projects/${p}/reports/workload`).expect(403);
});
test("sprint dates and immutable ownership reject invalid or injected values", async () => {
  const p = (await project()).project.id;
  for (const extra of [
    { startDate: "2026-02-30" },
    { startDate: endDate, endDate: nowDate },
    { endDate: "2099-01-01" },
    { workspaceId: outsider.workspaceId },
  ])
    await call(owner, "post", `/projects/${p}/sprints`)
      .send({ ...sprintValues, ...extra })
      .expect(400);
});
test("planned sprint edits use revisions and active sprint dates are locked", async () => {
  const p = (await project()).project.id,
    s = await sprint(p),
    t = await task(p);
  await call(owner, "patch", `/projects/${p}/sprints/${s.id}`)
    .send({ ...sprintValues, name: "Updated iteration", revision: 0 })
    .expect(200);
  await call(owner, "patch", `/projects/${p}/sprints/${s.id}`)
    .send({ ...sprintValues, revision: 0 })
    .expect(409);
  await (await allocate(p, s.id, [t.id])).expect(200);
  await (await start(p, (await plan(p)).sprints[0])).expect(200);
  await call(owner, "patch", `/projects/${p}/sprints/${s.id}`)
    .send({ ...sprintValues, revision: 2 })
    .expect(409);
});
test("allocation rejects foreign tasks, subtasks, duplicate identifiers and stale board versions", async () => {
  const p = (await project()).project.id,
    other = (await project()).project.id,
    s = await sprint(p),
    t = await task(p),
    foreign = await task(other),
    child = await task(p, { parentTaskId: t.id });
  for (const ids of [[foreign.id], [child.id], [t.id, t.id]])
    await (await allocate(p, s.id, ids)).expect(400);
  const before = await plan(p);
  await (await allocate(p, s.id, [t.id])).expect(200);
  await call(owner, "patch", `/projects/${p}/sprint-tasks`)
    .send({
      sprintId: null,
      taskIds: [t.id],
      boardVersion: before.boardVersion,
    })
    .expect(409);
  assert.equal(
    (await board(p)).tasks.find((x) => x.id === t.id)!.sprintId,
    s.id,
  );
});
test("empty and future sprints cannot start, and concurrent starts allow one active sprint per project", async () => {
  const p = (await project()).project.id,
    a = await sprint(p),
    b = await sprint(p, { name: "Second" });
  await (await start(p, a)).expect(409);
  const t1 = await task(p),
    t2 = await task(p);
  await (await allocate(p, a.id, [t1.id])).expect(200);
  await (await allocate(p, b.id, [t2.id])).expect(200);
  const v = (await plan(p)).boardVersion;
  const results = await Promise.all(
    [a, b].map((s) =>
      call(owner, "post", `/projects/${p}/sprints/${s.id}/start`).send({
        revision: s.revision,
        boardVersion: v,
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await plan(p)).sprints.filter((s) => s.status === "active").length,
    1,
  );
  const futureP = (await project()).project.id,
    future = await sprint(futureP, { startDate: endDate });
  const ft = await task(futureP);
  await (await allocate(futureP, future.id, [ft.id])).expect(200);
  await (await start(futureP, future)).expect(409);
});
test("burndown records start, completion, reopening, estimate changes and scope changes from real mutations", async () => {
  const p = (await project()).project.id,
    s = await sprint(p),
    t = await task(p),
    extra = await task(p, { estimateHours: null });
  await (await allocate(p, s.id, [t.id])).expect(200);
  await (await start(p, s)).expect(200);
  await (await editTask(p, t.id, { status: "done" })).expect(200);
  await (
    await editTask(p, t.id, { status: "todo", estimateHours: 6 })
  ).expect(200);
  await (await allocate(p, s.id, [extra.id])).expect(200);
  const r = (
    await call(owner, "get", `/projects/${p}/reports/burndown/${s.id}`).expect(
      200,
    )
  ).body;
  assert.deepEqual(
    r.points.map((x: any) => x.remainingTasks),
    [1, 0, 1, 2],
  );
  assert.equal(r.points.at(-1).unestimated, 1);
  assert.equal(r.points.at(-1).totalHours, 6);
  assert.equal(r.days[0].remaining, 2);
  assert.equal(r.days.at(-1).remaining, null);
});
test("task deletion changes active burndown without erasing past points", async () => {
  const p = (await project()).project.id,
    s = await sprint(p),
    t = await task(p);
  await (await allocate(p, s.id, [t.id])).expect(200);
  await (await start(p, s)).expect(200);
  const b = await board(p),
    current = b.tasks.find((x) => x.id === t.id)!;
  await call(owner, "delete", `/projects/${p}/tasks/${t.id}`)
    .send({ revision: current.revision, boardVersion: b.project.boardVersion })
    .expect(200);
  const r = (
    await call(owner, "get", `/projects/${p}/reports/burndown/${s.id}`).expect(
      200,
    )
  ).body;
  assert.deepEqual(
    r.points.map((p: any) => p.totalTasks),
    [1, 0],
  );
});
test("completion freezes velocity and carries only unfinished work into a planned sprint", async () => {
  const p = (await project()).project.id,
    first = await sprint(p),
    next = await sprint(p, { name: "Next iteration" });
  const done = await task(p, { status: "done" }),
    todo = await task(p);
  await (await allocate(p, first.id, [done.id, todo.id])).expect(200);
  await (await start(p, first)).expect(200);
  const active = (await plan(p)).sprints.find((s) => s.id === first.id)!;
  await (await complete(p, active, next.id)).expect(200);
  const b = await board(p);
  assert.equal(b.tasks.find((t) => t.id === done.id)!.sprintId, first.id);
  assert.equal(b.tasks.find((t) => t.id === todo.id)!.sprintId, next.id);
  await (
    await editTask(p, done.id, { status: "todo", estimateHours: 20 })
  ).expect(200);
  const v = (
    await call(owner, "get", `/projects/${p}/reports/velocity`).expect(200)
  ).body.sprints[0];
  assert.equal(v.doneTasks, 1);
  assert.equal(v.totalTasks, 2);
  assert.equal(v.doneHours, 4);
  await (await allocate(p, next.id, [done.id])).expect(409);
  await (await allocate(p, first.id, [todo.id])).expect(409);
});
test("completing to backlog preserves task status and repeat completion is rejected", async () => {
  const p = (await project()).project.id,
    s = await sprint(p),
    t = await task(p, { status: "in_progress" });
  await (await allocate(p, s.id, [t.id])).expect(200);
  await (await start(p, s)).expect(200);
  const active = (await plan(p)).sprints[0];
  await (await complete(p, active)).expect(200);
  await (await complete(p, active)).expect(409);
  const current = (await board(p)).tasks[0];
  assert.equal(current.sprintId, null);
  assert.equal(current.status, "in_progress");
});
test("workload counts top-level open tasks once, including unassigned and unestimated work", async () => {
  const p = (await project()).project.id,
    t = await task(p, { assigneeId: member.id });
  await task(p, { parentTaskId: t.id, assigneeId: member.id });
  await task(p, { estimateHours: null });
  await task(p, { status: "done" });
  const r = (
    await call(member, "get", `/projects/${p}/reports/workload`).expect(200)
  ).body;
  assert.equal(r.totalOpen, 2);
  assert.equal(
    r.rows.find((r: any) => r.userId === member.id).estimatedHours,
    4,
  );
  assert.equal(r.rows.find((r: any) => r.userId === null).unestimated, 1);
});
test("time logging is tenant scoped, validates values, and rejects guests", async () => {
  const p = (await project(owner, [guest.id])).project.id,
    t = await task(p);
  await (await logTime(outsider, p, t.id, 30)).expect(404);
  await (await logTime(guest, p, t.id, 30)).expect(403);
  for (const values of [
    { minutes: 0 },
    { minutes: 1441 },
    { minutes: 1.5 },
    { date: "2026-02-30" },
    { date: "2099-01-01" },
    { userId: owner.id },
  ])
    await (await logTime(member, p, t.id, 30, values)).expect(400);
  await (await logTime(member, p, t.id, 45)).expect(201);
  assert.equal((await sheet(member)).totalMinutes, 45);
  assert.equal((await sheet(outsider)).totalMinutes, 0);
});
test("members see only their time while managers can review team totals and filter a person", async () => {
  const p = (await project()).project.id,
    t = await task(p);
  await (await logTime(member, p, t.id, 20)).expect(201);
  await (await logTime(owner, p, t.id, 35)).expect(201);
  const managerSheet = await sheet(owner, `&scope=team&projectId=${p}`);
  assert.equal(managerSheet.totalMinutes, 55);
  assert.equal(managerSheet.people.length, 2);
  assert.equal(
    (await sheet(owner, `&scope=team&projectId=${p}&userId=${member.id}`))
      .totalMinutes,
    20,
  );
  await call(
    member,
    "get",
    `/timesheet?from=${nowDate}&to=${nowDate}&scope=team`,
  ).expect(403);
  await call(
    member,
    "get",
    `/timesheet?from=${nowDate}&to=${nowDate}&userId=${owner.id}`,
  ).expect(403);
});
test("time entry edits/removal are author-only and reject stale revisions", async () => {
  const p = (await project()).project.id,
    t = await task(p);
  await (await logTime(member, p, t.id, 30)).expect(201);
  const e = (await sheet(member)).entries.find((e: any) => e.projectId === p);
  await call(owner, "patch", `/time/${e.id}`)
    .send({ date: nowDate, minutes: 40, revision: 0 })
    .expect(404);
  await call(member, "patch", `/time/${e.id}`)
    .send({ date: nowDate, minutes: 40, revision: 0 })
    .expect(200);
  await call(member, "patch", `/time/${e.id}`)
    .send({ date: nowDate, minutes: 50, revision: 0 })
    .expect(409);
  await call(member, "delete", `/time/${e.id}`)
    .send({ revision: 0 })
    .expect(409);
  await call(member, "delete", `/time/${e.id}`)
    .send({ revision: 1 })
    .expect(204);
  assert.equal(
    (await sheet(member)).entries.some((x: any) => x.id === e.id),
    false,
  );
});
test("daily 24-hour budget is enforced across projects under concurrent writes", async () => {
  const p1 = (await project()).project.id,
    p2 = (await project()).project.id,
    a = await task(p1),
    b = await task(p2);
  const date = "2026-01-02";
  const r = await Promise.all([
    logTime(member, p1, a.id, 1000, { date }),
    logTime(member, p2, b.id, 1000, { date }),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [201, 409]);
  const s = (
    await call(
      owner,
      "get",
      `/timesheet?from=${date}&to=${date}&scope=team`,
    ).expect(200)
  ).body;
  assert.equal(s.totalMinutes, 1000);
});
test("server timers survive reads, enforce one per person and stop exactly once", async () => {
  const p = (await project()).project.id,
    t = await task(p);
  const timer = (
    await call(member, "post", `/projects/${p}/tasks/${t.id}/timer`)
      .send({})
      .expect(201)
  ).body.timer;
  assert.equal((await sheet(member)).timer.id, timer.id);
  await call(member, "post", `/projects/${p}/tasks/${t.id}/timer`)
    .send({})
    .expect(409);
  await call(owner, "post", `/timer/${timer.id}/stop`).send({}).expect(409);
  await runWorkspace(owner.workspaceId, () =>
    mongoose
      .model("WorkTimer")
      .updateOne(
        { _id: timer.id },
        { $set: { startedAt: new Date(Date.now() - 5 * 60000) } },
      ),
  );
  await call(member, "post", `/timer/${timer.id}/stop`)
    .send({ note: "Timer work" })
    .expect(200);
  await call(member, "post", `/timer/${timer.id}/stop`).send({}).expect(409);
  assert.equal((await sheet(member)).timer, null);
  assert.equal(
    (await sheet(member)).entries.find((e: any) => e.projectId === p).minutes,
    5,
  );
});
test("discarding a running timer writes no time and leaves existing history unchanged", async () => {
  const p = (await project()).project.id,
    t = await task(p),
    prior = (await sheet(member)).totalMinutes;
  const timer = (
    await call(member, "post", `/projects/${p}/tasks/${t.id}/timer`)
      .send({})
      .expect(201)
  ).body.timer;
  await call(member, "post", `/timer/${timer.id}/stop`)
    .send({ discard: true })
    .expect(200);
  assert.equal((await sheet(member)).totalMinutes, prior);
});
test("timesheet filters reject invalid ranges, unknown fields and foreign project identifiers", async () => {
  await call(owner, "get", "/timesheet?from=2026-02-30&to=2026-03-01").expect(
    400,
  );
  await call(owner, "get", "/timesheet?from=2026-01-01&to=2026-12-31").expect(
    400,
  );
  const p = (await project(outsider)).project.id;
  await call(
    owner,
    "get",
    `/timesheet?from=${nowDate}&to=${nowDate}&projectId=${p}`,
  ).expect(404);
});
test("archived projects block planning and new time, but historical reads remain available", async () => {
  const p = (await project()).project.id,
    s = await sprint(p),
    t = await task(p);
  const b = await board(p);
  await call(owner, "patch", `/projects/${p}`)
    .send({
      name: b.project.name,
      description: "",
      leadId: null,
      guestIds: [],
      status: "archived",
      revision: b.project.revision,
    })
    .expect(200);
  await call(owner, "post", `/projects/${p}/sprints`)
    .send(sprintValues)
    .expect(409);
  await (await logTime(member, p, t.id, 30)).expect(409);
  await (await start(p, s)).expect(409);
  await plan(p);
  await call(owner, "get", `/projects/${p}/reports/burndown/${s.id}`).expect(
    200,
  );
});
test("deleting tasks retains logged labels, and project deletion cascades planning and releases daily time budget", async () => {
  const p = (await project()).project.id,
    s = await sprint(p),
    t = await task(p);
  await (await logTime(member, p, t.id, 25)).expect(201);
  let b = await board(p);
  await call(owner, "delete", `/projects/${p}/tasks/${t.id}`)
    .send({ revision: t.revision, boardVersion: b.project.boardVersion })
    .expect(200);
  assert.equal(
    (await sheet(member)).entries.find((e: any) => e.projectId === p).taskTitle,
    t.title,
  );
  b = await board(p);
  await call(owner, "patch", `/projects/${p}`)
    .send({
      name: b.project.name,
      description: "",
      leadId: null,
      guestIds: [],
      status: "archived",
      revision: b.project.revision,
    })
    .expect(200);
  b = await board(p);
  await call(owner, "delete", `/projects/${p}`)
    .send({
      revision: b.project.revision,
      boardVersion: b.project.boardVersion,
    })
    .expect(204);
  assert.equal(
    (await sheet(member)).entries.some((e: any) => e.projectId === p),
    false,
  );
  await runWorkspace(owner.workspaceId, async () => {
    assert.equal(
      await mongoose.model("Sprint").countDocuments({ _id: s.id }),
      0,
    );
  });
});
test("activity and overview obey time privacy for members and shared-project guests", async () => {
  const p = (await project(owner, [guest.id])).project.id,
    t = await task(p);
  await (await logTime(owner, p, t.id, 17)).expect(201);
  const own = (await call(owner, "get", "/activity").expect(200)).body.activity;
  const record = own.find(
    (entry: any) => entry.action === "time.logged" && entry.projectId === p,
  );
  assert.ok(record);
  for (const user of [member, guest])
    for (const path of ["/activity", "/overview"]) {
      const result = (await call(user, "get", path).expect(200)).body;
      assert.equal(
        result.activity.some((entry: any) => entry._id === record._id),
        false,
      );
    }
});

test("all planning and time models fail closed outside tenant context", async () => {
  for (const name of [
    "Sprint",
    "SprintProgress",
    "TimeLog",
    "TimeDay",
    "WorkTimer",
  ])
    await assert.rejects(
      () => mongoose.model(name).find().exec(),
      /workspace context/,
    );
});

test("sprint filter returns only allocated tasks and foreign carryover rolls back completion", async () => {
  const p = (await project()).project.id,
    other = (await project()).project.id;
  const s = await sprint(p),
    foreign = await sprint(other),
    t = await task(p);
  await task(p);
  await (await allocate(p, s.id, [t.id])).expect(200);
  await (await start(p, s)).expect(200);
  const filtered = (
    await call(owner, "get", `/projects/${p}/tasks?sprintId=${s.id}`).expect(
      200,
    )
  ).body;
  assert.deepEqual(
    filtered.tasks.map((x: Task) => x.id),
    [t.id],
  );
  assert.equal(
    (await call(owner, "get", `/projects/${p}/tasks?sprintId=none`).expect(200))
      .body.tasks.length,
    1,
  );
  const active = (await plan(p)).sprints.find((sprint) => sprint.id === s.id)!;
  await (await complete(p, active, foreign.id)).expect(404);
  assert.equal(
    (await plan(p)).sprints.find((sprint) => sprint.id === s.id)!.status,
    "active",
  );
  assert.equal(
    (await board(p)).tasks.find((task) => task.id === t.id)!.sprintId,
    s.id,
  );
});

test("timer stop splits UTC dates, caps abandoned sessions, and concurrent stops do not duplicate entries", async () => {
  const timerUser = await account("timerperson");
  await join(timerUser, "member");
  const p = (await project()).project.id,
    t = await task(p);
  const timer = (
    await call(timerUser, "post", `/projects/${p}/tasks/${t.id}/timer`)
      .send({})
      .expect(201)
  ).body.timer;
  const yesterday = new Date(Date.parse(`${nowDate}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const startedAt = new Date(`${yesterday}T23:58:00Z`);
  await runWorkspace(owner.workspaceId, () =>
    mongoose
      .model("WorkTimer")
      .updateOne({ _id: timer.id }, { $set: { startedAt } }),
  );
  const results = await Promise.all(
    [1, 2].map(() =>
      call(timerUser, "post", `/timer/${timer.id}/stop`).send({}),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const result = (
    await call(
      timerUser,
      "get",
      `/timesheet?from=${yesterday}&to=${nowDate}`,
    ).expect(200)
  ).body;
  assert.equal(result.entries.length, 2);
  assert.equal(result.daily[0].minutes, 2);
  assert.equal(
    result.totalMinutes,
    Math.min(1440, Math.floor((Date.now() - startedAt.getTime()) / 60000)),
  );
});

test("a timer rejected by the daily limit remains recoverable and can be discarded", async () => {
  const user = await account("full-day");
  await join(user, "member");
  const p = (await project()).project.id,
    t = await task(p);
  await (await logTime(user, p, t.id, 1440)).expect(201);
  const timer = (
    await call(user, "post", `/projects/${p}/tasks/${t.id}/timer`)
      .send({})
      .expect(201)
  ).body.timer;
  await call(user, "post", `/timer/${timer.id}/stop`).send({}).expect(409);
  assert.equal((await sheet(user)).timer.id, timer.id);
  assert.equal((await sheet(user)).totalMinutes, 1440);
  await call(user, "post", `/timer/${timer.id}/stop`)
    .send({ discard: true })
    .expect(200);
});

test("an abandoned timer logs at most 24 hours from its actual start date", async () => {
  const user = await account("abandoned-timer");
  await join(user, "member");
  const p = (await project()).project.id,
    t = await task(p);
  const timer = (
    await call(user, "post", `/projects/${p}/tasks/${t.id}/timer`)
      .send({})
      .expect(201)
  ).body.timer;
  const startDate = new Date(Date.parse(`${nowDate}T00:00:00Z`) - 3 * 86400000)
    .toISOString()
    .slice(0, 10);
  await runWorkspace(owner.workspaceId, () =>
    mongoose
      .model("WorkTimer")
      .updateOne(
        { _id: timer.id },
        { $set: { startedAt: new Date(`${startDate}T00:00:00Z`) } },
      ),
  );
  await call(user, "post", `/timer/${timer.id}/stop`).send({}).expect(200);
  const result = (
    await call(
      user,
      "get",
      `/timesheet?from=${startDate}&to=${nowDate}`,
    ).expect(200)
  ).body;
  assert.equal(result.totalMinutes, 1440);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].date, startDate);
});

test("revoked guest grants apply immediately to existing sprint report routes", async () => {
  const p = (await project(owner, [guest.id])).project.id,
    s = await sprint(p),
    b = await board(p);
  await call(guest, "get", `/projects/${p}/reports/burndown/${s.id}`).expect(
    200,
  );
  await call(owner, "patch", `/projects/${p}`)
    .send({
      name: b.project.name,
      description: "",
      leadId: null,
      guestIds: [],
      status: "active",
      revision: b.project.revision,
    })
    .expect(200);
  await call(guest, "get", `/projects/${p}/reports/burndown/${s.id}`).expect(
    404,
  );
});
