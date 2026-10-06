# Remote access — macOS + ngrok

Expose a cezar cockpit running on your **Mac** to the internet through an
[ngrok](https://ngrok.com) tunnel — no ports to open, no TLS to manage.

**How it's wired:** cezar runs locally on the Mac. **ngrok** is the public
front (in place of nginx+certbot): it provides the public HTTPS URL. By
default, its `--basic-auth` is the identity gate; managed Cezar logins can
replace it after the owner account is initialized. A **launchd** agent keeps
the tunnel up and restarts it on login (the systemd equivalent).

```
  internet ──HTTPS──► ngrok tunnel ──►  cezar (localhost:4321)
                      --basic-auth              launchd agent
```

---

## Prerequisites

- macOS with [Homebrew](https://brew.sh).
- An [ngrok account](https://dashboard.ngrok.com) and its **authtoken**.
- A **reserved domain** on ngrok (recommended, so the URL is stable) — optional;
  without one you get an ephemeral URL.
- At least one logged-in agent CLI — `claude`, `codex`, or OpenCode (experimental).

---

## Install

```bash
npx cezar-run server-install --platform macosx-ngrok
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects the agent CLIs / `gh` / `git`; offers to `brew install` the missing ones. |
| **ngrok tunnel** | Installs ngrok if needed, saves your **authtoken** (passed via the environment, never on a command line `ps` could read), and configures the tunnel to the cockpit port with **`--basic-auth`** (username + password) unless a ready managed Cezar login already protects the cockpit. If provided, it also configures your **reserved domain**. The agent plist is written `0600`. |
| **Autostart** | Installs a **launchd** agent (`~/Library/LaunchAgents/ai.cezar.ngrok.plist`) with `RunAtLoad` + `KeepAlive` so the authenticated tunnel comes back automatically. |
| **Verify** | Confirms the tunnel and cockpit instance identity. |

The **username + password** you set become the ngrok `--basic-auth`
credentials — what you type in the browser to reach the cockpit over the public
HTTPS URL. If Cezar managed logins are ready, the installer omits that challenge
and the invitee signs in through Cezar instead.

### Replace ngrok Basic Auth with managed Cezar logins

Keep Basic Auth in place while you enable managed access and create the first
owner. Run these commands as the account running launchd, with the same
`CEZ_HOME`:

```bash
CEZ_AUTH_REQUIRED=1 npx cezar-run server-install --platform macosx-ngrok --reconfigure autostart
CEZ_AUTH_REQUIRED=1 npx cezar-run auth bootstrap
CEZ_AUTH_REQUIRED=1 npx cezar-run server-install --platform macosx-ngrok --reconfigure autostart
```

The first restart enables Cezar auth but retains ngrok Basic Auth until an owner
exists. The final reconfigure verifies the auth session and an anonymous 401
before removing `--basic-auth`. If launchd cannot reload the changed plist, the
installer restores the previous plist and tunnel. For PowerShell, set
`$env:CEZ_AUTH_REQUIRED='1'` before running the CLI.

---

## Updating / redeploying

Reload the public tunnel with the standardized command:

```bash
npx cezar-run server-deploy --platform macosx-ngrok
```

`server-deploy` restarts the ngrok launchd agent and re-verifies the tunnel and
cockpit. On macOS cezar itself runs locally — restart it the way you launched
it; `server-deploy` reloads the tunnel that fronts it.

To change the setup itself, the installer is idempotent:

```bash
npx cezar-run server-install --platform macosx-ngrok --reconfigure autostart
npx cezar-run server-install --platform macosx-ngrok --reinstall   # redo everything
```

---

## Uninstall

```bash
npx cezar-run server-uninstall --platform macosx-ngrok
```

Removes the launchd plist and the tunnel config cezar **owns**. Shared tools
(ngrok, the agent CLIs, `gh`) are *listed* for manual removal, not deleted.

---

← Back to [Remote access overview](./README.md)
