import { expect, it } from 'vitest';
import {
  BlockError,
  checkBlockFilter,
  checkBlockState,
  checkSnbt,
  cloneCommand,
  fillCommands,
  isFragile,
  MAX_COMMAND_BYTES,
  packPlacements,
  schematicPlacements,
  type Placement,
} from '../src/mc/blocks.js';
import { boxVolume, splitBox, type Box } from '../src/mc/box.js';
import { nbt } from '../src/nbt/nbt.js';
import type { Schematic } from '../src/schematic/sponge.js';
import { rle } from '../src/ops/readout.js';

function cells(boxes: Box[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const b of boxes)
    for (let x = b.min[0]; x <= b.max[0]; x++)
      for (let y = b.min[1]; y <= b.max[1]; y++)
        for (let z = b.min[2]; z <= b.max[2]; z++) seen.set(`${x},${y},${z}`, (seen.get(`${x},${y},${z}`) ?? 0) + 1);
  return seen;
}

/** Parses fill and setblock commands back into the blocks they set. */
function apply(commands: string[]): Map<string, string> {
  const world = new Map<string, string>();
  for (const c of commands) {
    const p = c.split(' ');
    if (p[0] === 'setblock') world.set(`${p[1]},${p[2]},${p[3]}`, p[4]!.replace(/\{.*$/, ''));
    else if (p[0] === 'fill') {
      const [x1, y1, z1, x2, y2, z2] = p.slice(1, 7).map(Number) as [number, number, number, number, number, number];
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) world.set(`${x},${y},${z}`, p[7]!);
    }
  }
  return world;
}

it('splits a box into pieces under the limit that cover it exactly once', () => {
  for (const [box, limit] of [
    [{ min: [0, 0, 0], max: [99, 99, 99] }, 32768],
    [{ min: [-5, -64, 7], max: [300, -60, 9] }, 1000],
    [{ min: [0, 0, 0], max: [0, 0, 0] }, 1],
    [{ min: [0, 0, 0], max: [200, 1, 200] }, 100],
  ] as [Box, number][]) {
    const parts = splitBox(box, limit);
    expect(parts.every((p) => boxVolume(p) <= limit)).toBe(true);
    const seen = cells(parts);
    expect(seen.size).toBe(boxVolume(box));
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  }
});

it('packs a solid cube of single blocks into one fill', () => {
  const list: Placement[] = [];
  for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) for (let z = 0; z < 10; z++) list.push({ pos: [x, y, z], state: 'minecraft:stone' });
  const batch = packPlacements(list);
  expect(batch.first).toEqual(['fill 0 0 0 9 9 9 minecraft:stone']);
  expect(batch.second).toEqual([]);
});

it('packs a checkerboard and a mixed build without changing what ends up where', () => {
  const list: Placement[] = [];
  for (let x = 0; x < 12; x++)
    for (let y = 0; y < 4; y++)
      for (let z = 0; z < 12; z++) list.push({ pos: [x, y, z], state: (x + z) % 3 === 0 ? 'minecraft:glass' : y === 0 ? 'minecraft:stone' : 'minecraft:oak_planks' });
  list.push({ pos: [0, 0, 0], state: 'minecraft:gold_block' });
  const batch = packPlacements(list);
  const world = apply([...batch.first, ...batch.second]);
  const want = new Map<string, string>();
  for (const p of list) want.set(p.pos.join(','), p.state);
  expect(world).toEqual(want);
  expect(batch.first.length).toBeLessThan(list.length / 3);
});

it('places fragile blocks after the others, bottom up, and blocks with data one by one', () => {
  const batch = packPlacements([
    { pos: [0, 2, 0], state: 'minecraft:torch' },
    { pos: [0, 0, 0], state: 'minecraft:stone' },
    { pos: [0, 1, 0], state: 'minecraft:chest[facing=north]', snbt: '{Items:[]}' },
    { pos: [5, 1, 5], state: 'minecraft:oak_door[half=lower]' },
  ]);
  expect(batch.first).toEqual(['setblock 0 0 0 minecraft:stone']);
  expect(batch.second.slice(0, 2).sort()).toEqual(['setblock 0 1 0 minecraft:chest[facing=north]{Items:[]}', 'setblock 5 1 5 minecraft:oak_door[half=lower]']);
  expect(batch.second[2]).toBe('setblock 0 2 0 minecraft:torch');
  expect(isFragile('minecraft:water')).toBe(true);
  expect(isFragile('minecraft:stone_bricks')).toBe(false);
});

