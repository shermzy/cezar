# Cezar-managed workspace access and RBAC

> Status: in progress
> Scope: one shared workspace per Cezar host (`CEZ_HOME`), managed logins, workspace membership, and project-scoped read-only access.

## Summary

Cezar's existing workspace is a per-host registry of projects. This proposal gives that workspace an owner and managed user accounts, then lets the owner grant read-only access to selected projects. Local loopback use stays implicit while managed authentication is off. Hosted installs keep their current proxy-authenticated behavior until an operator explicitly enables Cezar authentication with `cez auth bootstrap`.

The first release has two effective roles:

- **Owner** — can use the existing cockpit, run agents, manage workspace projects, and invite, change, suspend, or remove users.
- **Viewer** — can see the approved summary for explicitly granted projects. Viewers cannot start agents or use configuration, credential, filesystem, raw-file, launch-key, transcript, diff, or event-stream APIs.

An operator role is deferred. A process launched by Cezar has the service account's filesystem and credential access, so agent execution is a host-level privilege until tasks run with per-user isolation.

## Product boundaries

- One `CEZ_HOME` represents one shared workspace served by exactly one active Cezar server process on one host/network namespace. Shared `CEZ_HOME` volumes across containers or hosts are unsupported. Multiple service units or server processes must not share a `CEZ_HOME`: project run state is stored in each repository and assumes one writer. In managed-auth mode, acquire two independent kernel-owned loopback guard sockets before project initialization or recovery: one keyed by canonical `CEZ_HOME` to prevent different instance IDs from sharing it, and one keyed by stable `CEZ_INSTANCE_ID` to prevent an instance from switching homes. Hold both until all writers stop. If either deterministic guard port is occupied, fail closed with a clear diagnostic; do not use disposable files as the authoritative process lock. To isolate instances, operators must give them distinct `CEZ_HOME` directories and stable instance IDs. Multiple workspaces inside one `CEZ_HOME` and organization-wide federation are out of scope for v1.
- Cezar manages local usernames and password hashes. There is no external identity provider, public signup, or email delivery dependency.
- The initial owner is created through an interactive command on the Cezar host. There is no unauthenticated browser setup route.
- Owners issue one-use, expiring invitation links for manual sharing. The invitee chooses a username and password. No invite token or password is logged or stored in plaintext.
- Password recovery is host-operator initiated through the local CLI in v1. An owner can revoke all of a user's sessions.
- Membership is project-scoped for viewers. The owner remains workspace-wide.
- The viewer summary is deliberately narrow by default: project display name and state, plus recent run counts/status/timestamps. It omits absolute paths, branch names, task titles, prompts, transcripts, tool calls, output, diffs, and credentials. Widening that projection requires an explicit product decision.

## Enablement, proxy cutover, and compatibility

- While managed auth is off, local loopback mode remains the implicit local owner and does not require login. Once bootstrapped, every browser/API request requires a Cezar session, including requests whose Host or peer appears local. A reverse proxy can make remote users appear local to the backend, so there is no network-address bypass; host recovery remains a local CLI operation.
- Existing hosted installations continue to use their configured proxy authentication until the operator persists `CEZ_AUTH_REQUIRED=1` in the Cezar launcher and restarts it.
- `CEZ_AUTH_REQUIRED=1` in the durable service launcher is the authoritative deployment gate, separate from and outside `CEZ_HOME`. Bootstrap itself does not rewrite service configuration. Managed systemd/launchd installs preserve the setting on reconfigure and accept it from the installer environment when first enabled; if the current launcher cannot be read, refuse a rewrite that could clear an enabled setting. For unmanaged launches, the operator must persist the variable in the service/launcher environment. Resetting `CEZ_HOME` cannot remove the gate. Update `.env.example` and the user-facing environment reference for this opt-in variable. When set, protected HTTP, WebSocket, and SSE paths require a valid Cezar session or a narrowly scoped internal task capability. There is no browser-session bypass based on Host, forwarded headers, or peer address.
- If `CEZ_AUTH_REQUIRED=1` but the auth store is absent, malformed, unreadable, or has an unsupported schema, protected service operation fails closed. The service never falls back to proxy-only or anonymous access. The local CLI can bootstrap a missing store, reset a password, or back up and replace a corrupt store with a new owner. Repair replaces memberships and pending invites, so accounts must be re-invited. There is no managed-auth disable command.
- If `CEZ_AUTH_REQUIRED` is unset, hosted mode retains the existing proxy-authenticated behavior. Removing `auth.json` or resetting `CEZ_HOME` cannot remove a persisted launcher setting or disable authentication. The setting is removed only by an operator restoring and verifying proxy authentication before a future explicit disable operation.
- Bootstrap does not silently rewrite external proxy authentication. During rollout, keep the existing proxy Basic Auth and TLS while enabling Cezar auth, restarting the service, and creating the owner. The bundled Ubuntu/nginx and macOS/ngrok installers remove their Basic Auth only on `server-install --reconfigure autostart` after the auth session endpoint is ready and an anonymous owner-only request returns 401; they roll back their managed config and proxy reload if cutover fails. External proxies are not changed: the operator persists `CEZ_AUTH_REQUIRED=1`, restarts Cezar, verifies login and route enforcement, then removes Basic Auth while preserving TLS. Invitees must not need the old shared Basic Auth credential after cutover.
- The auth gate, WebSocket/SSE protections, scoped task capabilities, bootstrap command, and cutover path ship as one release. No intermediate increment may enable bootstrap before every protected path is gated.

