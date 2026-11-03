import { toSnbt } from '../nbt/snbt.js';
import type { Schematic } from '../schematic/sponge.js';
import { type Box, boxSize, splitBox, type Vec3 } from './box.js';

// Builds Minecraft commands for block changes and packs single blocks into as few /fill commands as it can.

/** Minecraft's RCON reads at most 1460 bytes per packet; 14 of them are the header. */
export const MAX_COMMAND_BYTES = 1446;
/** Default /fill and /clone limit (game rule commandModificationBlockLimit). */
export const FILL_LIMIT = 32768;
/** Overworld build limits in Minecraft 1.18 and newer; datapacks can change them, the game then refuses. */
export const COORD_LIMIT = 30_000_000;

const ID = '[a-z0-9_.-]+';
const PATH = '[a-z0-9_./-]+';
const PROP = '[a-z0-9_]+=[a-z0-9_.-]+';
const BLOCK_STATE = new RegExp(`^(?:${ID}:)?${PATH}(?:\\[(?:${PROP}(?:,${PROP})*)?\\])?$`);
const BLOCK_TAG = new RegExp(`^#(?:${ID}:)?${PATH}$`);

export class BlockError extends Error {}

export function checkBlockState(state: string): string {
  if (!BLOCK_STATE.test(state)) {
    throw new BlockError(`Not a block state: "${state.slice(0, 80)}". Use namespace:name[property=value,...], for example minecraft:oak_stairs[facing=north]`);
  }
  return state.includes(':') ? state : `minecraft:${state}`;
}

export function checkBlockFilter(filter: string): string {
  return BLOCK_TAG.test(filter) ? filter : checkBlockState(filter);
}

/** Checks hand-written SNBT for a block entity: one {...} compound with no control characters. */
export function checkSnbt(text: string): string {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) throw new BlockError('Block data must be one SNBT compound, {...}');
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new BlockError('Block data must not contain line breaks or control characters');
  return t;
}

export function isAir(state: string): boolean {
  const name = state.split('[')[0]!;
  return name === 'minecraft:air' || name === 'minecraft:cave_air' || name === 'minecraft:void_air';
}

/**
 * Blocks that pop off or change when placed before what holds them up (torches, doors, plants,
 * redstone, liquids...). They go in a second pass, after everything else is in place.
 */
const FRAGILE = new RegExp(
  [
    'torch', 'lantern', 'door', 'rail', 'sapling', 'button', 'lever', 'ladder', 'sign', 'banner', 'carpet',
    'pressure_plate', 'redstone_wire', 'repeater', 'comparator', 'vine', 'kelp', 'seagrass', 'sugar_cane', 'cactus',
    'bamboo', 'tripwire', 'candle', 'snow$', 'short_grass', 'tall_grass', 'fern', 'dead_bush', 'mushroom$', 'wheat',
    'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa', 'scaffolding', 'lily_pad', 'water$', 'lava$',
    'bubble_column', 'fire$', 'coral', 'pointed_dripstone', 'amethyst_bud', 'amethyst_cluster', 'sea_pickle', 'roots',
    'lichen', 'sculk_vein', 'spore_blossom', 'dripleaf', 'petals', 'flower', 'tulip', 'orchid', 'allium', 'bluet',
    'daisy', 'dandelion', 'poppy', 'cornflower', 'lily_of_the_valley', 'rose', 'lilac', 'peony', 'pitcher', 'bed$',
    'head$', 'skull$', 'frame', 'chorus', 'berry_bush', 'hanging', 'chain$', 'bell$', 'string', 'leaf_litter', 'bush$',
  ].join('|'),
);

export function isFragile(state: string): boolean {
  const name = state.split('[')[0]!.split(':').pop()!;
  return FRAGILE.test(name);
}

const xyz = (v: Vec3) => `${v[0]} ${v[1]} ${v[2]}`;

