import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

const passwordHashSchema = z.object({
  algorithm: z.literal('scrypt'),
  cost: z.literal(32768),
  blockSize: z.literal(8),
  parallelization: z.literal(1),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  hash: z.string().regex(/^[a-f0-9]{128}$/),
}).strict();

const userSchema = z.object({
  id: z.string().uuid(),
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,31}$/),
  role: z.enum(['owner', 'viewer']),
  status: z.enum(['active', 'suspended']),
  projectEntryIds: z.array(z.string().uuid()).max(500),
  password: passwordHashSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const sessionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const inviteSchema = z.object({
  id: z.string().uuid(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(['owner', 'viewer']),
  projectEntryIds: z.array(z.string().uuid()).max(500),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const auditSchema = z.object({
  actorId: z.string().uuid(),
  targetId: z.string().uuid(),
  action: z.enum(['invite-created', 'invite-accepted', 'member-updated', 'member-removed', 'sessions-revoked', 'password-reset']),
  at: z.string().datetime(),
}).strict();

const authStoreSchema = z.object({
  version: z.literal(1),
  users: z.array(userSchema).max(500),
  sessions: z.array(sessionSchema).max(5000),
  invites: z.array(inviteSchema).max(500),
  audit: z.array(auditSchema).max(1000),
}).strict();

export type AuthUser = z.infer<typeof userSchema>;
export type AuthStore = z.infer<typeof authStoreSchema>;
export type AuthRole = AuthUser['role'];
export type AuthMember = Pick<AuthUser, 'id' | 'username' | 'role' | 'status' | 'projectEntryIds' | 'createdAt' | 'updatedAt'>;

const SESSION_MS = 12 * 60 * 60 * 1000;
const INVITE_MS = 24 * 60 * 60 * 1000;
const AUTH_FILE = 'auth.json';
const LOCK_FILE = 'auth.lock';

export class AuthStoreError extends Error {
  constructor(message = 'Managed access state is unavailable. Repair it locally with the Cezar auth command.') {
    super(message);
    this.name = 'AuthStoreError';
  }
}

export function authStorePath(): string {
  return join(cezarHomeDir(), AUTH_FILE);
}

export function authStoreReady(): boolean {
  return readStore() !== null;
}

export function csrfTokenForSession(token: string): string {
  return createHmac('sha256', token).update('cezar-csrf-v1').digest('base64url');
}

function emptyStore(): AuthStore {
  return { version: 1, users: [], sessions: [], invites: [], audit: [] };
}

function readStore(): AuthStore | null {
  const path = authStorePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = authStoreSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) throw new AuthStoreError();
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const user of parsed.data.users) {
      if (names.has(user.username) || ids.has(user.id)) throw new AuthStoreError();
      names.add(user.username);
      ids.add(user.id);
    }
    if (parsed.data.users.filter((user) => user.role === 'owner' && user.status === 'active').length < 1) {
      throw new AuthStoreError();
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof AuthStoreError) throw error;
    throw new AuthStoreError();
  }
}

async function withAuthLock<T>(action: () => T | Promise<T>): Promise<T> {
  const lockPath = join(cezarHomeDir(), LOCK_FILE);
  mkdirSync(cezarHomeDir(), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(lockPath, 'a', 0o600);
    closeSync(fd);
    const release = await lockfile.lock(lockPath, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 8, minTimeout: 30, maxTimeout: 250, randomize: true },
    });
    try {
      return await action();
    } finally {
      await release();
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new AuthStoreError();
  }
}

async function mutateStore<T>(mutator: (store: AuthStore, existed: boolean) => T): Promise<T> {
  return withAuthLock(() => {
    const current = readStore();
    const next = current ?? emptyStore();
    const result = mutator(next, current !== null);
    if (next.users.length > 0) atomicWriteJsonSync(authStorePath(), next);
    return result;
  });
}

function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return { algorithm: 'scrypt' as const, cost: 32768 as const, blockSize: 8 as const, parallelization: 1 as const, salt, hash };
}

