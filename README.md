# Orbit — Project Management SaaS

Phases 1–4 of the supplied **Project 13: Project Management SaaS with Multi-Tenant Workspaces** brief, implemented locally.

## Run locally

For the temporary hosted preview, see [preview deployment](docs/preview-deployment.md) and `render.yaml`. Preview mode can use MongoDB for durable attachments and explicit link-only invitations. It retains production authentication and tenant checks; the rest of Phase 5 is still outstanding.

Requires Node.js 22.12+ (verified here with Node 24). From this folder:

```powershell
npm ci
npm run dev
```

Open **http://localhost:4173**. Create an account and then a workspace. No external credentials are required for local development. First startup downloads an official MongoDB binary using `mongodb-memory-server`; despite that package's name, this application's development database uses WiredTiger **on disk**, not volatile memory. Internet access is required for the initial download.

The local database uses loopback port **27028**. Application data is in `.local/database/`, and the local signing secret is in `.local/session-secret`. Both are ignored by Git. Keep them to retain local accounts and workspaces. Run only one development server for this checkout at a time; stop it with Ctrl+C.

The browser preview may contain two clearly named test accounts (`Preview Owner` and `Preview Teammate`) and the workspaces `Studio North` and `Field Notes`, created during UI verification. These are local review fixtures. Sign out and create your own account to begin; no shared demo password is embedded in the source.

## Phase 1: implemented

- Registration, sign-in, sign-out, persisted sessions, salted scrypt password hashes.
- HttpOnly, SameSite=Strict session cookies; Secure cookies in production. Signing keys are never shipped to the browser.
- Workspace creation, unique addresses, switching, editable name/description, owner membership.
- Server-checked owner/admin/member/guest roles. Current membership is rechecked for every scoped request.
- Members view, search, role changes, removal, and owner protection.
- Signed, email-bound, single-use invitations with a 48-hour lifetime, revocation, and transactional acceptance.
- Copyable invitation links and acceptance UI. Phase 3 adds queued email, a private local mailbox, and configurable SMTP delivery.
- Activity history for workspace and membership changes, created in the same transactions as those changes.
- Responsive overview, members, activity, settings, onboarding, accessible modal dialogs, keyboard focus, reduced motion.
- Central tenant guard, API validation, request-origin checks, request IDs, structured logs that exclude cookies, workspace tokens, invitation query strings, and request bodies.

## Phase 2: implemented

- Project creation, names/descriptions, immutable project keys, project leads, search, active/archive filters, archive/restore, and deletion of archived projects with typed confirmation.
- Kanban board and list view, backed by the same saved task data. Fixed statuses: Backlog, To do, In progress, Done.
- Tasks with title, description, assignee, priority, labels, due date, estimate, and stable project task numbers.
- Text search across task code, title, description, and labels; filters for status, priority, assignee, and label. The interface filters a loaded board snapshot; a validated filtered task API is also available.
- One level of subtasks, completion tracking, and editing through the same task panel. Subtasks are not counted as separate top-level board cards.
- Pointer and keyboard dragging. Clear filters to reorder; a task's editor can change status while filtered.
- Board version checks, task revisions, transactional ordering, and conflict handling that preserves an unsaved task draft and offers an explicit reload.
- Owner/admin project management; members can edit tasks and delete their own tasks; guests have read-only access to explicitly shared projects.
- Guest project access applies to activity as well as projects/tasks. Private project names and task history do not appear in guest workspace feeds.
- Task history retains before/after properties and completion timestamps for later reporting work.

## Phase 3: implemented

- Authenticated Socket.IO connections on `/api/socket.io`, automatic board/project refresh, live comments, notification refresh, reconnect resynchronization, and a visible connection state.
- Current cookie session, workspace token, membership, and project access are checked before sending a change signal. Client messages cannot mutate tasks or join arbitrary rooms. Logout and member removal revoke existing connections.
- Comments with selected `@mentions`, edit revisions, author/manager deletion rules, and activity logging. Read-only guests can read shared project comments; archived projects reject writes.
- Persistent per-user mention/assignment notifications, unread counts, mark-read controls, task links, and My Tasks across active projects in the current workspace.
- Guarded attachment upload/download/removal, 10 MB/file and 20 files/task limits, common-file signature checks, and download-as-attachment headers. Object keys remain private. Local files persist in `.local/uploads` by default; a private S3 adapter is configurable.
- Transactional encrypted invitation-email queue, expiring jobs, cancelled revoked invitations, SMTP transport, bounded retries, manager retry controls, and a private local-mail preview. With no SMTP configuration, no external email is sent.
- Optional Redis adapter for multi-server Socket.IO coordination. Single-server local development does not require Redis.