export function setblockCommand(pos: Vec3, state: string, snbt?: string, mode?: 'replace' | 'keep' | 'destroy'): string {
  return `setblock ${xyz(pos)} ${state}${snbt ?? ''}${mode ? ` ${mode}` : ''}`;
}

export type FillMode = 'replace' | 'hollow' | 'outline' | 'keep' | 'destroy';

export function fillCommand(b: Box, state: string, mode?: FillMode, filter?: string): string {
  const tail = filter ? ` replace ${filter}` : mode ? ` ${mode}` : '';
  return `fill ${xyz(b.min)} ${xyz(b.max)} ${state}${tail}`;
}

/** force lets source and destination overlap (Minecraft refuses that otherwise). */
export function cloneCommand(src: Box, dest: Vec3, masked: boolean, force = false): string {
  const mask = masked ? ' masked' : force ? ' replace' : '';
  return `clone ${xyz(src.min)} ${xyz(src.max)} ${xyz(dest)}${mask}${force ? ' force' : ''}`;
}

/** Fill commands for a box of any size, split to stay under the fill limit. Hollow and outline need the whole box. */
export function fillCommands(b: Box, state: string, mode?: FillMode, filter?: string, limit = FILL_LIMIT): string[] {
  if ((mode === 'hollow' || mode === 'outline') && boxSize(b).reduce((a, c) => a * c, 1) > limit) {
    const [w, h, l] = boxSize(b);
    const shell = (cmd: Box) => fillCommands(cmd, state, undefined, undefined, limit);
    const faces: Box[] = [
      { min: b.min, max: [b.max[0], b.min[1], b.max[2]] },
      { min: [b.min[0], b.max[1], b.min[2]], max: b.max },
      { min: b.min, max: [b.min[0], b.max[1], b.max[2]] },
      { min: [b.max[0], b.min[1], b.min[2]], max: b.max },
      { min: b.min, max: [b.max[0], b.max[1], b.min[2]] },
      { min: [b.min[0], b.min[1], b.max[2]], max: b.max },
    ];
    const out = faces.flatMap(shell);
    if (mode === 'hollow' && w > 2 && h > 2 && l > 2) {
      out.push(...fillCommands({ min: [b.min[0] + 1, b.min[1] + 1, b.min[2] + 1], max: [b.max[0] - 1, b.max[1] - 1, b.max[2] - 1] }, 'minecraft:air', undefined, undefined, limit));
    }
    return out;
  }
  return splitBox(b, limit).map((part) => fillCommand(part, state, mode, filter));
}

export interface Placement {
  pos: Vec3;
  state: string;
  snbt?: string;
}

export interface Batch {
  /** Commands that can run in any order. */
  first: string[];
  /** Fragile blocks, run after first, bottom up. */
  second: string[];
  warnings: string[];
}

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
  state: string;
}

/**
 * Packs single blocks into boxes: runs along x, then runs of equal rows along z, then equal
 * layers along y. Later placements at the same spot win. Blocks with data are placed one by one.
 */
