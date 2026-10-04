import type { AgentProfile, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'
import { providerStatusFor } from '@/lib/provider-status'
import { RUNNERS } from '@/routes/new-task-form'

/**
 * "Which agent, and which of its logins" as ONE flat list (spec 2026-07-29-agent-profiles):
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * The same shape the composer's runner pill uses, and shared by BOTH settings scopes — the repo's
 * default and the machine-wide one are the same question asked about a different subject, so they
 * must not drift into two controls that look alike but behave differently.
 *
 * An agent with a single login stays a single row, which is why a machine with no extra accounts
 * sees exactly the segmented control it always saw.
 */

export interface AgentPickerRow {
  runner: (typeof RUNNERS)[number]
  /** `null` is the discovered account — stored as absence, never the reserved `default` id. */
  account: string | null
  label: string
  desc: string
  missing: boolean
}

/** Build the rows once, so the caller's `checked` logic and the render agree by construction. */
export function agentPickerRows(profiles: readonly AgentProfile[]): AgentPickerRow[] {
  return RUNNERS.flatMap((runner) => {
    const logins = profiles.filter((p) => p.provider === runner.id)
    // One login is not a choice, so the agent is the row.
    if (logins.length < 2) {
      return [{ runner, account: null, label: runner.label, desc: runner.desc, missing: false }]
    }
    return logins.map((login) => ({
      runner,
      account: login.isDefault ? null : login.id,
      label: `${runner.label} · ${login.label}`,
      // The folder, because the labels are cezar's invention and the folder is the account. A
      // folder the CLI has not written yet is called out rather than left looking fine: a run under
      // it fails on auth BY DESIGN — it must not quietly fall back to another login — so the place
      // to say so is where the choice is made.
      // `=== false`, never falsiness: a hosted cockpit leaves `exists` and `configDir` out, and that
      // means "not disclosed" — not "missing" (spec 2026-10-04-hosted-agent-accounts). No folder, no
      // description: the row is its label alone.
      desc:
        login.configDir === undefined
          ? ''
          : login.exists === false
            ? `${login.configDir} — folder not created yet`
            : login.configDir,
      missing: login.exists === false,
    }))
  })
}

/** True once any agent has a second login — what turns the strip into a stacked list. */
export const hasAgentAccounts = (rows: readonly AgentPickerRow[]): boolean =>
  rows.length > RUNNERS.length

export function DefaultAgentPicker({
  rows,
  runner,
  accountFor,
  providerStatus,
  disabled = false,
  accountDisabled = false,
  accountReadOnly = false,
  accountHintId,
  onPick,
}: {
  rows: readonly AgentPickerRow[]
  runner: Runner
  /** The account currently in force for a runner, or null for the discovered one. */
  accountFor: (runner: Runner) => string | null
  providerStatus: {
    data?: ProviderStatusResponse
    isPending: boolean
    isError: boolean
  }
  disabled?: boolean
  /** Account rows only: the write target is not known yet (e.g. the project registry is loading). */
  accountDisabled?: boolean
  /**
   * Accounts cannot be changed on this cockpit (spec 2026-10-04-hosted-agent-accounts H1: the
   * selection route answers 409). The row of the account already in force for a runner stays
   * selectable, because picking it changes the runner alone; every other account row is disabled.
   * `onPick`'s third argument is then `false`, so the caller writes no selection.
   */
  accountReadOnly?: boolean
  /** The element that says WHY an account row is locked (`accountReadOnly`). The locked rows name it
   *  in `aria-describedby`, so a screen reader gets the reason the tooltip gives everyone else. */
  accountHintId?: string
  /** `writeAccount`: the pick names an account the caller should store (a runner with a choice of
   *  logins, on a cockpit that may change it). */
  onPick: (runner: Runner, account: string | null, writeAccount: boolean) => void
}) {
  const stacked = hasAgentAccounts(rows)
  // The account a runner really uses. A stored id that no row carries (an account since removed, a
  // hand edit, the reserved `default` spelling) is a run on the discovered account, so THAT row is
  // the one in force — otherwise nothing is checked, and a read-only picker locks every row.
  const accountInForce = (id: Runner): string | null => {
    const stored = accountFor(id)
    return rows.some((row) => row.runner.id === id && row.account === stored) ? stored : null
  }
  return (
    <div
      role="radiogroup"
      aria-label="Default runner"
      data-slot="agents-runner"
      className={cn(
        'gap-0.5 rounded-md border border-border bg-card p-0.5',
        // Stacked once accounts are in play: `claude · Klaudiusz` beside its folder does not fit a
        // segmented strip, and the folder is the part that says WHICH login this is.
        stacked ? 'flex max-w-md flex-col' : 'inline-flex w-fit',
      )}
    >
      {rows.map((row) => {
        const provider = providerStatusFor(providerStatus.data, row.runner.id)
        const providerConnected =
          !providerStatus.isPending &&
          !providerStatus.isError &&
          provider?.enabled === true &&
          provider.status === 'connected'
        const providerReason = providerStatus.isPending
          ? 'Checking provider authentication…'
          : providerStatus.isError
            ? 'Provider authentication could not be verified.'
            : provider?.enabled === false
              ? 'This provider is disabled. Enable it above or choose another provider.'
            : providerConnected
              ? undefined
              : 'Connect this provider before selecting it.'
        const hasAccountChoice = rows.filter((other) => other.runner.id === row.runner.id).length > 1
        // The login this runner already uses — the one row a read-only picker still offers.
        const inForce = row.account === accountInForce(row.runner.id)
        const checked = row.runner.id === runner && inForce
        const readOnlyLocked = hasAccountChoice && accountReadOnly && !inForce
        const accountLocked = (hasAccountChoice && accountDisabled) || readOnlyLocked
        return (
          <button
            key={`${row.runner.id}:${row.account ?? ''}`}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={row.runner.id}
            data-account={row.account ?? ''}
            title={
              providerReason ??
              (readOnlyLocked
                ? 'Which account an agent uses can’t be changed from this cockpit.'
                : row.desc)
            }
            aria-describedby={readOnlyLocked ? accountHintId : undefined}
            disabled={disabled || !providerConnected || accountLocked}
            onClick={() => onPick(row.runner.id, row.account, hasAccountChoice && !accountReadOnly)}
            className={cn(
              'rounded-sm px-3 py-1.5 text-left font-mono text-[13px] font-medium transition-colors disabled:opacity-50',
              checked ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {row.label}
            {stacked && row.desc !== '' ? (
              <span
                data-slot={row.missing ? 'agents-account-missing' : 'agents-account-dir'}
                data-runner={row.runner.id}
                className="ml-2 font-sans text-[11.5px] text-soft-foreground"
              >
                {row.desc}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
