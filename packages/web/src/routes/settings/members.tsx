import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type FormEvent } from 'react'
import type { AuthRole, AuthUpdateMemberInput } from '@open-mercato/cezar-api-client'
import { getAuthSession, getWorkspaceMembers, inviteWorkspaceMember, removeWorkspaceMember, revokeWorkspaceMemberSessions, signOut, updateWorkspaceMember } from '@/api/auth'

export function MembersSection() {
  const queryClient = useQueryClient()
  const session = useQuery({ queryKey: ['managed-auth-session'], queryFn: getAuthSession })
  const members = useQuery({ queryKey: ['workspace-members'], queryFn: getWorkspaceMembers, enabled: session.data?.authRequired === true && session.data.member?.role === 'owner' })
  const [role, setRole] = useState<AuthRole>('viewer')
  const [projectEntryIds, setProjectEntryIds] = useState<string[]>([])
  const [inviteLink, setInviteLink] = useState<string>()
  const [message, setMessage] = useState<string>()
  const projects = members.data?.projects ?? []
  const mutation = useMutation({
    mutationFn: inviteWorkspaceMember,
    onSuccess: async (invite) => {
      setInviteLink(`${window.location.origin}/#invite=${encodeURIComponent(invite.token)}`)
      setMessage(`Invitation link created. It expires ${new Date(invite.expiresAt).toLocaleString()}.`)
      await queryClient.invalidateQueries({ queryKey: ['workspace-members'] })
    },
    onError: (error) => setMessage(error.message),
  })
  const selected = useMemo(() => new Set(projectEntryIds), [projectEntryIds])

  if (session.isPending) return <p className="text-sm text-muted-foreground">Checking access…</p>
  if (session.isError) return <p role="alert" className="text-sm text-destructive">{session.error.message}</p>
  if (!session.data.authRequired) {
    return (
      <div className="max-w-2xl rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold">Managed access is off</h2>
        <p className="mt-2 text-sm text-muted-foreground">Enable managed access in the Cezar server launcher with <code>CEZ_AUTH_REQUIRED=1</code>, restart the server, then run <code>cezar auth bootstrap</code> on the host to create the first owner login.</p>
      </div>
    )
  }
  if (session.data.member?.role !== 'owner') return <p className="text-sm text-muted-foreground">Owner access is required to manage members.</p>

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(undefined)
    setInviteLink(undefined)
    mutation.mutate({ role, projectEntryIds: role === 'viewer' ? projectEntryIds : [] })
  }

  async function updateMember(id: string, input: AuthUpdateMemberInput) {
    try {
      await updateWorkspaceMember(id, input)
      await queryClient.invalidateQueries({ queryKey: ['workspace-members'] })
      await queryClient.invalidateQueries({ queryKey: ['managed-auth-session'] })
      setMessage('Membership saved. The member must sign in again.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Membership could not be saved.')
    }
  }

  async function removeMember(id: string) {
    try {
      await removeWorkspaceMember(id)
      await queryClient.invalidateQueries({ queryKey: ['workspace-members'] })
      await queryClient.invalidateQueries({ queryKey: ['managed-auth-session'] })
      setMessage('Member removed and sessions revoked.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Member could not be removed.')
    }
  }

  async function revokeSessions(id: string) {
    try {
      await revokeWorkspaceMemberSessions(id)
      await queryClient.invalidateQueries({ queryKey: ['managed-auth-session'] })
      setMessage('Member sessions revoked. They must sign in again.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sessions could not be revoked.')
    }
  }

  async function logout() {
    try {
      await signOut()
      await queryClient.invalidateQueries({ queryKey: ['managed-auth-session'] })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sign out.')
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-semibold">Workspace members</h2><p className="mt-1 text-sm text-muted-foreground">Owners can run agents and manage access. Viewers can only see project summaries shared with them.</p></div>
          <button onClick={() => void logout()} className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Sign out</button>
        </div>
        {members.isPending ? <p className="mt-5 text-sm text-muted-foreground">Loading members…</p> : null}
        {members.isError ? <p role="alert" className="mt-5 text-sm text-destructive">{members.error.message}</p> : null}
        <div className="mt-5 divide-y divide-border">
          {members.data?.members.map((member) => (
            <MemberRow key={member.id} member={member} projects={projects} onSave={updateMember} onRevokeSessions={revokeSessions} onRemove={removeMember} />
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold">Invite someone</h2>
        <form onSubmit={createInvite} className="mt-4 space-y-4">
          <label className="block space-y-1.5 text-sm font-medium">Role
            <select value={role} onChange={(event) => { setRole(event.target.value as AuthRole); setProjectEntryIds([]) }} className="h-10 w-full rounded-md border border-input bg-background px-3 font-normal">
              <option value="viewer">Viewer — read-only project summaries</option>
              <option value="owner">Owner — full cockpit and member management</option>
            </select>
          </label>
          {role === 'viewer' && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Shared projects</legend>
              {projects.length === 0 ? <p className="text-sm text-muted-foreground">There are no registered projects to share yet.</p> : projects.map((project) => (
                <label key={project.entryId} className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={selected.has(project.entryId)} onChange={(event) => setProjectEntryIds((ids) => event.target.checked ? [...ids, project.entryId] : ids.filter((id) => id !== project.entryId))} />
                  {project.name}
                </label>
              ))}
            </fieldset>
          )}
          {mutation.isError ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : null}
          <button disabled={mutation.isPending || (role === 'viewer' && projectEntryIds.length === 0)} className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{mutation.isPending ? 'Creating…' : 'Create invitation'}</button>
        </form>
        {inviteLink && <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3"><p className="text-sm font-medium">Copy this one-time invitation link</p><div className="mt-2 flex flex-col gap-2 sm:flex-row"><input readOnly value={inviteLink} aria-label="Invitation link" className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs" /><button onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => setMessage('Invitation link copied.'))} className="rounded-md border border-border px-3 py-2 text-sm">Copy link</button></div></div>}
        {message && <p role="status" className="mt-3 text-sm text-muted-foreground">{message}</p>}
      </section>
    </div>
  )
}

