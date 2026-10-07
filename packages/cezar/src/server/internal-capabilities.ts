import { createHash, randomBytes } from 'node:crypto';

const LIFETIME_MS = 12 * 60 * 60 * 1000;
const byHash = new Map<string, { runId: string; projectId: string; expiresAt: number; automationCheckIds: Set<string> }>();
const byRun = new Map<string, string>();

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export function issueRunCapability(runId: string, projectId: string): string | undefined {
  if (process.env.CEZ_AUTH_REQUIRED !== '1') return undefined;
  const key = `${projectId}\0${runId}`;
  const existing = byRun.get(key);
  if (existing && (byHash.get(digest(existing))?.expiresAt ?? 0) > Date.now()) return existing;
  const token = randomBytes(32).toString('base64url');
  byRun.set(key, token);
  byHash.set(digest(token), { runId, projectId, expiresAt: Date.now() + LIFETIME_MS, automationCheckIds: new Set() });
  if (byHash.size > 10_000) {
    for (const [hash, record] of byHash) {
      if (record.expiresAt <= Date.now()) byHash.delete(hash);
    }
  }
  return token;
}

export function allowAutomationCheck(token: string | undefined, checkId: string): void {
  if (!token || token.length > 256) return;
  byHash.get(digest(token))?.automationCheckIds.add(checkId);
}

export function revokeAllInternalCapabilities(): void {
  byHash.clear();
  byRun.clear();
}

export async function verifyInternalCapability(token: string, method: string, path: string, body?: unknown): Promise<boolean> {
  if (!token || token.length > 256) return false;
  const record = byHash.get(digest(token));
  if (!record) return false;
  if (record.expiresAt <= Date.now()) {
    byHash.delete(digest(token));
    byRun.delete(`${record.projectId}\0${record.runId}`);
    return false;
  }

  const prefix = `/api/v1/p/${encodeURIComponent(record.projectId)}`;
  const route = path.replace(/\/$/, '');
  if (method === 'GET' && route.startsWith('/api/v1/automation-checks/')) {
    const checkId = route.slice('/api/v1/automation-checks/'.length);
    return record.automationCheckIds.has(checkId);
  }
  if (!route.startsWith(`${prefix}/`)) return false;
  const scoped = route.slice(prefix.length);
  if (method === 'GET' && scoped === '/runs') return true;
  if (method === 'POST' && (scoped === `/runs/${encodeURIComponent(record.runId)}/dispatch` || scoped === `/runs/${encodeURIComponent(record.runId)}/report`)) return true;
  if (method === 'GET' && (scoped === '/automations' || scoped === '/tracker/automation-options' || /^\/automations\/[a-zA-Z0-9_-]+$/.test(scoped))) return true;
  if (method === 'POST' && scoped === '/automations') {
    const input = body && typeof body === 'object' ? body as { enabled?: unknown } : {};
    return input.enabled !== true;
  }
  if (method === 'POST' && /^\/automations\/[a-zA-Z0-9_-]+\/check$/.test(scoped)) {
    const input = body && typeof body === 'object' ? body as { mode?: unknown } : {};
    return input.mode === undefined || input.mode === 'preview';
  }
  return false;
}