## Identity and persisted state

Use a dedicated strict store under `cezarHomeDir()` (for example, `auth.json`), separate from the forgiving workspace preferences/registry. Store versioned user records, password hashes, pending invitations, sessions, owner membership, and viewer project grants. User IDs and project registry-entry IDs are immutable random identifiers; human-readable project slugs are never authorization keys.

- Validate the complete auth store strictly. Corruption, read-only state, or an unknown schema version prevents protected service operation and provides fixed, non-sensitive recovery guidance.
- Protect the file with owner-only permissions, atomic replacement, and a cross-process lock. Existing workspace config merge-write behavior is not sufficient for concurrent auth mutations.
- Give every registered project a stable registry-entry ID. A removed project re-added under the same slug gets a new ID and does not inherit the old grant. Mint/migrate IDs while holding a cross-process lock shared with registry writers; do not rely on the existing merge-write helper's read/modify/write window.
- Record password hashes with algorithm/version/parameters and a per-user salt. Use Node's built-in `crypto.scrypt`; OWASP recommends scrypt when Argon2id is unavailable. Never log password or token values.
- Persist only hashes of random invitation and session tokens. Cap and expire invitations and sessions; invalidate sessions on password reset, role/grant change, suspension, or removal.
- Audit owner actions with actor ID, target ID, action, and timestamp, without secrets or request bodies.

## Login and membership flows

1. A host operator runs `cezar auth bootstrap` in a local interactive terminal with `CEZ_AUTH_REQUIRED=1` in the command environment and the same service account/`CEZ_HOME`. It creates the first owner only when managed auth is not already initialized.
2. The owner opens **Settings → Members**, creates an invitation, chooses project grants, and copies the returned link. The raw link token is shown once and expires after 24 hours.
3. The invitee opens the link, chooses a username and password, and receives a session. There is no public registration form. Put the one-time token in the URL fragment, use `Referrer-Policy: no-referrer`, and remove it from browser history before POSTing it to the API so proxy access logs and referrers do not capture it.
4. Owners can change a viewer's project grants, suspend the account, revoke sessions, or remove the account. A grant/revocation takes effect on the next request and closes active authenticated event/socket connections.
5. A host operator can reset a user's password through a local interactive CLI command; this revokes every session for that user.

### Session and request protections

- Use an opaque, cryptographically random session token in a host-only `Secure`, `HttpOnly`, `SameSite=Strict` cookie with a fixed 12-hour lifetime. Never put session credentials in local storage or URLs.
- Rotate the session on login; revoke it on logout. For authenticated mutations, require a session-bound CSRF token header plus request-origin checks. For unauthenticated login and invitation acceptance, require a same-origin `Origin` and same-site Fetch Metadata and reject missing or cross-origin values; no session-bound CSRF token exists before login.
- Rate-limit login and invite acceptance. Use constant-time hash comparison and generic login failure messages.
- Keep the existing Host/Origin/Fetch Metadata guard. It does not replace authentication or the session-bound CSRF check.

## Authorization model

### Default-deny HTTP gate

When managed auth is enabled, a central gate runs before project context construction and before protected route handlers. It allows only login/session bootstrap, invitation acceptance, minimal health, and the viewer summary to authenticated viewers as appropriate. The viewer summary always requires a valid viewer session. Every other route is owner-only unless explicitly added to a reviewed permission map. Direct URLs and boot-project aliases receive identical checks.

The default gate must cover workspace-wide and project-scoped routes, including projects, all-project run indexes, dashboard data, settings, automations, agent accounts, filesystem browsing, checkout, provider status, task writes, and launch keys. HTTP method alone is not a permission: some GET routes disclose credentials or cause side effects.

