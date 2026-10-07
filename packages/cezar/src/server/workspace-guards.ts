import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { cezarHomeDir } from '../paths.ts';

const WORKSPACE_PORT_START = 49_152;
const INSTANCE_PORT_START = 57_344;
const PORT_BUCKET_SIZE = 8_192;

/**
 * Keep two OS-owned loopback sockets for the lifetime of a managed-auth server:
 * one per canonical workspace home, and one per installed server instance.
 * Unlike a PID file, the lock survives deletion of the state directories.
 */
export async function acquireManagedWorkspaceGuards(): Promise<() => Promise<void>> {
  const home = cezarHomeDir();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await realpath(home);
  const instanceId = process.env.CEZ_INSTANCE_ID?.trim() || 'default';
  const guards: Array<{ label: string; port: number }> = [
    { label: 'workspace', port: guardPort('workspace', canonicalHome, WORKSPACE_PORT_START) },
    { label: 'instance', port: guardPort('instance', instanceId.toLowerCase(), INSTANCE_PORT_START) },
  ];
  if (guards[0]!.port === guards[1]!.port) {
    throw new Error('managed authentication could not reserve distinct Cezar guard ports');
  }

  const held: Server[] = [];
  try {
    for (const guard of guards) held.push(await holdLoopbackPort(guard.port, guard.label));
  } catch (error) {
    await Promise.all(held.map(closeServer));
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await Promise.all(held.map(closeServer));
  };
}

function guardPort(namespace: string, key: string, start: number): number {
  const hash = createHash('sha256').update(`${namespace}\0${key}`).digest();
  return start + (hash.readUInt32BE(0) % PORT_BUCKET_SIZE);
}

function holdLoopbackPort(port: number, label: string): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error: NodeJS.ErrnoException) => {
      server.close();
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`managed authentication cannot start: ${label} guard port ${port} is already in use`));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.off('error', onError);
      server.unref();
      resolveServer(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}