function passwordMatches(password: string, stored: AuthUser['password']): boolean {
  const candidate = scryptSync(password, stored.salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(candidate, Buffer.from(stored.hash, 'hex'));
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const validPassword = (password: string) => password.length >= 12 && password.length <= 1024;
const validUsername = (username: string) => /^[a-z0-9][a-z0-9._-]{1,31}$/.test(username);
const activeOwners = (store: AuthStore) => store.users.filter((user) => user.role === 'owner' && user.status === 'active');

function audit(store: AuthStore, actorId: string, targetId: string, action: z.infer<typeof auditSchema>['action']) {
  store.audit.push({ actorId, targetId, action, at: new Date().toISOString() });
  if (store.audit.length > 1000) store.audit.splice(0, store.audit.length - 1000);
}

function newSession(store: AuthStore, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  store.sessions = store.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  if (store.sessions.length >= 5000) store.sessions.splice(0, store.sessions.length - 4999);
  store.sessions.push({
    id: randomUUID(), userId, tokenHash: tokenHash(token),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_MS).toISOString(),
  });
  return token;
}

function memberOf(user: AuthUser): AuthMember {
  const { id, username, role, status, projectEntryIds, createdAt, updatedAt } = user;
  return { id, username, role, status, projectEntryIds, createdAt, updatedAt };
}

export async function bootstrapOwner(usernameInput: string, password: string): Promise<void> {
  const username = usernameInput.trim().toLowerCase();
  if (!validUsername(username)) throw new Error('Username must be 2–32 lowercase letters, numbers, dots, dashes, or underscores.');
  if (!validPassword(password)) throw new Error('Password must be 12–1024 characters.');
  await mutateStore((store, existed) => {
    if (existed) throw new Error('Managed access is already initialized.');
    const now = new Date().toISOString();
    store.users.push({ id: randomUUID(), username, role: 'owner', status: 'active', projectEntryIds: [], password: passwordHash(password), createdAt: now, updatedAt: now });
  });
}

export async function repairOwner(usernameInput: string, password: string): Promise<string> {
  const username = usernameInput.trim().toLowerCase();
  if (!validUsername(username)) throw new Error('Username must be 2–32 lowercase letters, numbers, dots, dashes, or underscores.');
  if (!validPassword(password)) throw new Error('Password must be 12–1024 characters.');
  return withAuthLock(() => {
    const path = authStorePath();
    let current: AuthStore | null = null;
    try { current = readStore(); }
    catch (error) { if (!(error instanceof AuthStoreError)) throw error; }
    if (current) throw new Error('Managed access state is valid; use reset-password instead.');
    if (!existsSync(path)) throw new Error('No managed access store exists; use bootstrap instead.');

    const backupPath = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak`;
    copyFileSync(path, backupPath);
    chmodSync(backupPath, 0o600);
    const now = new Date().toISOString();
    const userId = randomUUID();
    const replacement: AuthStore = {
      version: 1,
      users: [{ id: userId, username, role: 'owner', status: 'active', projectEntryIds: [], password: passwordHash(password), createdAt: now, updatedAt: now }],
      sessions: [], invites: [], audit: [],
    };
    atomicWriteJsonSync(path, replacement);
    return backupPath;
  });
}

export async function login(usernameInput: string, password: string): Promise<{ token: string; member: AuthMember } | null> {
  const username = usernameInput.trim().toLowerCase();
  return mutateStore((store, existed) => {
    if (!existed) return null;
    const user = store.users.find((candidate) => candidate.username === username);
    const dummy = { salt: '00000000000000000000000000000000', hash: '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' };
    const valid = passwordMatches(password.slice(0, 1024), user?.password ?? dummy as AuthUser['password']) && password.length <= 1024;
    if (!user || user.status !== 'active' || !valid) return null;
    const token = newSession(store, user.id);
    return { token, member: memberOf(user) };
  });
}

export function findSession(token: string): AuthMember | null {
  if (!token || token.length > 256) return null;
  const store = readStore();
  if (!store) return null;
  const hash = tokenHash(token);
  const session = store.sessions.find((candidate) => {
    const stored = Buffer.from(candidate.tokenHash, 'hex');
    const supplied = Buffer.from(hash, 'hex');
    return stored.length === supplied.length && timingSafeEqual(stored, supplied) && Date.parse(candidate.expiresAt) > Date.now();
  });
  const user = session && store.users.find((candidate) => candidate.id === session.userId && candidate.status === 'active');
  return user ? memberOf(user) : null;
}

export async function logout(token: string): Promise<void> {
  const hash = tokenHash(token);
  await mutateStore((store, existed) => { if (existed) store.sessions = store.sessions.filter((session) => session.tokenHash !== hash); });
}

export async function createInvite(actorId: string, role: AuthRole, projectEntryIds: string[]) {
  const token = randomBytes(32).toString('base64url');
  const invite = await mutateStore((store, existed) => {
    if (!existed || !store.users.some((user) => user.id === actorId && user.role === 'owner' && user.status === 'active')) throw new AuthStoreError();
    if (new Set(projectEntryIds).size !== projectEntryIds.length || projectEntryIds.length > 500) throw new Error('Invalid project grants.');
    if (role === 'owner' && projectEntryIds.length) throw new Error('Owners cannot have project-only grants.');
    const now = Date.now();
    store.invites = store.invites.filter((item) => Date.parse(item.expiresAt) > now);
    if (store.invites.length >= 500) throw new Error('Too many pending invitations.');
    const record = { id: randomUUID(), tokenHash: tokenHash(token), role, projectEntryIds, createdBy: actorId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + INVITE_MS).toISOString() };
    store.invites.push(record);
    audit(store, actorId, record.id, 'invite-created');
    return { id: record.id, expiresAt: record.expiresAt };
  });
  return { ...invite, token };
}

export async function acceptInvite(token: string, usernameInput: string, password: string): Promise<{ token: string; member: AuthMember } | null> {
  const username = usernameInput.trim().toLowerCase();
  if (!validUsername(username) || !validPassword(password)) throw new Error('Choose a valid username and a password of at least 12 characters.');
  return mutateStore((store, existed) => {
    if (!existed) return null;
    const hash = tokenHash(token);
    const invite = store.invites.find((item) => {
      const stored = Buffer.from(item.tokenHash, 'hex');
      const supplied = Buffer.from(hash, 'hex');
      return stored.length === supplied.length && timingSafeEqual(stored, supplied) && Date.parse(item.expiresAt) > Date.now();
    });
    if (!invite || store.users.some((user) => user.username === username)) return null;
    const now = new Date().toISOString();
    const user: AuthUser = { id: randomUUID(), username, role: invite.role, status: 'active', projectEntryIds: invite.projectEntryIds, password: passwordHash(password), createdAt: now, updatedAt: now };
    store.users.push(user);
    store.invites = store.invites.filter((item) => item.id !== invite.id);
    audit(store, invite.createdBy, user.id, 'invite-accepted');
    return { token: newSession(store, user.id), member: memberOf(user) };
  });
}

export function listMembers(): AuthMember[] {
  const store = readStore();
  if (!store) throw new AuthStoreError();
  return store.users.map(memberOf);
}

export async function updateMember(actorId: string, userId: string, patch: { role?: AuthRole; status?: 'active' | 'suspended'; projectEntryIds?: string[] }): Promise<AuthMember | null> {
  return mutateStore((store, existed) => {
    if (!existed || !store.users.some((user) => user.id === actorId && user.role === 'owner' && user.status === 'active')) throw new AuthStoreError();
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) return null;
    const nextRole = patch.role ?? user.role;
    const nextStatus = patch.status ?? user.status;
    if (user.role === 'owner' && (nextRole !== 'owner' || nextStatus !== 'active') && activeOwners(store).length <= 1) throw new Error('The last active owner cannot be demoted or suspended.');
    if (patch.projectEntryIds && new Set(patch.projectEntryIds).size !== patch.projectEntryIds.length) throw new Error('Invalid project grants.');
    user.role = nextRole;
    user.status = nextStatus;
    if (patch.projectEntryIds) user.projectEntryIds = [...patch.projectEntryIds];
    if (user.role === 'owner') user.projectEntryIds = [];
    user.updatedAt = new Date().toISOString();
    store.sessions = store.sessions.filter((session) => session.userId !== user.id);
    audit(store, actorId, user.id, 'member-updated');
    return memberOf(user);
  });
}

export async function revokeMemberSessions(actorId: string, userId: string): Promise<boolean> {
  return mutateStore((store, existed) => {
    if (!existed || !store.users.some((user) => user.id === actorId && user.role === 'owner' && user.status === 'active')) throw new AuthStoreError();
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) return false;
    store.sessions = store.sessions.filter((session) => session.userId !== userId);
    audit(store, actorId, userId, 'sessions-revoked');
    return true;
  });
}

export async function removeMember(actorId: string, userId: string): Promise<boolean> {
  return mutateStore((store, existed) => {
    if (!existed || !store.users.some((user) => user.id === actorId && user.role === 'owner' && user.status === 'active')) throw new AuthStoreError();
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) return false;
    if (user.role === 'owner' && activeOwners(store).length <= 1) throw new Error('The last active owner cannot be removed.');
    store.users = store.users.filter((candidate) => candidate.id !== userId);
    store.sessions = store.sessions.filter((session) => session.userId !== userId);
    audit(store, actorId, userId, 'member-removed');
    return true;
  });
}

export async function resetPassword(usernameInput: string, password: string): Promise<boolean> {
  const username = usernameInput.trim().toLowerCase();
  if (!validPassword(password)) throw new Error('Password must be 12–1024 characters.');
  return mutateStore((store, existed) => {
    if (!existed) return false;
    const user = store.users.find((candidate) => candidate.username === username);
    if (!user) return false;
    user.password = passwordHash(password);
    user.updatedAt = new Date().toISOString();
    store.sessions = store.sessions.filter((session) => session.userId !== user.id);
    audit(store, activeOwners(store)[0]?.id ?? user.id, user.id, 'password-reset');
    return true;
  });
}