it('places a block without its data when the data is too long for RCON, and says so', () => {
  const batch = packPlacements([{ pos: [1, 2, 3], state: 'minecraft:chest', snbt: `{CustomName:"${'x'.repeat(MAX_COMMAND_BYTES)}"}` }]);
  expect(batch.second).toEqual(['setblock 1 2 3 minecraft:chest']);
  expect(batch.warnings[0]).toMatch(/too long for RCON/);
});

it('splits big fills and builds hollow boxes from walls when they are over the limit', () => {
  expect(fillCommands({ min: [0, 0, 0], max: [63, 63, 63] }, 'minecraft:stone')).toHaveLength(8);
  const hollow = fillCommands({ min: [0, 0, 0], max: [49, 49, 49] }, 'minecraft:glass', 'hollow');
  const world = apply(hollow);
  expect(world.get('0,10,10')).toBe('minecraft:glass');
  expect(world.get('25,25,25')).toBe('minecraft:air');
  expect(fillCommands({ min: [0, 0, 0], max: [3, 3, 3] }, 'minecraft:glass', 'hollow')).toEqual(['fill 0 0 0 3 3 3 minecraft:glass hollow']);
  expect(fillCommands({ min: [0, 0, 0], max: [1, 1, 1] }, 'minecraft:stone', undefined, '#minecraft:logs')).toEqual(['fill 0 0 0 1 1 1 minecraft:stone replace #minecraft:logs']);
  expect(cloneCommand({ min: [0, 0, 0], max: [1, 1, 1] }, [1, 0, 0], false, true)).toBe('clone 0 0 0 1 1 1 1 0 0 replace force');
});

it('accepts real block states and refuses anything that could add another command', () => {
  expect(checkBlockState('stone')).toBe('minecraft:stone');
  expect(checkBlockState('minecraft:oak_stairs[facing=north,half=top]')).toBe('minecraft:oak_stairs[facing=north,half=top]');
  expect(checkBlockState('create:cogwheel')).toBe('create:cogwheel');
  expect(checkBlockFilter('#minecraft:logs')).toBe('#minecraft:logs');
  for (const bad of ['stone replace', 'stone\nop me', 'stone run op me', 'Stone', 'minecraft:stone[facing=north', 'minecraft:stone{}', 'a b', '']) {
    expect(() => checkBlockState(bad), bad).toThrow(BlockError);
  }
  expect(checkSnbt(' {Items:[]} ')).toBe('{Items:[]}');
  expect(() => checkSnbt('{a:1}\nop me')).toThrow(BlockError);
  expect(() => checkSnbt('Items:[]')).toThrow(BlockError);
});

it('turns a schematic into placements: air skipped, block data attached, bad names reported', () => {
  const s: Schematic = {
    width: 2, height: 1, length: 2, offset: [0, 0, 0], dataVersion: 1,
    palette: ['minecraft:air', 'minecraft:chest', 'bad name here'],
    blocks: Uint32Array.from([0, 1, 2, 1]),
    blockEntities: [{ pos: [1, 0, 0], id: 'minecraft:chest', data: nbt.compound({ Lock: nbt.string('') }) }],
  };
  const { placements, warnings } = schematicPlacements(s, [10, 20, 30]);
  expect(placements).toEqual([
    { pos: [11, 20, 30], state: 'minecraft:chest', snbt: '{Lock:""}' },
    { pos: [11, 20, 31], state: 'minecraft:chest' },
  ]);
  expect(warnings[0]).toMatch(/invalid state name/);
});

it('writes rows as palette indices with repeats', () => {
  expect(rle([0, 0, 0, 1, 2, 2])).toBe('0*3 1 2*2');
  expect(rle([])).toBe('');
});