External SMTP, S3, and Redis services are **not configured or live-verified** in this checkout. SMTP wire behavior was verified against a local test server; S3 command behavior uses a fixture. See the phase-3 verification record for exact evidence and limits.

## Phase 4: implemented

- Sprints with names, goals, UTC start/end dates, planned/active/completed states, revision checks, and at most one active sprint per project. Owners/admins manage sprint scope and lifecycle; members can read it, and guests can read explicitly shared projects.
- Bulk task allocation, a sprint filter on the project board/list and task API, and completion with unfinished work carried to a planned sprint or out of sprint scope. Task status is preserved during carryover. Subtasks follow their parent and do not inflate sprint totals.
- Transactional sprint progress records for status, reopening, estimate and scope changes, and task deletion. Daily burndown uses the last saved state each UTC date, with future days blank. Raw progress history is available beneath the chart. History begins when a sprint starts; earlier work is not backfilled.
- Velocity for the last 12 completed sprints. Completion totals are frozen, so later task edits cannot rewrite the result. Velocity counts completed top-level tasks and also shows estimated hours; it is not logged time or story points.
- Workload by assignee, including unassigned work, estimates, unestimated tasks and overdue counts. It counts open top-level tasks and full estimates, not capacity or remaining effort. Guests cannot read workload.
- Manual time entries with notes, own-entry editing/removal, revisions, and a transactionally enforced 24-hour limit per person/UTC date across the workspace. Members see their own timesheets; owners/admins can review team totals and filter by person/project/date. Managers cannot edit another person's recorded time.
- Server-persisted timers, one per person/workspace, with stop/save and discard. Timers survive browser reloads and server restarts. Saving rounds down to whole minutes with a 1-minute minimum, caps abandoned sessions at 24 hours from their start, and splits UTC dates. A failed daily-limit save retains the timer for correction or discard.
- Task deletion retains logged time and its task labels but cancels a timer on that deleted task. Archived projects retain readable history and reject planning/time edits; an existing timer can be discarded or saved after restoring the project. Explicit project deletion cascades its planning/time records and releases their daily budget.

Password recovery, email verification, Sentry, cloud hosting, and live external-service verification remain for later work. This is a local project, not a production deployment.

## Phases

| Phase | Scope                                                                                                 | Status              |
| ----- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| 1     | Identity, workspaces, permissions, tenant isolation, members, local invitations, interface foundation | Implemented locally |
| 2     | Projects, tasks, board/list views, filters, subtasks, conflict-safe ordering                          | Implemented locally |
| 3     | Socket.io collaboration, email delivery, comments, mentions, notifications, attachments, My Tasks     | Implemented locally |
| 4     | Sprint planning, time logs/timesheets, historical burndown, velocity, workload reports                | Implemented locally |
| 5     | External services, staging/production, Sentry, deployment, live multi-device and tenant checks        | Planned             |

The document's stretch goals (Gantt/dependencies, Stripe, public API/webhooks, advanced infrastructure) remain separate.

## Permission rules

| Action                                                      | Owner | Admin | Member         | Guest                      |
| ----------------------------------------------------------- | ----- | ----- | -------------- | -------------------------- |
| Read workspace, members, activity                           | Yes   | Yes   | Yes            | Yes                        |
| Edit workspace details                                      | Yes   | Yes   | No             | No                         |
| Invite members/guests                                       | Yes   | Yes   | No             | No                         |
| Invite or manage admins                                     | Yes   | No    | No             | No                         |
| Manage non-admin members                                    | Yes   | Yes   | No             | No                         |
| Remove/demote owner                                         | No    | No    | No             | No                         |
| Read projects/tasks                                         | All   | All   | All            | Explicitly shared projects |
| Create/edit/archive/delete projects and change guest grants | Yes   | Yes   | No             | No                         |
| Create/edit/move tasks in active projects                   | Yes   | Yes   | Yes            | No                         |
| Delete tasks in active projects                             | Any   | Any   | Own tasks only | No                         |

Managers cannot change their own role; another authorised manager must do it. A removed member's existing workspace token immediately fails on their next request. A member cannot delete a parent if that would also delete a teammate's subtasks. Only current non-guest members can be leads or assignees. Workspace ownership transfer and workspace deletion remain outside this phase. Deleting a project requires it to be archived first and cascades its tasks transactionally.

## Isolation design

The session JWT identifies a user and a revocable database session. A second JWT, held only in browser memory, identifies the active workspace and is bound to that same user/session. It lasts one hour and is renewed by the client as needed. The server requires token, path, session, and current database membership to agree.

