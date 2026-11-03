import { existsSync } from 'node:fs';
import { z } from 'zod';
import { listFiles, readServerFile, writeServerFile } from '../ops/files.js';
import { serverPath } from '../ops/world.js';
import { confirm, serverRelPath } from '../schemas.js';
import { tool } from './define.js';

export const fileTools = [
  tool({
    name: 'list_files',
    title: 'List files in the server folder',
    description: 'Lists files and folders inside the test server folder, for example world/datapacks, config or mods. Paths are relative to the server folder; nothing outside it can be listed.',
    input: {
      path: z.string().max(512).default('.').describe('Folder inside the server folder. Default the server folder itself.'),
      depth: z.number().int().min(1).max(5).default(1).describe('How many levels deep. Default 1.'),
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    run: async (a, ctx) => listFiles(ctx.server(), a.path, a.depth),
  }),
  tool({
    name: 'read_file',
    title: 'Read a file in the server folder',
    description: 'Reads a file inside the test server folder: configs, datapack files, logs. Use encoding base64 for binary files. The RCON password in server.properties is hidden. Limited to maxFileBytes.',
    input: {
      path: serverRelPath,
      encoding: z.enum(['text', 'base64']).default('text'),
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    run: async (a, ctx) => readServerFile(ctx.server(), ctx.config, a.path, a.encoding),
  }),
  tool({
    name: 'write_file',
    title: 'Write a file in the server folder',
    description:
      "Writes a file inside the test server folder, making folders as needed: datapacks (world/datapacks/...), configs, server.properties. Mods (.jar files and the mods folder) only if the person allowed it (allowModInstall). The world's chunk files, level.dat and eula.txt cannot be written. After writing server.properties the tool keeps RCON on 127.0.0.1. Use encoding base64 for binary files. Limited to maxFileBytes.",
    input: {
      path: serverRelPath,
      content: z.string().describe('File content, as text or base64'),
      encoding: z.enum(['text', 'base64']).default('text'),
      overwrite: z.boolean().optional().describe('Replace a file that exists. Default false.'),
      confirm,
    },
    readOnly: false,
    destructive: true,
    idempotent: true,
    needsOk: (a, ctx) => (a.overwrite && existsSync(serverPath(ctx.server(), a.path)) ? `replace the existing file ${a.path}` : null),
    run: async (a, ctx) => writeServerFile(ctx.server(), ctx.config, a.path, a.content, a.encoding, a.overwrite ?? false),
  }),
];