### Viewer projection

Viewers use a dedicated summary route and page. They do not reuse owner cockpit queries with client-side filtering. The server resolves each grant through the stable registry-entry ID and returns only the approved summary fields. Unauthorized projects are absent from the response. Viewer routes never instantiate a project context as a side effect of an untrusted slug.

### WebSocket, SSE, and internal CLI calls

- Authenticate WebSocket upgrades from the same session cookie and deny viewer upgrades in v1.
- Protect SSE before opening a stream. Owner streams revalidate the session before each event; viewer summaries do not use SSE in v1.
- On session, user, or grant revocation, terminate authenticated WebSocket/SSE connections. A password reset from the local CLI is detected on the next SSE write/heartbeat.
- Existing agent and automation CLIs call the local API without browser cookies. Do not create an admin bypass. Issue scoped internal capabilities only to trusted Cezar-spawned processes, bound to the active run/project and an explicit action set. Agent tasks remain owner-started in v1.

## User interface

- When managed auth is active, serve a login page before the cockpit's protected API calls.
- Owners get a **Settings → Members** page for invitations, project grants, account state, and session revocation.
- Viewers land on a separate summary page with only their granted projects.
- API contracts live in `packages/contract`, with inferred types and route-level validators. The api-client and web app consume those schemas/types; no hand-written duplicate API shapes.

## Implementation increments

1. Strict auth store, stable project registry-entry IDs under a registry-wide cross-process lock, password hashing, sessions/invitations, local CLI bootstrap/recovery, and guarded bundled proxy cutovers.
2. Contract schemas, login/session/invitation endpoints, owner membership API, and browser login/member flows.
3. Default-deny HTTP authorization; explicit owner route policy; secure health response; WebSocket/SSE auth and revocation; scoped capabilities for existing agent/automation CLI calls.
4. Viewer grants, the authenticated summary endpoint/page, migration documentation, backward-compatibility updates, and operational recovery instructions.

These are implementation tasks within one release slice, not separately shippable releases: bootstrap stays unavailable until the route, event, and CLI gates are complete.

All increments stay behind the explicit bootstrap action. Local loopback behavior remains unchanged while managed auth is off; after bootstrap, all browser/API clients authenticate, including clients on the host. Do not ship a UI-only access restriction.

## Acceptance criteria

- Existing local loopback and unbootstrapped proxy-authenticated hosted installs retain today's behavior.
- Once `CEZ_AUTH_REQUIRED=1` is persisted in the service launcher, deleting or corrupting the auth store or resetting `CEZ_HOME` fails closed. Bootstrap initializes a missing store; repair backs up a corrupt store and replaces it with a new owner. Disabling managed auth is not supported in v1.
- Bundled Ubuntu/nginx and macOS/ngrok cutovers remove their Basic Auth challenge only after the auth session is ready and an anonymous owner-only request returns 401; failed cutover restores the previous proxy config. External proxy instructions require a persisted launcher setting, service restart, auth-required status check, anonymous 401 check, and authenticated success before Basic Auth removal.
- After bootstrap, every protected API route, project alias, workspace aggregate, WebSocket upgrade, and SSE stream rejects an unauthenticated request.
- Invalid/corrupt auth state never grants anonymous access. The last owner cannot be removed or demoted.
- Passwords, session tokens, invitation tokens, and scoped capabilities are not persisted or logged in plaintext.
- A viewer can authenticate and see only the approved summary for granted project-entry IDs; guessing slugs, reusing a removed slug, or calling owner routes yields no extra data or side effects.
- Unauthenticated health and invite/login responses contain no viewer or project data; the summary endpoint requires a valid viewer session.
- Viewer access cannot read launch keys, project roots, raw files, diffs, run transcripts, provider credentials, or invoke agents.
- Owner revocation, suspension, grant changes, and password resets invalidate new requests and terminate existing event/socket connections; CLI password resets are noticed on each SSE write/heartbeat.
- Owner-started agent/automation flows still call only their explicitly scoped internal endpoints after auth is enabled.
- Local mode, current proxy protections, and existing project-state locations remain compatible.

## Security review notes

This is a broad security boundary. Before implementation is complete, inventory every route and every stream, prove which routes are owner-only, and review the task/automation capability path separately. Preserve current hosted behavior until the operator explicitly bootstraps managed auth. Never log credentials, session cookies, invitation fragments, or request bodies on authentication routes.

## Open owner decision

The conservative v1 viewer projection excludes all run titles and content. If owners need viewers to inspect task titles or transcripts, decide those fields and their sensitivity before widening the API response.
