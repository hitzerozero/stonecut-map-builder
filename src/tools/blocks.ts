import { z } from 'zod';
import { AIR } from '../world/region.js';
import { checkBlockFilter, checkBlockState, checkSnbt } from '../mc/blocks.js';
import { boxVolume, makeBox, type Vec3 } from '../mc/box.js';
import { describeArea } from '../ops/readout.js';
import { blockFilter, blockState, confirm, dimension, skipBackup, snbt, vec3 } from '../schemas.js';
import { tool } from './define.js';

const area = { from: vec3.describe('One corner [x, y, z]'), to: vec3.describe('The opposite corner [x, y, z], inclusive') };

export const blockTools = [
  tool({
    name: 'place_blocks',
    title: 'Place blocks',
    description:
      'Places single blocks, up to 10000 per call. The tool packs neighbouring equal blocks into /fill commands, places torches, doors, plants, redstone and liquids after the blocks that hold them, and snapshots the area first so undo can put it back. Later entries at the same spot win.',
    input: {
      blocks: z
        .array(z.object({ pos: vec3, block: blockState, data: snbt.optional() }))
        .min(1)
        .max(10_000)
        .describe('Blocks to place: [{pos: [x, y, z], block: "minecraft:stone"}, ...]'),
      dimension,
      skip_backup: skipBackup,
    },
    readOnly: false,
    destructive: true,
    idempotent: true,
    run: async (a, ctx) =>
      ctx.world().place(
        a.blocks.map((b) => ({ pos: b.pos as Vec3, state: checkBlockState(b.block), ...(b.data ? { snbt: checkSnbt(b.data) } : {}) })),
        { dimension: a.dimension, ...(a.skip_backup ? { skipBackup: true } : {}) },
      ),
  }),
  tool({
    name: 'fill_blocks',
    title: 'Fill boxes',
    description:
      'Fills one or more boxes with a block, in order. Boxes over 32768 blocks are split for you. mode: replace (default), hollow (walls, inside cleared), outline (walls only, inside kept), keep (only air is filled), destroy (drops items). replace_only limits it to one block or #tag. Snapshots the area first for undo.',
    input: {
      fills: z
        .array(
          z.object({
            ...area,
            block: blockState,
            mode: z.enum(['replace', 'hollow', 'outline', 'keep', 'destroy']).optional(),
            replace_only: blockFilter.optional(),
          }),
        )
        .min(1)
        .max(256),
      dimension,
      skip_backup: skipBackup,
    },
    readOnly: false,
    destructive: true,
    idempotent: true,
    run: async (a, ctx) =>
      ctx.world().fill(
        a.fills.map((f) => ({
          box: makeBox(f.from, f.to),
          state: checkBlockState(f.block),
          ...(f.mode ? { mode: f.mode } : {}),
          ...(f.replace_only ? { filter: checkBlockFilter(f.replace_only) } : {}),
        })),
        { dimension: a.dimension, ...(a.skip_backup ? { skipBackup: true } : {}) },
      ),
  }),
  tool({
    name: 'copy_blocks',
    title: 'Copy an area',
    description: 'Copies the box from..to so its lowest corner lands at destination (with /clone). skip_air keeps what is already at the destination where the source is air. Snapshots the destination first for undo.',
    input: {
      ...area,
      destination: vec3.describe('Where the lowest corner of the copy goes [x, y, z]'),
      skip_air: z.boolean().optional().describe('Do not copy air. Default false.'),
      dimension,
      skip_backup: skipBackup,
    },
    readOnly: false,
    destructive: true,
    idempotent: true,
    run: async (a, ctx) =>
      ctx.world().copy(makeBox(a.from, a.to), a.destination as Vec3, a.skip_air ?? false, { dimension: a.dimension, ...(a.skip_backup ? { skipBackup: true } : {}) }),
  }),
  tool({
    name: 'clear_blocks',
    title: 'Clear an area to air',
    description: 'Sets every block in the box to air (containers are emptied, nothing drops). Snapshots the area first for undo.',
    input: { ...area, dimension, confirm, skip_backup: skipBackup },
    readOnly: false,
    destructive: true,
    idempotent: true,
    needsOk: (a) => `clear ${boxVolume(makeBox(a.from, a.to))} blocks from ${a.from.join(' ')} to ${a.to.join(' ')}`,
    run: async (a, ctx) => ctx.world().fill([{ box: makeBox(a.from, a.to), state: AIR }], { dimension: a.dimension, ...(a.skip_backup ? { skipBackup: true } : {}) }, 'clear'),
  }),
  tool({
    name: 'read_blocks',
    title: 'Read the blocks in an area',
    description:
      'Returns the blocks in a box with their full states, block entity ids and a count per block. The server saves the world first and the tool reads the saved chunks, so it changes nothing. Limited to maxReadBlocks per call (32768 by default, for example 32x32x32); read big builds in parts. format "layers" (default) is compact, one line per row; "list" gives every non-air block as [x, y, z, state].',
    input: {
      ...area,
      format: z.enum(['layers', 'list']).default('layers'),
      dimension,
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    run: async (a, ctx) => {
      const box = makeBox(a.from, a.to);
      const v = boxVolume(box);
      if (v > ctx.config.maxReadBlocks) {
        throw new Error(`That area is ${v} blocks; read_blocks reads at most ${ctx.config.maxReadBlocks} per call (maxReadBlocks in the config). Read it in smaller boxes.`);
      }
      return describeArea(await ctx.world().read(box, a.dimension), box, a.format);
    },
  }),
  tool({
    name: 'undo',
    title: 'Undo the last change',
    description: 'Puts back the area changed by the most recent block change (place, fill, copy, clear, import, or run_command with backup_area), from the snapshot taken before it. Call again to go further back; status lists what can be undone.',
    input: { confirm },
    readOnly: false,
    destructive: true,
    idempotent: false,
    needsOk: (_a, ctx) => {
      const last = ctx.world().undo.latest();
      return last ? `undo "${last.entry.label}" (${last.entry.blocks} blocks from ${last.entry.box.min.join(' ')} to ${last.entry.box.max.join(' ')})` : null;
    },
    run: async (_a, ctx) => {
      const r = await ctx.world().undoLast();
      if (!r) throw new Error('Nothing to undo');
      return r;
    },
  }),
];
