# Cloudflare Workers AI models through OpenCode

Status: approved design · 2026-10-04

## Goal

Let a cezar task run on a Cloudflare Workers AI model (`cloudflare-workers-ai/@cf/…`) through the
existing OpenCode backend, with the model offered in the picker like any other OpenCode model —
without handing agents a new secret by default.

No new backend. cezar's runners are coding-agent CLIs; Workers AI is a model API with no agent
loop, and OpenCode already ships it as a provider. This spec only removes what in cezar stops that
provider from working.

## Verified facts

Established 2026-10-04 against OpenCode 1.18.1 on the dev machine (Windows 11), its compiled
binary, the models.dev source and the OpenCode provider docs. Re-verify before changing any of it.

| Fact | Source |
| --- | --- |
| OpenCode's provider id is `cloudflare-workers-ai`; its env contract is `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_KEY` | models.dev `providers/cloudflare-workers-ai/provider.toml` (`env = [...]`) |
| Workers AI model ids start with `@cf/`, so `opencode models` prints `cloudflare-workers-ai/@cf/<vendor>/<model>`. 18 of the provider's 27 models are marked `tool_call`, e.g. `@cf/moonshotai/kimi-k2.7-code`, `@cf/openai/gpt-oss-120b`, `@cf/zai-org/glm-5.3` | models.dev `api.json` |
| The provider loader resolves the account id as `env.CLOUDFLARE_ACCOUNT_ID ‖ auth.metadata.accountId`, and the key as `env.CLOUDFLARE_API_KEY ‖` the stored key. A missing account id disables autoload and makes `getModel` throw `CLOUDFLARE_ACCOUNT_ID is missing…` | OpenCode 1.18.1 binary (`"cloudflare-workers-ai":v.fnUntraced(…)`) and `sst/opencode` `provider.ts` |
| `/connect` / `opencode auth login -p cloudflare-workers-ai` asks for the key, and asks "Enter your Cloudflare Account ID" **only when `CLOUDFLARE_ACCOUNT_ID` is not set in the login shell** (`prompts: !process.env.CLOUDFLARE_ACCOUNT_ID ? [accountId] : []`). Answered, it is stored as `metadata.accountId` beside the key | OpenCode 1.18.1 binary (the provider's auth plugin) |
| OpenCode 1.18.1 stores credentials in `<XDG data home>/opencode/auth.json` (`opencode.db` sits beside it) and honors `XDG_DATA_HOME` on Windows | `opencode auth list` prints `Credentials ~\.local\share\opencode\auth.json`; spec review re-ran it under a temp `XDG_DATA_HOME` |
| `CLOUDFLARE_API_KEY` is ALSO the name Cloudflare's own tooling (wrangler, the API) uses for the account-wide **Global API Key** (paired with `CLOUDFLARE_EMAIL`); `CLOUDFLARE_API_TOKEN` is wrangler's account API token | Cloudflare docs |

**Correction of record.** `src/core/agent-profiles.ts` (the OpenCode bullet) says OpenCode's
credentials live in `opencode.db`; on 1.18.1 they are in `auth.json`. The profile decision there
is unaffected (credentials still do not move with `OPENCODE_CONFIG_DIR`), so this change corrects
the file name in that comment and nothing else.

## What blocks it today

1. **The picker drops every Workers AI model.** `MODEL_LINE_RE` in `opencode-model-catalog.ts`
   requires the model segment to start with `[a-z0-9]`; `@cf/…` fails it, so each line is
   discarded as "not a model id" even when OpenCode lists it. This blocks EVERY user, however
   they logged in.
2. **The account id is stripped when the login did not store it.** `buildChildEnv`
   (`src/core/agent-env.ts`) gives `opencode` the `MULTI_PROVIDER_PREFIXES` set, which has no
   `CLOUDFLARE_` entry. Both call sites that matter go through it — the runner
   (`opencode-server-runner.ts`) and model discovery (`opencode-model-catalog.ts`). A user who
   ran `/connect` in a shell that already had `CLOUDFLARE_ACCOUNT_ID` set (routine for wrangler
   users) has a store with no `metadata.accountId`; OpenCode works in their terminal and fails
   under cezar with `CLOUDFLARE_ACCOUNT_ID is missing`.

Running a hand-typed `cloudflare-workers-ai/@cf/…` model already works past discovery:
`parseModelIdentity` splits on the FIRST slash, giving `{ providerID: 'cloudflare-workers-ai',
modelID: '@cf/…' }`, which is what OpenCode's message API expects. Nothing else in the service or
the contract validates model-id characters, only lengths (`max(120)` / `max(200)`).

## Design

### 1. Picker: accept a leading `@` in the model segment

```ts
const MODEL_LINE_RE = /^[a-z0-9][a-z0-9._-]*\/@?[a-z0-9][a-z0-9._:/-]*$/i;
```

One optional `@`, only as the first character of the model segment. Everything the old pattern
rejected is still rejected: a provider starting with `@`, an empty model (`provider/` and now
`provider/@`), `@@`, an `@` mid-segment (`provider/a@b`), whitespace, banners, stack traces. A
trailing slash (`provider/@cf/`) is accepted, exactly as the old pattern already accepted
`provider/a/`; nothing new.

### 2. Credentials: OpenCode's own store; forward only the account id

The secret stays where every other OpenCode provider's secret already lives — OpenCode's own
credential store, written by `/connect` or `opencode auth login`. OpenCode reads it from the
user's data home, which the child env already reaches (`HOME`, `XDG_*`, `APPDATA`,
`LOCALAPPDATA` are on the base allowlist). cezar forwards no new secret.

