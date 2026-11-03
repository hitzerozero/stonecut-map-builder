import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { nbt, writeNbt, type Tag } from '../src/nbt/nbt.js';
import { blockAt } from '../src/schematic/sponge.js';
import { packIndices, readArea, regionDir, stateString, unpackIndices } from '../src/world/region.js';
import { tempDir } from './helpers/temp.js';

/** Builds a region file with one chunk at (cx, cz): section y=0 filled by fn(x, y, z) -> palette index. */
function writeRegion(dir: string, cx: number, cz: number, palette: Tag[], fn: (x: number, y: number, z: number) => number, blockEntities: Tag[] = []) {
  const indices = new Array<number>(4096);
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) indices[(y * 16 + z) * 16 + x] = fn(x, y, z);
  const section = nbt.compound({
    Y: nbt.byte(0),
    block_states: nbt.compound({ palette: nbt.list('compound', palette), data: nbt.longArray(packIndices(indices, palette.length)) }),
  });
  const chunk = nbt.compound({
    DataVersion: nbt.int(4671),
    Status: nbt.string('minecraft:full'),
    sections: nbt.list('compound', [section]),
    block_entities: nbt.list('compound', blockEntities),
  });
  const payload = deflateSync(writeNbt('', chunk));
  const body = Buffer.alloc(Math.ceil((payload.length + 5) / 4096) * 4096);
  body.writeUInt32BE(payload.length + 1, 0);
  body[4] = 2;
  payload.copy(body, 5);
  const header = Buffer.alloc(8192);
  const slot = 4 * ((cx & 31) + (cz & 31) * 32);
  header[slot + 2] = 2;
  header[slot + 3] = body.length / 4096;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}.mca`), Buffer.concat([header, body]));
}

const state = (name: string, props?: Record<string, string>) =>
  nbt.compound({ Name: nbt.string(name), ...(props ? { Properties: nbt.compound(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, nbt.string(v)]))) } : {}) });

it('packs and unpacks section indices for every bit width', () => {
  for (const size of [2, 16, 17, 33, 100, 4096]) {
    const indices = Array.from({ length: 4096 }, (_, i) => (i * 7) % size);
    expect([...unpackIndices(packIndices(indices, size), size)]).toEqual(indices);
  }
  expect([...unpackIndices(undefined, 1)].every((v) => v === 0)).toBe(true);
});

it('writes block states with sorted properties', () => {
  expect(stateString(state('minecraft:oak_stairs', { half: 'top', facing: 'north' }))).toBe('minecraft:oak_stairs[facing=north,half=top]');
  expect(stateString(state('minecraft:stone'))).toBe('minecraft:stone');
});

it('reads blocks and block entities from a saved region file across a generated and a missing chunk, with negative coordinates', async () => {
  const world = tempDir('region2');
  const dir = regionDir(world, 'overworld');
  const palette = [state('minecraft:air'), state('minecraft:stone'), state('minecraft:chest', { facing: 'west' })];
  writeRegion(dir, -1, 2, palette, (x, y, z) => (x === 3 && y === 1 && z === 4 ? 2 : y === 0 ? 1 : 0), [
    nbt.compound({ id: nbt.string('minecraft:chest'), x: nbt.int(-13), y: nbt.int(1), z: nbt.int(36), keepPacked: nbt.byte(0), Items: nbt.list('end', []) }),
  ]);
  const read = await readArea(dir, { min: [-14, 0, 35], max: [1, 1, 36] });
  const s = read.schematic;
  expect([s.width, s.height, s.length]).toEqual([16, 2, 2]);
  expect(blockAt(s, 0, 0, 0)).toBe('minecraft:stone');
  expect(blockAt(s, 1, 1, 1)).toBe('minecraft:chest[facing=west]');
  expect(blockAt(s, 0, 1, 1)).toBe('minecraft:air');
  expect(blockAt(s, 15, 0, 0)).toBe('minecraft:air');
  expect(read.missingChunks).toEqual([[0, 2]]);
  expect(s.blockEntities).toHaveLength(1);
  expect(s.blockEntities[0]!.pos).toEqual([1, 1, 1]);
  expect(s.blockEntities[0]!.data.value.has('x')).toBe(false);
  expect(s.dataVersion).toBe(4671);
});
