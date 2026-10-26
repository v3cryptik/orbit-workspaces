# Phase 4 verification

Orbit 0.4.0, verified locally on 26 October 2026 (Asia/Calcutta). No publishing or cloud deployment was performed.

## Delivered

- Sprint planning with goals/dates, revision checks, bulk allocation, one active sprint per project, completion and carryover.
- Sprint filters in the existing task board/list and API.
- Saved historical progress with daily burndown, completed-sprint velocity, and current workload by assignee.
- Manual time entries, notes, own-entry edit/removal, personal and manager team timesheets, date/project/person filters, and daily totals.
- Server-persisted timers with stop/save, discard, UTC date splitting, and bounded abandoned sessions.

## Validation

| Check | Result |
| --- | --- |
| Full integration suite | 109 passed, 0 failed, 0 skipped: 82 existing tests and 27 Phase 4 tests. |
| Build | `npm run build` passed strict TypeScript checking, Vite production compilation, and Node bundling. |
| Production dependency audit | `npm audit --omit=dev` reported 0 vulnerabilities at verification time. |
| Local health | `/api/health` returns `{"status":"ok","phase":4}`. |
| Persistence | An active timer and saved sprint/time records survived a browser reload and server restart; the timer was then saved through the UI. |
| Responsive browser check | At a 390 × 844 viewport, report and timesheet views rendered without page-width overflow. Restored the normal viewport afterward. This is emulation, not a physical-phone test. |

The tests use temporary MongoDB replica sets separate from the on-disk review database. They cover tenant isolation, guest project grants and revocation, manager-only sprint changes, malformed dates/inputs, stale revisions/board versions, concurrent starts, foreign task/sprint IDs, subtask restrictions, active progress changes, deletion history, completion snapshots, carryover, workload counts, and board API sprint filters.

Time tests cover author-only writes, private personal reads, manager team reads/filters, time-event privacy in activity/overview, invalid/future dates, transactional 24-hour daily budgets under concurrent writes across projects, one timer per person/workspace, concurrent stop without duplicate entries, splitting at UTC midnight, abandoned timer caps, recovery after a rejected save, discard, archived projects, deleted-task history, project cleanup, and fail-closed tenant models.

## Browser flow checked

Used the existing local Preview Owner account in Studio North / Website refresh. All review changes are local fixtures.

1. Created **Website foundations**, with a goal and dates; bulk-allocated WEB-3, WEB-4 and WEB-5; started it.
2. Changed WEB-3 from In progress to Done in the existing task panel. The sprint recorded its actual progress.
3. Created **Accessibility finish**, completed Website foundations, and carried unfinished WEB-5 into it. The first sprint retained **2/3 tasks complete, 5 completed estimated hours**, from a 7-hour scope. The new sprint was started with one 2-hour task.
4. Reviewed the completed sprint's burndown history: start, task completion, and sprint completion produced three saved points. Reviewed velocity and current workload.
5. Added a **90-minute** manual review entry to WEB-3. Started a timer on WEB-5, reloaded the browser, restarted the server, and observed it still running. Stopped/saved it as **1 minute**. Personal/team timesheets showed **1h 31m** across two entries.
6. Opened WEB-5 from planning and checked the existing project board with the Accessibility finish filter: exactly one matching top-level task.
7. Checked the report and timesheet layout at a 390-pixel width, then restored the desktop viewport.

Screenshots: [sprints](phase-4-sprints.png), [timesheets](phase-4-timesheets.png), [burndown and saved history](phase-4-burndown.png), [velocity](phase-4-velocity.png), [workload](phase-4-workload.png), [small-screen report](phase-4-mobile.png).

## Report and time definitions

- Sprint scope consists of top-level tasks; subtasks follow their parent and are excluded from sprint totals. Moving work out of a sprint does not change task status. Completed sprint scope is locked; tasks retained there cannot be allocated into another sprint.
- Historical tracking starts when a sprint starts. It records real committed changes; it does not invent a preexisting history. Daily burndown uses the last saved state of each UTC date. Future days remain blank; the ideal line uses the initial remaining task count and planned dates. Same-day changes are visible in the raw history table even when the daily line has only one point.
- Completed velocity is a frozen result, not recalculated from later task edits. It covers the last 12 completed sprints and reports task counts and estimated hours, not story points or logged time.
- Workload is current open top-level task count and full estimated hours by assignee. It is not a capacity forecast or a calculation of remaining effort. Unestimated and unassigned work remain explicit.
- Timesheet dates and daily limits use UTC. The maximum is 24 hours per person/date across the workspace. Manual entries use whole minutes. Timers round down to whole minutes with a 1-minute minimum and a 24-hour cap from their original start. Midnight segments are allocated at minute granularity. Failed budget validation leaves the timer available for correction/discard.
- Members can read/edit only their own time. Owners/admins can read team time but cannot alter someone else's entries. Guests cannot read time tracking, time activity, or workload. Guests can read sprint reports only for explicitly shared projects. The same time-activity filtering applies to overview feeds.
- Deleting a task retains time entry labels/history but cancels its running timer. Archived projects reject planning/time edits; restore before saving a timer, or discard it. Explicit project deletion removes its planning/time records and releases their daily budgets.

## Remaining limits

External SMTP/S3/Redis and hosting remain unconfigured and unverified against live providers. Phase 5 still covers external-service setup, monitoring, deployment, and deployed multi-device verification. Password recovery and email verification are still absent. Phase 4 does not add billing, payroll approval, currency values, or task dependencies/Gantt.

The browser review used one local account; permission/concurrency checks used independent integration-test accounts. No load/stress test or physical-device test was performed. Review charts contain real local fixture events from this session rather than invented historical data.

## Source delivery

`orbit-phase-4.zip` contains the complete source, dependency lockfile, configuration examples, and documentation for phases 1–4. It excludes `.env`, `.local`, databases, session keys, uploaded files, `node_modules`, and generated builds. Extract, run `npm ci`, then `npm run dev`, and create an account/workspace. The local review data is retained only in this checkout.
