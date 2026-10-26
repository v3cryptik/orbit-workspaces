# Phase 3 verification

Verified locally on 26 October 2026, Orbit 0.3.0. No deployment or publication was performed.

## Result

Phase 3 adds live collaboration, comments with selected mentions, persistent mention/assignment notifications, My Tasks, private attachments, and queued invitation email with local previews and configurable SMTP. Existing workspace, role, project, and task behavior remains covered by the combined suite.

| Check | Evidence |
| --- | --- |
| Integration suite | `npm test`: 82 passed, 0 failed, 0 skipped. Tests use separate temporary MongoDB replica sets, not the review database. |
| Production build | `npm run build`: strict TypeScript, Vite frontend, and bundled Node server succeeded. |
| Production dependency audit | `npm audit --omit=dev`: 0 vulnerabilities reported at verification time. |
| Running preview | `http://localhost:4173`; `/api/health` returned `{"status":"ok","phase":3}`. |
| Restart persistence | Restarted the server, retained the signed-in review account, reconnected live, and read the same comment, attachment, assignment, and captured invitation. Downloaded attachment bytes remained correct. |

## Integration coverage

The 26 new phase-3 tests cover two independently authenticated live clients, committed change signals, rejected handshakes, foreign-origin and workspace-token mismatches, tenant/project isolation, failed mutation silence, guest access and revocation, logout and membership revocation, comment ownership/revisions/removal, selected-mention validation, private notification reads, assignment changes, and current-user My Tasks.

Files are tested for protected upload/download, hidden storage keys, unsupported/signature-mismatched/oversized content, uploader/manager removal, archived-project restrictions, transactional metadata cleanup and queued storage cleanup, traversal refusal, and S3 adapter commands using an injected fixture.

Mail tests cover encrypted jobs at rest, manager-only local previews, revoked-invitation cancellation, delivery over a real local SMTP test connection, failed delivery and manager retry. All new tenant models fail closed outside a workspace context. The previous 56 identity, tenant-isolation, project, and task tests also pass.

## Browser checks

Used two browser tabs signed in as the same local Preview Owner. Separate-user and private notification behavior was verified by integration tests, rather than claimed as a two-user browser demonstration.

1. Opened WEB-3 in both tabs and observed a posted comment appear in the other tab without a manual refresh.
2. Selected Preview Teammate from mention suggestions and posted a readable mention.
3. Kept an unsaved task description in the second tab while changing the saved task status in the first tab. The draft survived, a stale-data notice appeared, and explicit Reload task restored the latest saved values.
4. Uploaded the non-sensitive local fixture `orbit-collaboration-reference.txt` through the file chooser, then downloaded it through the protected UI and checked its bytes.
5. Checked My Tasks: the owner had two open assignments with links to the correct project/task. Checked the owner's empty inbox and unread controls.
6. Created a fake-address invitation in local mail mode, observed Captured Locally, and reviewed its message preview. No external email was sent.
7. Restarted the app and checked persisted comment/file/task/mail state, a successful protected download, and the Live indicator.

Screenshots: [collaboration](phase-3-collaboration.png), [My Tasks](phase-3-my-tasks.png), [local mail](phase-3-mail.png). Screenshots omit invitation tokens.

## Limits and remaining work

- External SMTP, S3, and Redis are not configured here. SMTP was exercised against a local wire-level test server; S3 used a command fixture; the Redis adapter has not been exercised against a real Redis deployment.
- The browser checks use two tabs on one computer. Physical mobile devices, separate networks, load testing, and a deployed multi-server setup remain unverified.
- Live messages are permission-checked invalidation signals. They are not a durable event stream; reconnect resynchronizes through the guarded HTTP API.
- Files are limited to 10 MB each and 20 per task. Signature/type checks are not a malware scanner. A process crash between object storage and metadata commit can leave an orphan file; production needs an orphan-audit/lifecycle strategy. Committed file deletions have retryable cleanup jobs.
- Invitation delivery is at-least-once around worker crashes, so duplicate email is possible; invitation acceptance is single-use. Secret rotation requires draining or re-encrypting pending jobs. Local previews are disabled in SMTP mode.
- Phase 4 sprint planning, time logs/timesheets, burndown, velocity, and workload reporting remain planned. Phase 5 external-service deployment, monitoring, and production verification remain planned.

## Source archive

`orbit-phase-3.zip` contains source, lockfile, configuration examples, and documentation. It excludes dependencies, build output, `.env`, `.local`, databases, uploaded files, session secrets, and signed-in review data. Extract it, run `npm ci` and `npm run dev`, then create your own account/workspace.
