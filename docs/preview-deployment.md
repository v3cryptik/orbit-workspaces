# Temporary hosted preview

The preview runs the existing Node/Express server and React build together on Render, with a separate MongoDB Atlas database. It preserves the production authentication, tenant guards, Secure cookies, CSRF checks, and HTTPS origin checks.

## Render settings

- Repository: `v3cryptik/orbit-workspaces`, branch `main`.
- Runtime: Node 24, free web service, Singapore region.
- Build: `npm ci --include=dev && npm run build`.
- Start: `npm start`.
- Health check: `/api/health`.
- Set `NODE_ENV=production`, `FILE_STORAGE=mongodb`, `INVITATION_EMAIL_MODE=disabled`, `TRUST_PROXY_HOPS=1`.
- Store `MONGODB_URI` and a new, random `JWT_SECRET` of at least 32 characters only as Render environment secrets. Never use the local signing key.
- Set `APP_ORIGIN` to the exact deployed HTTPS origin (no trailing slash). Do not use a wildcard or localhost.

`render.yaml` records equivalent settings. A free service may sleep when idle and take time to wake. No local disk is used for durable preview data.

## Database and files

Use a dedicated Atlas project/cluster or, at minimum, a dedicated `orbit_preview` database and a user granted read/write only on that database. Allow network access only from the selected Render service's outbound IP ranges. Keep credentials in Render, never GitHub or chat.

`FILE_STORAGE=mongodb` stores attachment bytes in tenant-guarded MongoDB records. Each object key includes a workspace ID and random UUID; protected attachment endpoints still validate the requesting user/project before reading bytes. Maximum file size remains 10 MB, below MongoDB's document size limit. This is intended for a small preview: attachments consume the database's storage quota. Monitor usage and use private S3/object storage before substantial use. Queued file cleanup works without a request context.

The hosted database starts empty. Existing local review accounts, workspace records, uploaded files, and signing keys are not copied to the cloud.

## Invitations

`INVITATION_EMAIL_MODE=disabled` enables explicit link-only invitations. Managers create an invitation and share its link; no email is sent and no local message preview is exposed. The same email-bound, expiring, single-use invitation acceptance rules still apply. Jobs are marked `disabled`, never falsely marked `sent`. Sending can be enabled later by configuring SMTP and changing the mode to `smtp`.

Default production behavior still requires configured SMTP unless disabled mode is explicitly selected. Development retains its local mailbox. This preview setting does not enable password recovery or email verification.

## Verification before sharing

Check the deployed health endpoint and exercise registration, workspace/project/task creation, a second user's invitation acceptance and tenant isolation, task edits/live updates, an attachment upload/download, and a sprint/time entry. Repeat a read after a service restart. A successful local build is not proof of deployed behavior.

This is an early preview deployment, not completion of Phase 5. Monitoring, backup/recovery, provider limits, real email, password recovery/email verification, and broader production testing remain outstanding.

References: [Render Node deployment](https://render.com/docs/deploy-node-express-app), [Render free limits](https://render.com/docs/free), [Atlas free clusters](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/).