export function packPlacements(list: Placement[], limit = FILL_LIMIT): Batch {
  const last = new Map<string, Placement>();
  for (const p of list) last.set(xyz(p.pos), p);
  const plain: Placement[] = [];
  const withData: Placement[] = [];
  for (const p of last.values()) (p.snbt ? withData : plain).push(p);

  plain.sort((a, b) => a.pos[1] - b.pos[1] || a.pos[2] - b.pos[2] || a.pos[0] - b.pos[0]);
  const rows: Rect[] = [];
  for (const p of plain) {
    const [x, y, z] = p.pos;
    const prev = rows[rows.length - 1];
    if (prev && prev.state === p.state && prev.y0 === y && prev.z0 === z && prev.x1 === x - 1) prev.x1 = x;
    else rows.push({ x0: x, x1: x, z0: z, z1: z, y0: y, y1: y, state: p.state });
  }
  const merge = (rects: Rect[], key: (r: Rect) => string, start: (r: Rect) => number, end: (r: Rect) => number, grow: (into: Rect, r: Rect) => void) => {
    const open = new Map<string, Rect>();
    const out: Rect[] = [];
    for (const r of rects) {
      const k = key(r);
      const o = open.get(k);
      if (o && end(o) === start(r) - 1) grow(o, r);
      else {
        const copy = { ...r };
        open.set(k, copy);
        out.push(copy);
      }
    }
    return out;
  };
  const byZ = merge(
    rows.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || a.x1 - b.x1 || a.z0 - b.z0),
    (r) => `${r.y0}|${r.x0}|${r.x1}|${r.state}`,
    (r) => r.z0,
    (r) => r.z1,
    (o, r) => (o.z1 = r.z1),
  );
  const byY = merge(
    byZ.sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1 || a.z0 - b.z0 || a.z1 - b.z1 || a.y0 - b.y0),
    (r) => `${r.x0}|${r.x1}|${r.z0}|${r.z1}|${r.state}`,
    (r) => r.y0,
    (r) => r.y1,
    (o, r) => (o.y1 = r.y1),
  );

  const batch: Batch = { first: [], second: [], warnings: [] };
  const fragile: { y: number; cmds: string[] }[] = [];
  for (const r of byY) {
    const box: Box = { min: [r.x0, r.y0, r.z0], max: [r.x1, r.y1, r.z1] };
    const cmds = r.x0 === r.x1 && r.y0 === r.y1 && r.z0 === r.z1 ? [setblockCommand(box.min, r.state)] : fillCommands(box, r.state, undefined, undefined, limit);
    if (isFragile(r.state)) fragile.push({ y: r.y0, cmds });
    else batch.first.push(...cmds);
  }
  for (const p of withData) {
    let cmd = setblockCommand(p.pos, p.state, p.snbt);
    if (Buffer.byteLength(cmd) > MAX_COMMAND_BYTES) {
      batch.warnings.push(`Block data at ${xyz(p.pos)} is too long for RCON (${Buffer.byteLength(cmd)} bytes); placed the block without its data`);
      cmd = setblockCommand(p.pos, p.state);
    }
    fragile.push({ y: p.pos[1], cmds: [cmd] });
  }
  fragile.sort((a, b) => a.y - b.y);
  batch.second = fragile.flatMap((f) => f.cmds);
  return batch;
}

/** Placements for pasting a schematic with its 0,0,0 corner at origin. Air is skipped (the caller clears first if wanted). */
export function schematicPlacements(s: Schematic, origin: Vec3): { placements: Placement[]; warnings: string[] } {
  const warnings: string[] = [];
  const data = new Map<number, string>();
  for (const be of s.blockEntities) {
    const i = be.pos[0] + be.pos[2] * s.width + be.pos[1] * s.width * s.length;
    if (be.data.value.size === 0) continue;
    try {
      data.set(i, toSnbt(be.data));
    } catch (e) {
      warnings.push(`Skipped data of ${be.id} at ${be.pos.join(' ')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const states = s.palette.map((p) => {
    try {
      return checkBlockState(p);
    } catch {
      return null;
    }
  });
  const bad = new Set<string>();
  const placements: Placement[] = [];
  for (let y = 0; y < s.height; y++) {
    for (let z = 0; z < s.length; z++) {
      for (let x = 0; x < s.width; x++) {
        const i = x + z * s.width + y * s.width * s.length;
        const state = states[s.blocks[i]!];
        if (state === null || state === undefined) {
          bad.add(s.palette[s.blocks[i]!]!);
          continue;
        }
        if (isAir(state)) continue;
        const snbt = data.get(i);
        placements.push({ pos: [origin[0] + x, origin[1] + y, origin[2] + z], state, ...(snbt ? { snbt } : {}) });
      }
    }
  }
  for (const b of bad) warnings.push(`Skipped blocks with an invalid state name: ${b.slice(0, 80)}`);
  return { placements, warnings };
}