`server/tenant.ts` uses AsyncLocalStorage and a Mongoose plugin. Tenant collection operations fail without a workspace context, receive an injected workspace filter, and cannot change workspace ownership. Aggregations receive a leading workspace match; cross-collection pipelines and bulk writes are blocked pending explicit implementations. Document saves, inserts, and deletes are also guarded. Lazy Mongoose queries are awaited **inside** the context.

`server/data.ts` keeps raw models private. User and session records are global identity records. The Workspace root is loaded only after membership checks (and is created transactionally with owner membership). Limited system-scope membership queries are confined to the identity/bootstrap data functions. Application handlers must not use raw MongoDB collections or bypass the data layer. Every future tenant-owned model, including TimeLog and attachments, must have a workspaceId and the guard.

The UI clears old workspace data immediately on switching and uses a generation/context check to discard late responses from a previous workspace.

Live events are invalidation signals, not authoritative task payloads. Successful mutation responses trigger publication after their database transactions have committed; clients refetch through guarded HTTP routes. Reads and failed/rolled-back writes do not publish committed-change events. Disconnections can miss signals; reconnect fetches current state. This is not a durable event-delivery system. Unsaved task/comment drafts are retained during live refreshes; task conflicts require explicit review/reload.

Comments, notifications, attachments, invitation mail, and file-deletion jobs use the same tenant plugin. File deletion is queued transactionally and retried by the background worker. Task/project deletion cascades collaboration metadata. Files written immediately before a process crash can still become orphaned; production storage needs an orphan-audit/lifecycle strategy. Attachments are delivered through an authenticated proxy rather than publicly accessible or long-lived signed links. No malware scanner is integrated.

Invitation jobs store their message/link encrypted using a key derived from the signing secret. Rotating that secret invalidates sessions and also requires draining or re-encrypting pending mail first. Delivery is at-least-once around worker crashes, while invitation acceptance remains single-use. SMTP errors retain a failed job and retry with backoff up to five attempts; manager retry can requeue an active invitation. Local previews are manager-only and unavailable in SMTP mode. Email jobs expire with their invitations.

`server/work-data.ts` keeps Project and Task models private and applies the same central guard. Project access checks precede task reads/writes. Every task mutation takes an expected `boardVersion` and updates the Project within the same transaction, serializing competing changes. Task detail edits also take a task `revision`; project settings take a separate project revision. Conflicts return HTTP 409 rather than silently overwriting newer data. A board snapshot reads project version and tasks under snapshot read concern. Dense ordering is maintained within each status and parent group; this implementation targets small-to-medium educational project boards and has not been load-tested at large scale.

Protected phase-2 routes are under `/api/w/:workspaceId`: `GET/POST /projects`, `GET /projects/:projectId/board`, `PATCH/DELETE /projects/:projectId`, `GET/POST /projects/:projectId/tasks`, `PATCH/DELETE /projects/:projectId/tasks/:taskId`, and `PATCH /projects/:projectId/tasks/:taskId/move`. The task listing accepts `status`, `assignee` (user ID or `unassigned`), `priority`, `label`, `q`, optional `parentTaskId`, and `sprintId` (ID or `none`). Edit endpoints use complete editable values plus expected revisions, not arbitrary database update objects.

Phase-4 routes share that workspace guard: `GET/POST /projects/:projectId/sprints`, `PATCH /projects/:projectId/sprints/:sprintId`, `PATCH /projects/:projectId/sprint-tasks`, and `POST /projects/:projectId/sprints/:sprintId/start` or `/complete`. Reports are `GET /projects/:projectId/reports/burndown/:sprintId`, `/velocity`, and `/workload`. Time entry routes are `POST /projects/:projectId/tasks/:taskId/time`, `PATCH/DELETE /time/:id`, and `GET /timesheet?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=mine|team` (optional projectId/userId; up to 92 days and 10,000 entries). Timers use `POST /projects/:projectId/tasks/:taskId/timer` and `POST /timer/:id/stop`.

## Verify

```powershell
npm test
npm run build
npm audit --omit=dev
```

Tests use a separate temporary MongoDB replica set and never delete or modify the local development database. Coverage includes two independent owners/workspaces, member/guest/admin restrictions, stale permissions, cross-tenant resource IDs, owner protection, signed/expired/revoked invitations, concurrent single-use acceptance, logout revocation, CSRF checks, and direct tenant guard probes.

Phase 2 adds project/task tenant checks, explicit guest grants and hidden activity, assignment validation, concurrent/stale board mutations, task and project revisions, ordering, subtasks, history, archive/restore, and transactional deletion. See `docs/phase-2-verification.md` for exact verification and limits.

