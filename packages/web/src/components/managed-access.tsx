import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { acceptWorkspaceInvite, getAuthSession, getViewerSummary, signIn, signOut } from '@/api/auth'

function AccessCard({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-7 shadow-xl shadow-black/5">
        <div className="mb-7">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Cezar workspace</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Managed access</h1>
        </div>
        {children}
      </section>
    </main>
  )
}

function SignInForm({ onDone }: { onDone(): Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await signIn({ username, password })
      await onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted-foreground">Sign in with the account your workspace owner invited.</p>
      <label className="block space-y-1.5 text-sm font-medium">
        Username
        <input autoComplete="username" required minLength={2} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>
      <label className="block space-y-1.5 text-sm font-medium">
        Password
        <input type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button disabled={busy} className="h-10 w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60">{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  )
}

function InviteForm({ token, onDone }: { token: string; onDone(): Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await acceptWorkspaceInvite({ token, username, password })
      await onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not accept the invitation.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted-foreground">Create your workspace login. Use a password with at least 12 characters.</p>
      <label className="block space-y-1.5 text-sm font-medium">
        Username
        <input autoComplete="username" required minLength={2} maxLength={32} pattern="[a-zA-Z0-9._-]+" value={username} onChange={(event) => setUsername(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>
      <label className="block space-y-1.5 text-sm font-medium">
        Password
        <input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button disabled={busy} className="h-10 w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60">{busy ? 'Creating account…' : 'Join workspace'}</button>
    </form>
  )
}

function ViewerHome({ onLogout }: { onLogout(): Promise<void> }) {
  const summary = useQuery({ queryKey: ['viewer-summary'], queryFn: getViewerSummary })
  return (
    <main className="min-h-dvh bg-background px-5 py-10 text-foreground">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Cezar workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Project overview</h1><p className="mt-2 text-sm text-muted-foreground">Read-only access to projects shared with you.</p></div>
          <button onClick={() => void onLogout()} className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Sign out</button>
        </header>
        {summary.isPending ? <p className="text-sm text-muted-foreground">Loading shared projects…</p> : null}
        {summary.isError ? <p role="alert" className="text-sm text-destructive">{summary.error.message}</p> : null}
        {summary.data?.projects.length === 0 ? <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No projects have been shared with this account.</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {summary.data?.projects.map((project) => (
            <article key={project.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3"><h2 className="font-semibold">{project.name}</h2><span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{project.state}</span></div>
              <dl className="mt-5 grid grid-cols-2 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Recent runs</dt><dd className="text-right tabular-nums">{project.recentRuns.total}</dd>
                <dt className="text-muted-foreground">Active</dt><dd className="text-right tabular-nums">{project.recentRuns.active}</dd>
                <dt className="text-muted-foreground">Completed</dt><dd className="text-right tabular-nums">{project.recentRuns.completed}</dd>
                <dt className="text-muted-foreground">Failed</dt><dd className="text-right tabular-nums">{project.recentRuns.failed}</dd>
                <dt className="text-muted-foreground">Latest activity</dt><dd className="text-right">{project.recentRuns.latestAt ? new Date(project.recentRuns.latestAt).toLocaleString() : '—'}</dd>
              </dl>
            </article>
          ))}
        </div>
      </div>
    </main>
  )
}

export function ManagedAccessGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const session = useQuery({ queryKey: ['managed-auth-session'], queryFn: getAuthSession, retry: false, refetchOnWindowFocus: true, refetchInterval: 5 * 60_000 })
  const [inviteToken] = useState(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('invite') ?? ''
    if (token) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    return token
  })

  async function refreshSession() {
    await queryClient.invalidateQueries({ queryKey: ['managed-auth-session'] })
  }

  async function logout() {
    await signOut()
    await queryClient.invalidateQueries({ queryKey: ['managed-auth-session'] })
  }

  if (session.isPending) return <AccessCard><p className="text-sm text-muted-foreground">Checking workspace access…</p></AccessCard>
  if (session.isError) return <AccessCard><p role="alert" className="text-sm text-destructive">{session.error.message}</p><p className="mt-3 text-sm text-muted-foreground">If managed access was enabled before its owner account was created, repair it from the host with the Cezar auth command.</p><button onClick={() => void session.refetch()} className="mt-5 h-10 w-full rounded-md border border-border text-sm font-medium">Try again</button></AccessCard>
  if (!session.data.authRequired) return children
  if (!session.data.authenticated) return <AccessCard>{inviteToken ? <InviteForm token={inviteToken} onDone={refreshSession} /> : <SignInForm onDone={refreshSession} />}</AccessCard>
  if (session.data.member?.role === 'viewer') return <ViewerHome onLogout={logout} />
  return children
}
