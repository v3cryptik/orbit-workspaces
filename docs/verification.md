# Phase 1 verification

Verified locally on 25 October 2026.

## Automated

- `npm test`: **29 passed, 0 failed**. Real isolated MongoDB replica set, HTTP requests, transactions, role checks, and tenant guard probes.
- `npm run build`: **passed**. Strict TypeScript check, Vite frontend build, esbuild backend bundle.
- `npm audit --omit=dev`: **0 known vulnerabilities** in the installed production dependency graph at verification time.

## Browser checks performed

- Created `Preview Owner` through the registration UI.
- Created `Studio North`, edited its description, and saved the change.
- Created a signed invitation for `teammate@example.test` and verified its pending state.
- Signed out, registered `Preview Teammate` using the invited email, and accepted the link through the application.
- Confirmed the teammate saw two members and member access, without owner/admin invitation controls.
- Signed back in as the owner; the existing workspace and membership history were restored.
- Created `Field Notes` and confirmed its single-member list and separate activity history.
- Switched back to `Studio North` and confirmed its own two-member list and history returned.
- Stopped and restarted the application and local MongoDB. The existing owner session, saved workspace description, members, activity, and workspace selection were restored.
- Reviewed desktop auth, overview, member, invitation, and settings surfaces; corrected profile avatar layout, small text, and supporting text contrast.

`phase-1-desktop.png` is an actual screenshot of the local application after the restart check, using local review data.

## Limits

- Browser checks used a desktop viewport and one browser, sequentially signing in as two accounts. Responsive styles are present, but a physical phone and multiple simultaneous devices have not been tested.
- No public/private cloud deployment, external email delivery, external database provider, Sentry, Redis, or WebSockets were configured.
- No claims are made about task/board collaboration or reports; those belong to later phases.
- An automated test suite demonstrates the checked cases, not a comprehensive production security audit.
