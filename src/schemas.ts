import { z } from 'zod';
import { BlockError, checkBlockFilter, checkBlockState, checkSnbt, COORD_LIMIT, MAX_COMMAND_BYTES } from './mc/blocks.js';

// Input shapes shared by the tools. Everything is checked here before any command is built.

const passes = (fn: (s: string) => unknown) => (s: string) => {
  try {
    fn(s);
    return true;
  } catch (e) {
    if (e instanceof BlockError) return false;
    throw e;
  }
};

export const coord = z.number().int('Coordinates are whole numbers').min(-COORD_LIMIT).max(COORD_LIMIT);

export const vec3 = z.tuple([coord, coord, coord]).describe('[x, y, z]');

export const blockState = z
  .string()
  .max(300)
  .refine(passes(checkBlockState), 'Not a block state. Use namespace:name[property=value,...], for example minecraft:oak_stairs[facing=north]')
  .describe('Block state, for example "minecraft:stone" or "minecraft:oak_stairs[facing=north,half=top]"');

export const blockFilter = z
  .string()
  .max(300)
  .refine(passes(checkBlockFilter), 'Use a block state or a block tag such as #minecraft:logs')
  .describe('Only replace this block (state or #tag)');

export const snbt = z
  .string()
  .max(MAX_COMMAND_BYTES)
  .refine(passes(checkSnbt), 'Block data must be one SNBT compound {...} on one line')
  .describe('Optional block entity data in SNBT, for example {Items:[...]} for a chest');

export const dimension = z
  .enum(['overworld', 'the_nether', 'the_end'])
  .default('overworld')
  .describe('Dimension. Default overworld.');

export const skipBackup = z
  .boolean()
  .optional()
  .describe('Only for areas too big for an undo snapshot, after backup_world. Default false.');

export const confirm = z
  .boolean()
  .optional()
  .describe('Set true only after the person agreed to this change (needed while confirmDestructive is on).');

export const serverRelPath = z.string().min(1).max(512).describe('Path inside the test server folder, for example "world/datapacks/my_pack/pack.mcmeta"');

export const schemPath = serverRelPath
  .refine((p) => p.toLowerCase().endsWith('.schem'), 'File name must end with .schem')
  .describe('Path inside the test server folder ending in .schem, for example "schematics/house.schem"');

export const command = z
  .string()
  .min(1)
  .max(MAX_COMMAND_BYTES)
  .refine((c) => !/[\r\n\0]/.test(c), 'One command, on one line')
  .describe('A server command without the leading slash, for example "time set day"');
