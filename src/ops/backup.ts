import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { STATE_DIR, type TestServer } from '../mc/testserver.js';

// Whole-world copies in the server's own folder. Nothing here deletes a world: restoring moves the
// current world aside first.

export class BackupError extends Error {}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

export function backupsDir(server: TestServer): string {
  return join(server.dir, STATE_DIR, 'backups');
}

function folderBytes(dir: string): number {
  let total = 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    total += d.isDirectory() ? folderBytes(p) : statSync(p).size;
  }
  return total;
}

export function listBackups(server: TestServer): { name: string; bytes: number }[] {
  const dir = backupsDir(server);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => existsSync(join(dir, n, 'level.dat')))
    .sort()
    .map((name) => ({ name, bytes: folderBytes(join(dir, name)) }));
}

const copyWorld = (from: string, to: string) => cp(from, to, { recursive: true, filter: (src) => basename(src) !== 'session.lock' });

export async function backupWorld(server: TestServer, running: boolean): Promise<{ name: string; bytes: number; seconds: number }> {
  const began = Date.now();
  const world = server.worldDir;
  if (!existsSync(join(world, 'level.dat'))) throw new BackupError('There is no world yet; start the server once first');
  const name = `world-${stamp()}`;
  const dest = join(backupsDir(server), name);
  mkdirSync(backupsDir(server), { recursive: true });
  if (running) {
    const c = await server.connection();
    await c.command('save-off');
    try {
      await c.command('save-all flush');
      await copyWorld(world, dest);
    } finally {
      await c.command('save-on');
    }
  } else {
    await copyWorld(world, dest);
  }
  return { name, bytes: folderBytes(dest), seconds: (Date.now() - began) / 1000 };
}

export async function restoreWorld(server: TestServer, name: string): Promise<{ restored: string; previousWorldKeptAs: string }> {
  if (!/^(world|replaced)-[0-9T-]+$/.test(name)) throw new BackupError('Use a backup name from status (world-...)');
  const src = join(backupsDir(server), name);
  if (!existsSync(join(src, 'level.dat'))) throw new BackupError(`No backup called ${name}`);
  const world = server.worldDir;
  const keptAs = `replaced-${stamp()}`;
  if (existsSync(world)) renameSync(world, join(backupsDir(server), keptAs));
  await copyWorld(src, world);
  return { restored: name, previousWorldKeptAs: keptAs };
}
