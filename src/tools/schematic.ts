import { existsSync } from 'node:fs';
import { z } from 'zod';
import { makeBox, type Vec3 } from '../mc/box.js';
import { serverPath } from '../ops/world.js';
import { confirm, dimension, includeEntities, schemPath, skipBackup, vec3 } from '../schemas.js';
import { tool } from './define.js';

export const schematicTools = [
  tool({
    name: 'import_schematic',
    title: 'Import a .schem into the world',
    description:
      'Pastes a Sponge schematic (.schem, version 2 or 3, as WorldEdit and most editors save) from the test server folder into the world with its lowest corner at origin, including chests, signs and other block data. include_air (default true) clears the area first so the result matches the file exactly. Snapshots the area first for undo. Entities in the file (item frames, paintings, armor stands, mobs, minecarts, boats) are summoned after the blocks, with fresh UUIDs; leads stay tied and riders stay seated. include_air also removes the entities already in the area. Limited to maxImportBlocks and maxEntities.',
    input: {
      file: schemPath,
      origin: vec3.describe('Where the lowest corner goes [x, y, z]'),
      include_air: z.boolean().default(true).describe('Clear the area first so air in the file replaces what is there. Default true.'),
      include_entities: includeEntities,
      dimension,
      confirm,
      skip_backup: skipBackup,
    },
    readOnly: false,
    destructive: true,
    idempotent: true,
    needsOk: (a) => `paste ${a.file} at ${a.origin.join(' ')}, replacing what is in that area`,
    run: async (a, ctx) => {
      const file = serverPath(ctx.server(), a.file);
      if (!existsSync(file)) throw new Error(`No file at ${a.file}. Put the .schem inside the test server folder, for example in schematics/.`);
      return ctx.world().importFile(file, a.origin as Vec3, a.include_air, { dimension: a.dimension, ...(a.skip_backup ? { skipBackup: true } : {}) }, a.include_entities ?? ctx.config.includeEntities);
    },
  }),
  tool({
    name: 'export_schematic',
    title: 'Export an area to .schem',
    description:
      'Saves the box from..to as a Sponge schematic (.schem) inside the test server folder, with block states and block data (chest contents, sign text). Version 3 (default) suits WorldEdit 7.3 and newer; use version 2 for older tools. The file can be pasted on any server with WorldEdit or a similar plugin. Entities whose position is inside the box (item frames, paintings, armor stands, mobs, minecarts, boats) are saved with all their data. Limited to maxImportBlocks and maxEntities.',
    input: {
      from: vec3,
      to: vec3,
      file: schemPath,
      version: z.union([z.literal(2), z.literal(3)]).default(3).describe('Sponge schematic version, 3 (default) or 2'),
      overwrite: z.boolean().optional().describe('Replace a file that exists. Default false.'),
      include_entities: includeEntities,
      dimension,
      confirm,
    },
    readOnly: false,
    destructive: true,
    idempotent: true,
    needsOk: (a, ctx) => (a.overwrite && existsSync(serverPath(ctx.server(), a.file)) ? `replace the existing file ${a.file}` : null),
    run: async (a, ctx) => {
      const file = serverPath(ctx.server(), a.file);
      if (existsSync(file) && !a.overwrite) throw new Error(`${a.file} exists. Call again with overwrite: true to replace it.`);
      if (!ctx.config.allowFileWrites) throw new Error('File writes are turned off (allowFileWrites is false in the config).');
      return ctx.world().exportFile(makeBox(a.from, a.to), file, a.version, a.dimension, a.include_entities ?? ctx.config.includeEntities);
    },
  }),
];
