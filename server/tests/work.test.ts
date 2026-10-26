import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import { createApp, apiErrorHandler } from "../app.ts";
import { initializeModels } from "../data.ts";
import type { BoardSnapshot, Task, TaskValues } from "../../shared/work.ts";

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
let database: MongoMemoryReplSet;
let owner: Account,
  outsider: Account,
  member: Account,
  admin: Account,
  guest: Account;
const marker = (request: supertest.Test) => request.set("x-orbit-request", "1");
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
  const agent = supertest.agent(app);
  const email = `${name}@example.test`;
  const result = await marker(agent.post("/api/auth/register"))
    .send({ name, email, password: randomBytes(24).toString("hex") })
    .expect(201);
  return { agent, id: result.body.user.id, email, workspaceId: "", token: "" };
}
async function workspace(user: Account, name: string) {
  const result = await marker(user.agent.post("/api/workspaces"))
    .send({ name, slug: name.toLowerCase().replaceAll(" ", "-") })
    .expect(201);
  user.workspaceId = result.body.workspace.id;
  user.token = (
    await marker(
      user.agent.post(`/api/workspaces/${user.workspaceId}/session`),
    ).expect(200)
  ).body.token;
}
async function join(user: Account, role: string) {
  const invitation = await call(owner, "post", "/invites")
    .send({ email: user.email, role })
    .expect(201);
  const token = new URL(invitation.body.url).searchParams.get("invite");
  await marker(user.agent.post("/api/invites/accept"))
    .send({ token })
    .expect(200);
  user.workspaceId = owner.workspaceId;
  user.token = (
    await marker(
      user.agent.post(`/api/workspaces/${user.workspaceId}/session`),
    ).expect(200)
  ).body.token;
}
let projectIndex = 0;
async function newProject(user = owner, extra = {}) {
  const result = await call(user, "post", "/projects")
    .send({
      name: `Project ${++projectIndex}`,
      key: `P${projectIndex}`,
      description: "Private project description",
      ...extra,
    })
    .expect(201);
  return result.body as BoardSnapshot;
}
async function board(projectId: string, user = owner) {
  return (await call(user, "get", `/projects/${projectId}/board`).expect(200))
    .body as BoardSnapshot;
}
async function task(
  projectId: string,
  title: string,
  extra: Record<string, unknown> = {},
  user = owner,
) {
  const current = await board(projectId, user);
  const result = await call(user, "post", `/projects/${projectId}/tasks`)
    .send({ title, boardVersion: current.project.boardVersion, ...extra })
    .expect(201);
  return result.body as BoardSnapshot;
}
function values(task: Task): TaskValues {
  const {
    title,
    description,
    status,
    priority,
    assigneeId,
    labels,
    dueDate,
    estimateHours,
  } = task;
  return {
    title,
    description,
    status,
    priority,
    assigneeId,
    labels,
    dueDate,
    estimateHours,
  };
}
async function editProject(
  projectId: string,
  changes: Record<string, unknown>,
  user = owner,
) {
  const { project } = await board(projectId, user);
  return call(user, "patch", `/projects/${projectId}`).send({
    name: project.name,
    description: project.description,
    leadId: project.leadId,
    guestIds: project.guestIds,
    status: project.status,
    revision: project.revision,
    ...changes,
  });
}
before(
  async () => {
    process.env.MONGOMS_DOWNLOAD_DIR = resolve(".local/mongodb-binaries");
    database = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(database.getUri("orbit-phase2-tests"));
    await initializeModels();
    owner = await account("owner");
    outsider = await account("outsider");
    member = await account("member");
    admin = await account("admin");
    guest = await account("guest");
    await workspace(owner, "Product Team");
    await workspace(outsider, "Separate Team");
    await join(member, "member");
    await join(admin, "admin");
    await join(guest, "guest");
  },
  { timeout: 240000 },
);
after(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

test("project keys are unique per workspace and may be reused in a different workspace", async () => {
  const created = await newProject(owner, { key: "WEB" });
  await call(owner, "post", "/projects")
    .send({ name: "Duplicate key", key: "WEB" })
    .expect(409);
  await newProject(outsider, { key: "WEB" });
  assert.equal(created.project.key, "WEB");
});
test("only owners and admins can create or update projects", async () => {
  for (const user of [member, guest])
    await call(user, "post", "/projects")
      .send({ name: "Forbidden", key: "NO" })
      .expect(403);
  const created = await newProject(admin);
  const response = await editProject(
    created.project.id,
    { name: "Admin renamed project" },
    admin,
  );
  assert.equal(response.status, 200);
  const forbidden = await editProject(
    created.project.id,
    { name: "Member rename" },
    member,
  );
  assert.equal(forbidden.status, 403);
});
test("foreign project IDs cannot be read, modified, or used to create tasks", async () => {
  const foreign = await newProject(outsider);
  await call(owner, "get", `/projects/${foreign.project.id}/board`).expect(404);
  await call(owner, "patch", `/projects/${foreign.project.id}`)
    .send({
      name: "No",
      description: "",
      leadId: null,
      guestIds: [],
      status: "active",
      revision: 0,
    })
    .expect(404);
  await call(owner, "post", `/projects/${foreign.project.id}/tasks`)
    .send({ title: "Injected task", boardVersion: 0 })
    .expect(404);
  const list = await call(owner, "get", "/projects").expect(200);
  assert.ok(!list.body.projects.some((p: any) => p.id === foreign.project.id));
});
test("guest cannot discover private projects through project lists, activity, or overview", async () => {
  const created = await newProject(owner, { name: "Secret launch project" });
  await task(created.project.id, "Confidential task title");
  for (const path of ["/projects", "/activity", "/overview"]) {
    const response = await call(guest, "get", path).expect(200);
    const text = JSON.stringify(response.body);
    assert.ok(!text.includes("Secret launch project"));
    assert.ok(!text.includes("Confidential task title"));
  }
  await call(guest, "get", `/projects/${created.project.id}/board`).expect(404);
});
test("explicitly shared guest access is read-only and revocable", async () => {
  const created = await newProject();
  const id = created.project.id;
  assert.equal((await editProject(id, { guestIds: [guest.id] })).status, 200);
  await call(guest, "get", `/projects/${id}/board`).expect(200);
  await call(guest, "post", `/projects/${id}/tasks`)
    .send({ title: "No guest edits", boardVersion: 1 })
    .expect(403);
  const list = await call(guest, "get", "/projects").expect(200);
  assert.ok(list.body.projects.some((p: any) => p.id === id));
  assert.equal((await editProject(id, { guestIds: [] })).status, 200);
  await call(guest, "get", `/projects/${id}/board`).expect(404);
});
test("project leads and guest grants must belong to the workspace and have the right roles", async () => {
  await call(owner, "post", "/projects")
    .send({ name: "Invalid lead", key: "BAD", leadId: outsider.id })
    .expect(400);
  await call(owner, "post", "/projects")
    .send({ name: "Guest lead", key: "BAD", leadId: guest.id })
    .expect(400);
  await call(owner, "post", "/projects")
    .send({ name: "Member grant", key: "BAD", guestIds: [member.id] })
    .expect(400);
  await call(owner, "post", "/projects")
    .send({ name: "Foreign guest", key: "BAD", guestIds: [outsider.id] })
    .expect(400);
});
test("workspace ownership, immutable project key, and task reparenting cannot be injected", async () => {
  await call(owner, "post", "/projects")
    .send({
      name: "Wrong workspace",
      key: "BAD",
      workspaceId: outsider.workspaceId,
    })
    .expect(400);
  const { project } = await newProject();
  const patch = {
    name: project.name,
    description: "",
    status: "active",
    revision: 0,
    key: "OTHER",
  };
  await call(owner, "patch", `/projects/${project.id}`).send(patch).expect(400);
  await call(owner, "post", `/projects/${project.id}/tasks`)
    .send({
      title: "Injected",
      boardVersion: 0,
      workspaceId: outsider.workspaceId,
    })
    .expect(400);
});
test("members can create tasks with validated properties and normalized labels", async () => {
  const { project } = await newProject();
  const result = await task(
    project.id,
    "Implement navigation",
    {
      description: "Accessible keyboard navigation",
      priority: "high",
      assigneeId: member.id,
      labels: ["Design", "design", " UI "],
      dueDate: "2027-01-15",
      estimateHours: 3.5,
    },
    member,
  );
  const created = result.tasks[0];
  assert.equal(created.assigneeId, member.id);
  assert.deepEqual(created.labels, ["design", "ui"]);
  assert.equal(created.dueDate, "2027-01-15");
  assert.equal(created.estimateHours, 3.5);
  assert.equal(created.revision, 0);
  assert.equal(result.project.boardVersion, 1);
});
test("foreign, guest, and missing assignees are rejected without changing the board", async () => {
  const { project } = await newProject();
  for (const assigneeId of [
    outsider.id,
    guest.id,
    new mongoose.Types.ObjectId().toString(),
  ])
    await call(owner, "post", `/projects/${project.id}/tasks`)
      .send({ title: "Invalid assignment", assigneeId, boardVersion: 0 })
      .expect(400);
  const current = await board(project.id);
  assert.equal(current.tasks.length, 0);
  assert.equal(current.project.boardVersion, 0);
});
test("invalid dates, estimates, empty titles, and excessive labels are rejected", async () => {
  const { project } = await newProject();
  for (const bad of [
    { dueDate: "2026-02-30" },
    { dueDate: "not-a-date" },
    { estimateHours: -1 },
    { estimateHours: 10001 },
    { title: " " },
    { labels: Array.from({ length: 9 }, (_, index) => `label-${index}`) },
  ])
    await call(owner, "post", `/projects/${project.id}/tasks`)
      .send({ title: "Invalid properties", boardVersion: 0, ...bad })
      .expect(400);
});
test("task update preserves identifiers and rejects stale task revisions", async () => {
  const { project } = await newProject();
  const first = await task(project.id, "Original title");
  const original = first.tasks[0];
  const changed = await call(
    member,
    "patch",
    `/projects/${project.id}/tasks/${original.id}`,
  )
    .send({
      ...values(original),
      title: "Updated title",
      revision: 0,
      boardVersion: first.project.boardVersion,
    })
    .expect(200);
  const current = changed.body as BoardSnapshot;
  assert.equal(current.tasks[0].revision, 1);
  assert.equal(current.tasks[0].number, original.number);
  await call(owner, "patch", `/projects/${project.id}/tasks/${original.id}`)
    .send({
      ...values(original),
      title: "Stale overwrite",
      revision: 0,
      boardVersion: current.project.boardVersion,
    })
    .expect(409);
  assert.equal((await board(project.id)).tasks[0].title, "Updated title");
});
test("task IDs are checked against their project as well as their tenant", async () => {
  const a = await newProject();
  const b = await newProject();
  const created = await task(a.project.id, "Belongs to A");
  const target = created.tasks[0];
  await call(
    owner,
    "patch",
    `/projects/${b.project.id}/tasks/${target.id}/move`,
  )
    .send({ status: "done", beforeId: null, boardVersion: 0 })
    .expect(404);
  await call(owner, "patch", `/projects/${b.project.id}/tasks/${target.id}`)
    .send({ ...values(target), revision: 0, boardVersion: 0 })
    .expect(404);
  await call(owner, "delete", `/projects/${b.project.id}/tasks/${target.id}`)
    .send({ revision: 0, boardVersion: 0 })
    .expect(404);
});
test("same-column reorder and cross-column moves maintain dense, distinct order", async () => {
  const { project } = await newProject();
  await task(project.id, "First");
  await task(project.id, "Second");
  const current = await task(project.id, "Third");
  const first = current.tasks.find((t) => t.title === "First")!;
  const third = current.tasks.find((t) => t.title === "Third")!;
  const moved = (
    await call(owner, "patch", `/projects/${project.id}/tasks/${third.id}/move`)
      .send({
        status: "todo",
        beforeId: first.id,
        boardVersion: current.project.boardVersion,
      })
      .expect(200)
  ).body as BoardSnapshot;
  assert.deepEqual(
    moved.tasks
      .filter((t) => t.status === "todo")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.title),
    ["Third", "First", "Second"],
  );
  const across = (
    await call(owner, "patch", `/projects/${project.id}/tasks/${first.id}/move`)
      .send({
        status: "in_progress",
        beforeId: null,
        boardVersion: moved.project.boardVersion,
      })
      .expect(200)
  ).body as BoardSnapshot;
  assert.deepEqual(
    across.tasks
      .filter((t) => t.status === "todo")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.order),
    [0, 1],
  );
  assert.equal(across.tasks.find((t) => t.id === first.id)!.order, 0);
});
test("concurrent moves from the same board version yield one success and one conflict", async () => {
  const { project } = await newProject();
  await task(project.id, "Concurrent A");
  const current = await task(project.id, "Concurrent B");
  const responses = await Promise.all(
    current.tasks.map((t) =>
      call(owner, "patch", `/projects/${project.id}/tasks/${t.id}/move`).send({
        status: "in_progress",
        beforeId: null,
        boardVersion: current.project.boardVersion,
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const after = await board(project.id);
  assert.equal(after.project.boardVersion, current.project.boardVersion + 1);
  assert.equal(after.tasks.filter((t) => t.status === "in_progress").length, 1);
  assert.equal(after.tasks.filter((t) => t.status === "todo").length, 1);
});
test("stale board versions reject create, edit, move, and delete without partial changes", async () => {
  const { project } = await newProject();
  const current = await task(project.id, "Protected from stale board");
  const existing = current.tasks[0];
  await call(owner, "post", `/projects/${project.id}/tasks`)
    .send({ title: "Stale creation", boardVersion: 0 })
    .expect(409);
  await call(owner, "patch", `/projects/${project.id}/tasks/${existing.id}`)
    .send({
      ...values(existing),
      title: "Stale edit",
      revision: 0,
      boardVersion: 0,
    })
    .expect(409);
  await call(
    owner,
    "patch",
    `/projects/${project.id}/tasks/${existing.id}/move`,
  )
    .send({ status: "done", beforeId: null, boardVersion: 0 })
    .expect(409);
  await call(owner, "delete", `/projects/${project.id}/tasks/${existing.id}`)
    .send({ revision: 0, boardVersion: 0 })
    .expect(409);
  const after = await board(project.id);
  assert.equal(after.project.boardVersion, 1);
  assert.equal(after.tasks.length, 1);
  assert.equal(after.tasks[0].title, existing.title);
});
test("invalid drop targets roll back the board lock and preserve task state", async () => {
  const { project } = await newProject();
  const current = await task(project.id, "Rollback");
  const target = current.tasks[0];
  await call(owner, "patch", `/projects/${project.id}/tasks/${target.id}/move`)
    .send({
      status: "done",
      beforeId: new mongoose.Types.ObjectId().toString(),
      boardVersion: 1,
    })
    .expect(400);
  const after = await board(project.id);
  assert.equal(after.project.boardVersion, 1);
  assert.equal(after.tasks[0].status, "todo");
});
test("completion records a timestamp, preserves it on edits, and clears it on reopen", async () => {
  const { project } = await newProject();
  let current = await task(project.id, "Complete and reopen");
  const taskId = current.tasks[0].id;
  current = (
    await call(owner, "patch", `/projects/${project.id}/tasks/${taskId}/move`)
      .send({
        status: "done",
        beforeId: null,
        boardVersion: current.project.boardVersion,
      })
      .expect(200)
  ).body;
  const completedAt = current.tasks[0].completedAt;
  assert.ok(completedAt);
  current = (
    await call(owner, "patch", `/projects/${project.id}/tasks/${taskId}`)
      .send({
        ...values(current.tasks[0]),
        title: "Completed with context",
        revision: current.tasks[0].revision,
        boardVersion: current.project.boardVersion,
      })
      .expect(200)
  ).body;
  assert.equal(current.tasks[0].completedAt, completedAt);
  current = (
    await call(owner, "patch", `/projects/${project.id}/tasks/${taskId}/move`)
      .send({
        status: "todo",
        beforeId: null,
        boardVersion: current.project.boardVersion,
      })
      .expect(200)
  ).body;
  assert.equal(current.tasks[0].completedAt, null);
});
test("subtasks belong to a top-level parent in the same project and do not inflate project counts", async () => {
  const { project } = await newProject();
  let current = await task(project.id, "Parent");
  const parentId = current.tasks[0].id;
  current = await task(project.id, "Child", { parentTaskId: parentId });
  const child = current.tasks.find((t) => t.parentTaskId)!;
  assert.equal(current.project.taskCount, 1);
  assert.equal(current.tasks.length, 2);
  await call(owner, "post", `/projects/${project.id}/tasks`)
    .send({
      title: "Grandchild",
      parentTaskId: child.id,
      boardVersion: current.project.boardVersion,
    })
    .expect(400);
  const other = await newProject();
  await call(owner, "post", `/projects/${other.project.id}/tasks`)
    .send({ title: "Foreign child", parentTaskId: parentId, boardVersion: 0 })
    .expect(404);
});
test("members can edit team tasks but cannot delete a task created by someone else", async () => {
  const { project } = await newProject();
  const current = await task(project.id, "Owned by manager");
  const target = current.tasks[0];
  await call(member, "delete", `/projects/${project.id}/tasks/${target.id}`)
    .send({ revision: 0, boardVersion: current.project.boardVersion })
    .expect(403);
  await call(member, "patch", `/projects/${project.id}/tasks/${target.id}`)
    .send({
      ...values(target),
      priority: "urgent",
      revision: 0,
      boardVersion: current.project.boardVersion,
    })
    .expect(200);
});
test("deleting a parent cascades its children and does not reuse task numbers", async () => {
  const { project } = await newProject();
  let current = await task(project.id, "Parent to delete");
  const parent = current.tasks[0];
  current = await task(project.id, "Child to delete", {
    parentTaskId: parent.id,
  });
  const result = await call(
    owner,
    "delete",
    `/projects/${project.id}/tasks/${parent.id}`,
  )
    .send({
      revision: parent.revision,
      boardVersion: current.project.boardVersion,
    })
    .expect(200);
  assert.equal(result.body.tasks.length, 0);
  const next = await task(project.id, "Next task");
  assert.equal(next.tasks[0].number, 3);
});
test("members cannot cascade-delete subtasks created by teammates", async () => {
  const { project } = await newProject();
  let current = await task(project.id, "Member parent", {}, member);
  const parent = current.tasks[0];
  current = await task(project.id, "Manager subtask", {
    parentTaskId: parent.id,
  });
  await call(member, "delete", `/projects/${project.id}/tasks/${parent.id}`)
    .send({
      revision: parent.revision,
      boardVersion: current.project.boardVersion,
    })
    .expect(403);
  assert.equal((await board(project.id)).tasks.length, 2);
});
test("project details use a revision check to reject stale overwrites", async () => {
  const { project } = await newProject();
  assert.equal(
    (await editProject(project.id, { name: "Latest name" })).status,
    200,
  );
  const response = await editProject(project.id, {
    name: "Stale name",
    revision: 0,
  });
  assert.equal(response.status, 409);
  assert.equal((await board(project.id)).project.name, "Latest name");
});
test("archived projects keep data readable but block task mutations until restored", async () => {
  const { project } = await newProject();
  const current = await task(project.id, "Archived task");
  const target = current.tasks[0];
  const archived = await editProject(project.id, { status: "archived" });
  assert.equal(archived.status, 200);
  const version = archived.body.project.boardVersion;
  await call(member, "get", `/projects/${project.id}/board`).expect(200);
  await call(owner, "post", `/projects/${project.id}/tasks`)
    .send({ title: "No", boardVersion: version })
    .expect(409);
  await call(owner, "patch", `/projects/${project.id}/tasks/${target.id}`)
    .send({ ...values(target), revision: 0, boardVersion: version })
    .expect(409);
  await call(owner, "patch", `/projects/${project.id}/tasks/${target.id}/move`)
    .send({ status: "done", beforeId: null, boardVersion: version })
    .expect(409);
  await call(owner, "delete", `/projects/${project.id}/tasks/${target.id}`)
    .send({ revision: 0, boardVersion: version })
    .expect(409);
  assert.equal(
    (await editProject(project.id, { status: "active" })).status,
    200,
  );
  await task(project.id, "Allowed after restore");
});
test("project deletion requires archive, current versions, and manager access, then deletes tasks atomically", async () => {
  const { project } = await newProject();
  const current = await task(project.id, "Cascade task");
  await call(owner, "delete", `/projects/${project.id}`)
    .send({ revision: 0, boardVersion: current.project.boardVersion })
    .expect(409);
  const archived = (await editProject(project.id, { status: "archived" }))
    .body as BoardSnapshot;
  await call(member, "delete", `/projects/${project.id}`)
    .send({
      revision: archived.project.revision,
      boardVersion: archived.project.boardVersion,
    })
    .expect(403);
  await call(owner, "delete", `/projects/${project.id}`)
    .send({ revision: 0, boardVersion: archived.project.boardVersion })
    .expect(409);
  await call(owner, "delete", `/projects/${project.id}`)
    .send({
      revision: archived.project.revision,
      boardVersion: archived.project.boardVersion,
    })
    .expect(204);
  await call(owner, "get", `/projects/${project.id}/board`).expect(404);
});
test("task history captures before/after transitions for future reports", async () => {
  const { project } = await newProject();
  const current = await task(project.id, "Historical event");
  const target = current.tasks[0];
  await call(owner, "patch", `/projects/${project.id}/tasks/${target.id}/move`)
    .send({
      status: "in_progress",
      beforeId: null,
      boardVersion: current.project.boardVersion,
    })
    .expect(200);
  const activity = await call(owner, "get", "/activity").expect(200);
  const moved = activity.body.activity.find(
    (event: any) =>
      event.action === "task.moved" && event.meta?.taskId === target.id,
  );
  assert.equal(moved.meta.before.status, "todo");
  assert.equal(moved.meta.after.status, "in_progress");
  assert.equal(moved.projectId, project.id);
});
test("filtered task API combines validated filters and enforces project access", async () => {
  const { project } = await newProject();
  await task(project.id, "Matching design task", {
    assigneeId: member.id,
    priority: "high",
    labels: ["design"],
    description: "Keyboard navigation is required.",
  });
  await task(project.id, "Different assignment", {
    priority: "high",
    labels: ["design"],
  });
  const query = new URLSearchParams({
    status: "todo",
    assignee: member.id,
    priority: "high",
    label: "DESIGN",
    q: "keyboard",
  });
  const response = await call(
    member,
    "get",
    `/projects/${project.id}/tasks?${query}`,
  ).expect(200);
  assert.deepEqual(
    response.body.tasks.map((task: Task) => task.title),
    ["Matching design task"],
  );
  await call(guest, "get", `/projects/${project.id}/tasks`).expect(404);
  await call(
    member,
    "get",
    `/projects/${project.id}/tasks?status=unknown`,
  ).expect(400);
  await call(
    member,
    "get",
    `/projects/${project.id}/tasks?workspaceId=${outsider.workspaceId}`,
  ).expect(400);
});

test("both new tenant models fail closed when queried without workspace context", async () => {
  for (const name of ["Project", "Task"])
    await assert.rejects(
      () => mongoose.model(name).find().exec(),
      /workspace context/,
    );
});