Phase 3 added authenticated live connections, comments/mentions, recipient-only notifications, My Tasks, private files, encrypted mail jobs, SMTP transport and retries, and collaboration cleanup. Its delivery passed 82 tests. See [phase-3 verification](docs/phase-3-verification.md) for browser evidence and external-service limits.

Phase 4 adds 27 planning/time/report tests, bringing the combined suite to 109. See [phase-4 verification](docs/phase-4-verification.md) for browser checks, restart persistence, responsive evidence, report definitions, and limits. Time activity follows the same privacy rules as timesheets: members see their own entries, managers see team entries, and guests do not see time events.

The build runs strict TypeScript checking, builds the React frontend, and bundles the Node server. It does not deploy anything. Preview deployment preparation adds seven tests for durable MongoDB attachments, explicit disabled email delivery, and production cookie/origin protections (116 tests total).

## Production preparation (phase 5)

Copy `.env.example` to `.env`, supply a real MongoDB **replica set** URI (Atlas supports transactions), a distinct random secret of at least 32 characters, and the final HTTPS origin. Set `NODE_ENV=production`, build, and run `npm start`. Production startup refuses the automatic local database and missing configuration.

The current deployment shape serves frontend and API from one origin. The brief's split Vercel + Render/Railway hosting requires a reviewed same-origin API and WebSocket proxy or a reviewed cross-origin cookie/CSRF configuration; simply changing the API URL is insufficient. Configure proxy trust for the known hosting topology before relying on IP-based rate limits behind a reverse proxy. Staging must have a separate database and signing secret. Configure and verify external services, add monitoring, and complete live two-device tests before calling this production-ready.

Configure SMTP/S3/Redis using the names in `.env.example`; keep real values in an untracked `.env` or your host's secret store. Production requires SMTP unless `INVITATION_EMAIL_MODE=disabled` explicitly enables link-only invitations. Durable files require S3, a persistent `UPLOAD_DIRECTORY`, or `FILE_STORAGE=mongodb` for a small preview. Keep the S3 bucket private. Use a dedicated authenticated Redis instance with TLS for remote access. Multi-server setups need shared durable storage and Redis; local folders belong to single-server setups. Socket.IO here uses WebSockets in the browser, so the host must support upgrades at `/api/socket.io`. Redis coordination is implemented but has not been exercised against a real Redis deployment here. See the preview deployment guide for the limited free-hosting setup.

The local fallback is for development only: it binds to loopback and does not enable database authentication. Do not expose it to a network.

## Source map

- `src/main.tsx`: React application and interaction flows.
- `src/styles.css`: responsive visual system.
- `src/api.ts`: API client and shared client types.
- `src/work/WorkArea.tsx`: project views, board/list interactions, filters, task panel, subtasks, and conflict handling.
- `src/work/work.css`: responsive project/board/task styles.
- `shared/work.ts`: work domain types and status/priority definitions.
- `server/app.ts`: endpoints, authentication, permissions, validation, and HTTP protections.
- `server/data.ts`: private data models and transactional operations.
- `server/tenant.ts`: central isolation guard.
- `server/database.ts`: external/local database startup and local secret persistence.
- `server/tests/security.test.ts`: integration and guard tests.
- `server/work-data.ts`: project/task models, permission checks, and transactional ordering.
- `server/work-routes.ts`: validated project/task endpoints.
- `server/tests/work.test.ts`: phase-2 integration tests.
- `src/collaboration/`: live connection hook, comments/files, inbox, My Tasks, and mail preview UI.
- `server/collaboration-data.ts` and `server/collaboration-routes.ts`: guarded collaboration persistence and endpoints.
- `server/realtime.ts`: authenticated live connections, current permission checks, and optional Redis coordination.
- `server/mail.ts`: encrypted invitation jobs and local/SMTP delivery worker.
- `server/storage.ts`: persistent local files, S3 adapter, and file validation.
- `server/tests/collaboration.test.ts`: phase-3 integration and transport tests.
- `src/planning/Planning.tsx` and `planning.css`: sprint planning, timesheets/timers, reports and charts.
- `shared/planning.ts`: public planning/time/report types.
- `server/planning-data.ts`: private tenant models, sprint history, timer/time budgets, and reporting queries.
- `server/planning-routes.ts`: validated planning/time/report endpoints.
- `server/tests/planning.test.ts`: phase-4 permissions, lifecycle, concurrency, history, time/timer, and guard tests.

Technical references: [Express middleware](https://expressjs.com/en/guide/using-middleware/), [Mongoose transactions](https://mongoosejs.com/docs/transactions.html), [Vite](https://vite.dev/guide/).