The account id is an identifier, not a credential. When the store carries it (the login
prompted), nothing more is needed. When it does not (the login shell had it set), OpenCode needs
it from the environment, so it is forwarded by default — to OpenCode only.

`agent-env.ts` gains a per-backend **exact-name** allowlist beside the prefix one:

```ts
/** Single non-secret vars a backend needs that no prefix family should grant. */
const BACKEND_ALLOW_NAMES: Partial<Record<AgentBackend, ReadonlySet<string>>> = {
  // Workers AI's endpoint interpolates the account id; OpenCode reads it from the env before its
  // own store, and its login skips storing it when the env already has it. The KEY is
  // deliberately absent: CLOUDFLARE_API_KEY is also the name of Cloudflare's account-wide Global
  // API Key, so it reaches the agent only from OpenCode's own store or CEZ_ENV_PASSTHROUGH.
  opencode: upperSet(['CLOUDFLARE_ACCOUNT_ID']),
};
```

`allow(name)` checks `BACKEND_ALLOW_NAMES[opts.backend]?.has(key)` right after the prefix match.
Exact names, not a `CLOUDFLARE_` prefix: the prefix would forward `CLOUDFLARE_API_KEY`,
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_EMAIL`, which together are full control of a Cloudflare
account, to a process an attacker-controlled prompt can drive (#427's threat model). The map is
keyed by the backend actually being built, so the entry cannot reach `pi` (which shares
`MULTI_PROVIDER_PREFIXES` with OpenCode but has no verified Workers AI provider) or any other
backend.

A user who keeps the key in the environment instead keeps the existing opt-in,
`CEZ_ENV_PASSTHROUGH=CLOUDFLARE_API_KEY`. No new `CEZ_*` variable is added, so `.env.example`
does not change.

### 3. Docs

A short paragraph in `docs/reference.md` → *Coding agent backends*, after "Models come from your
own machine":

- log in once with OpenCode — `opencode auth login -p cloudflare-workers-ai` (or `/connect`) —
  and enter the API token and, when asked, the account id. If `CLOUDFLARE_ACCOUNT_ID` is already
  set in your shell OpenCode will not ask; keep it set where cezar runs too, cezar forwards it;
- pick a model that supports tool calling (e.g. `@cf/moonshotai/kimi-k2.7-code`) — a chat-only
  model cannot edit files;
- the key is never taken from the environment by default, because `CLOUDFLARE_API_KEY` is also
  the name of Cloudflare's Global API Key; `CEZ_ENV_PASSTHROUGH=CLOUDFLARE_API_KEY` opts in.

## Default path, before and after

With every knob at its shipped default, the only behavior changes are: `opencode models` lines
whose model segment starts with `@` reach the picker, and OpenCode children see
`CLOUDFLARE_ACCOUNT_ID` when the host sets it. No mechanism is removed, no state is added, no
other backend's environment changes. A host with no Cloudflare variables and no Workers AI login
behaves exactly as before.

## Failure modes (written before the code)

Each is a test case. The unit cases marked "red" are proven to fail against the unfixed source
before the fix lands (move the fix aside in a WIP commit — the stash stack is shared with other
sessions); "guard" cases pin behavior that must not change and pass both ways.

| # | Failure | Guard |
| --- | --- | --- |
| F1 | `CLOUDFLARE_ACCOUNT_ID` is not forwarded to OpenCode | unit, agent-env — red |
| F2 | It leaks to another backend | unit, agent-env — loop over every `AgentBackend` except `opencode` (`RUNNER_IDS` + `claude-cli`) — guard |
| F3 | A Cloudflare secret is forwarded by default: `CLOUDFLARE_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_EMAIL` | unit, agent-env, for `opencode` — guard |
| F4 | The opt-in stops working: `CEZ_ENV_PASSTHROUGH=CLOUDFLARE_API_KEY` no longer forwards it | unit, agent-env — guard |
| F5 | A Windows spelling (`Cloudflare_Account_Id`) is dropped, or forwarded under a rewritten name | unit, agent-env — red |
| F6 | `cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` (and an `@hf/…` id) is rejected by discovery | unit, model catalog — red |
| F7 | The looser pattern admits junk: `@x/model`, `provider/@`, `provider/@@cf/x`, `provider/a@b`, `provider/@cf x`, a banner line | unit, model catalog — guard |
| F8 | Store-only login: the model is missing from `/api/v1/models?runner=opencode`, or a task on it fails | E2E scenario A |
| F9 | Login that skipped the account id: same, with the id only in cezar's environment | E2E scenario B |

## Testing

**Unit** — extend `src/core/agent-env.test.ts` and the OpenCode model-catalog test with F1–F7.

**E2E — the verifiable, repeatable artifact.** A live check, not part of `npm test` or CI: it
needs network, a real OpenCode and a Workers AI token. It is a Node script,
`.ai/scripts/live-cloudflare-workers-ai.ts`, run with the repo's own `tsx` after `npm run build`:

```bash
CF_ACCOUNT_ID=… CF_WORKERS_AI_TOKEN="$(az keyvault secret show …)" node --import tsx .ai/scripts/live-cloudflare-workers-ai.ts [--model cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code]
```

The token arrives in a variable the invoker pipes from Azure Key Vault `t3-secrets`; the script
never prints it, never writes it outside the temp OpenCode home, and strips `CF_*` from every
child env.

Once, before the scenarios, the script **resolves the native OpenCode binary**. On Windows an npm
install puts only shims on `PATH` (`opencode`, `opencode.cmd`, `opencode.ps1`), and cezar spawns
`CEZ_OPENCODE_BIN ?? 'opencode'` without a shell, which finds only `.exe`/`.com` — so a
shell-less `spawn('opencode')` is `ENOENT` on the dev machine (reproduced 2026-10-04) and cezar
would report OpenCode unavailable whatever this change does. The script resolves the same target
the shim itself calls — `<shim dir>/node_modules/opencode-ai/bin/opencode(.exe)` — rather than
reconstructing a platform-package name (Node says `win32`, the package says `windows`, and a
`-baseline` sibling exists), checks the file exists and fails with a clear message if not, passes
it to cezar as `CEZ_OPENCODE_BIN`, uses it for its own `opencode auth list` and
`--version`, and records the path in the report; on POSIX the bare name is kept. That also makes
`opencode.exe` cezar's direct child, which step 6's parent-PID check relies on.

Per scenario, the script:

1. **Isolates everything.** A temp dir holds: an OpenCode data home (`XDG_DATA_HOME`) and config
   home (`XDG_CONFIG_HOME`); a cezar home (`CEZ_HOME`, so the real `~/.cezar` registry is never
   touched); and a throwaway project (`git init` + one commit), which is cezar's working
   directory — task worktrees and `cez/*` branches land there, not in this repo.
2. **Seeds the store the way `/connect` does**, in `<temp>/data/opencode/auth.json`:
   - **A — store only:** `{ "cloudflare-workers-ai": { "type": "api", "key": <token>, "metadata": { "accountId": <id> } } }`
   - **B — key only:** `{ "cloudflare-workers-ai": { "type": "api", "key": <token> } }`

   then runs `opencode auth list` under the same home and asserts the credential is listed.
3. **Boots the built cezar** (`node packages/cezar/dist/index.js serve`, not dry-run) on a free
   port — a fresh boot per scenario, so the model catalog's 5-minute cache never carries over —
   with an environment built from scratch: the parent env minus every `CLOUDFLARE_*`, `CF_*`,
   `CEZ_ENV_PASSTHROUGH` and `CEZ_AGENT_ENV_FULL`, plus the isolated homes and
   `CEZ_OPENCODE_BIN`, plus — **B only** —
   `CLOUDFLARE_ACCOUNT_ID`. So A passes only through the picker fix and the store, and B passes
   only if cezar forwards the account id: without that forward, OpenCode under cezar has neither
   an env nor a stored account id and the run fails with `CLOUDFLARE_ACCOUNT_ID is missing`.
4. **Asserts discovery:** `GET /api/v1/models?runner=opencode` answers `source: 'live'` with at
   least one `cloudflare-workers-ai/@cf/…` id, and includes the chosen model (default
   `cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code`, overridable with `--model`). If the
   chosen model is not listed, the script fails naming it — it never substitutes another.
5. **Runs one task** on that model ("create `hello.txt` containing `hi`") and waits, bounded, for
   `review`; asserts the run's diff touches `hello.txt`.
6. **Tears down, in a `try/finally`:**
   - `POST /api/v1/runs/:id/finish` (a `409 no open session` means it already ended), which
     makes cezar end its OpenCode session through the runner's own `end()`;
   - waits, bounded, until no `opencode` process whose parent is cezar's PID remains (Windows:
     `Get-CimInstance Win32_Process` by `ParentProcessId`; POSIX: `ps -o pid= --ppid`);
   - stops cezar gracefully through its own supervisor watch: cezar was booted with
     `CEZ_SUPERVISOR_PID` set to a sentinel child the script owns, and ending the sentinel makes
     cezar flush and exit on its next liveness tick;
   - after a bounded wait, force-stops only a PID still matching its recorded creation time
     (cezar, or an OpenCode child it recorded), and reports anything it could not verify instead
     of killing it;
   - deletes the temp dir.
7. **Writes `report.json` + `report.md`** to `.ai/qa/artifacts_cloudflare-workers-ai/` (already
   gitignored by `.ai/qa/artifacts_*/`): per scenario — OpenCode binary path and version, model, Workers AI
   models discovered, run id, final status, diff stat, tokens/cost as reported, teardown result,
   timestamps. Never the token, the account id, or a token-verify response.

Which vault secret holds a Workers AI–scoped token is settled at implementation time
(`hiddenxp-cs-cloudflare-ai-token` is the candidate): verify its permissions with Cloudflare's
token-verify endpoint first, and ask the user if none is scoped to Workers AI.

Then the repo's validation sequence: `npm run typecheck`, `npm test`, `npm run test:unit`,
`npm run build`, `npm run test:package`.

## Out of scope

- **Cloudflare AI Gateway** (`cloudflare-ai-gateway` OpenCode provider, or routing Claude/Codex
  through a gateway). The Claude Code route already works with no change — its `ANTHROPIC_*`
  variables are forwarded.
- **pi** — no verified Workers AI provider.
- **A native Workers AI backend** — would need cezar to own an agent loop.
- **The provider-status probe reads the full `process.env`** (`provider-auth.ts`), while the
  runner reads the curated env, so an env-only credential can show OpenCode as connected while a
  run cannot authenticate. Affects every env-var-only OpenCode provider and does not affect the
  store path chosen here. Tracked as a separate follow-up.
- **cezar cannot find an npm-installed OpenCode on Windows** without `CEZ_OPENCODE_BIN` (the
  shim problem above; it affects the runner, model discovery and `backend-detect.ts`'s probe for
  every OpenCode user on Windows, not just Workers AI). Pre-existing; tracked as a separate
  follow-up. The E2E works around it explicitly rather than depending on it.