function MemberRow({ member, projects, onSave, onRemove }: {
  member: { id: string; username: string; role: AuthRole; status: 'active' | 'suspended'; projectEntryIds: string[] }
  projects: { entryId: string; name: string }[]
  onSave(id: string, input: AuthUpdateMemberInput): Promise<void>
  onRevokeSessions(id: string): Promise<void>
  onRemove(id: string): Promise<void>
}) {
  const [role, setRole] = useState<AuthRole>(member.role)
  const [status, setStatus] = useState<'active' | 'suspended'>(member.status)
  const [grants, setGrants] = useState(member.projectEntryIds)
  const changed = role !== member.role || status !== member.status || grants.join(',') !== member.projectEntryIds.join(',')
  return (
    <article className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-medium">{member.username}</p><p className="mt-0.5 text-xs text-muted-foreground">{member.id}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={`${member.username} role`} value={role} onChange={(event) => setRole(event.target.value as AuthRole)} className="h-9 rounded-md border border-input bg-background px-2 text-sm"><option value="owner">Owner</option><option value="viewer">Viewer</option></select>
          <select aria-label={`${member.username} status`} value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'suspended')} className="h-9 rounded-md border border-input bg-background px-2 text-sm"><option value="active">Active</option><option value="suspended">Suspended</option></select>
          <button disabled={!changed} onClick={() => void onSave(member.id, { role, status, projectEntryIds: role === 'viewer' ? grants : [] })} className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-45">Save</button>
          <button onClick={() => void onRevokeSessions(member.id)} className="h-9 rounded-md border border-border px-3 text-sm hover:bg-muted">Revoke sessions</button>
          <button onClick={() => void onRemove(member.id)} className="h-9 rounded-md border border-border px-3 text-sm text-destructive hover:bg-destructive/5">Remove</button>
        </div>
      </div>
      {role === 'viewer' && <fieldset className="mt-3 flex flex-wrap gap-x-4 gap-y-2"><legend className="sr-only">Projects shared with {member.username}</legend>{projects.map((project) => <label key={project.entryId} className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={grants.includes(project.entryId)} onChange={(event) => setGrants((ids) => event.target.checked ? [...ids, project.entryId] : ids.filter((id) => id !== project.entryId))} />{project.name}</label>)}</fieldset>}
    </article>
  )
}
