import { z } from 'zod';
import { backupWorld, restoreWorld } from '../ops/backup.js';
import { confirm } from '../schemas.js';
import { tool } from './define.js';

export const backupTools = [
  tool({
    name: 'backup_world',
    title: 'Back up the whole world',
    description:
      "Copies the whole world folder into the server's own backup folder (the server pauses saving while it copies, so the copy is consistent). Do this before big changes, for example before importing a large map or anything too big for an undo snapshot. The tool never deletes backups.",
    input: {},
    readOnly: false,
    destructive: false,
    idempotent: false,
    run: async (_a, ctx) => {
      const s = ctx.server();
      return backupWorld(s, (await s.status()).rcon);
    },
  }),
  tool({
    name: 'restore_world',
    title: 'Restore a world backup',
    description:
      'Replaces the world with a backup from backup_world. The server must be stopped. The current world is not deleted: it is moved into the backup folder as replaced-<time>. status lists the backups.',
    input: {
      name: z.string().min(1).max(80).describe('Backup name from status, for example world-2026-01-31T12-00-00-000'),
      confirm,
    },
    readOnly: false,
    destructive: true,
    idempotent: false,
    needsOk: (a) => `replace the current world with the backup ${a.name} (the current world is kept as a backup)`,
    run: async (a, ctx) => {
      const s = ctx.server();
      if ((await s.status()).running) throw new Error('Stop the server first (stop_server), then restore.');
      return restoreWorld(s, a.name);
    },
  }),
];
