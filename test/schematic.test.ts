import { gunzipSync, gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { get, nbt, readNbt, writeNbt, type Compound } from '../src/nbt/nbt.js';
import { blockAt, decodeVarints, encodeVarints, readSponge, SchematicError, writeSponge, type Schematic } from '../src/schematic/sponge.js';

function house(): Schematic {
  // 3 wide, 2 high, 4 long; 200 palette entries so indices need two varint bytes.
  const palette = ['minecraft:air', 'minecraft:stone', 'minecraft:chest[facing=north,type=single,waterlogged=false]'];
  for (let i = 0; i < 197; i++) palette.push(`minecraft:test_${i}`);
  const blocks = new Uint32Array(3 * 2 * 4);
  for (let i = 0; i < blocks.length; i++) blocks[i] = i % 2 === 0 ? 1 : 3 + ((i * 37) % 197);
  blocks[2 + 1 * 3 + 1 * 12] = 2;
  return {
    width: 3,
    height: 2,
    length: 4,
    offset: [1, -2, 3],
    dataVersion: 4671,
    palette,
    blocks,
    blockEntities: [{ pos: [2, 1, 1], id: 'minecraft:chest', data: nbt.compound({ Items: nbt.list('compound', [nbt.compound({ id: nbt.string('minecraft:diamond'), count: nbt.int(3) })]) }) }],
  };
}

function sameBlocks(a: Schematic, b: Schematic) {
  expect([b.width, b.height, b.length]).toEqual([a.width, a.height, a.length]);
  for (let y = 0; y < a.height; y++) for (let z = 0; z < a.length; z++) for (let x = 0; x < a.width; x++) expect(blockAt(b, x, y, z)).toBe(blockAt(a, x, y, z));
}

it('round-trips a version 3 schematic: blocks, offset, data version and block entities', () => {
  const s = house();
  const { schematic, version } = readSponge(writeSponge(s, 3));
  expect(version).toBe(3);
  sameBlocks(s, schematic);
  expect(schematic.offset).toEqual([1, -2, 3]);
  expect(schematic.dataVersion).toBe(4671);
  expect(schematic.blockEntities).toEqual(s.blockEntities);
});

it('round-trips a version 2 schematic the same way', () => {
  const s = house();
  const { schematic, version } = readSponge(writeSponge(s, 2));
  expect(version).toBe(2);
  sameBlocks(s, schematic);
  expect(schematic.blockEntities).toEqual(s.blockEntities);
});

it('lays out version 3 as the spec says: a Schematic compound with Blocks.Palette, Blocks.Data and BlockEntities[].Data', () => {
  const root = readNbt(gunzipSync(writeSponge(house(), 3)));
  const inner = get(root.tag, 'Schematic', 'compound')!;
  expect(get(inner, 'Version', 'int')!.value).toBe(3);
  expect(get(inner, 'Width', 'short')!.value).toBe(3);
  const blocks = get(inner, 'Blocks', 'compound')!;
  expect(get(blocks, 'Palette', 'compound')).toBeDefined();
  expect(get(blocks, 'Data', 'byteArray')).toBeDefined();
  const be = get(blocks, 'BlockEntities', 'list')!.value[0] as Compound;
  expect(get(be, 'Data', 'compound')).toBeDefined();
});

it('lays out version 2 with the root named Schematic, PaletteMax and flat block entities', () => {
  const root = readNbt(gunzipSync(writeSponge(house(), 2)));
  expect(root.name).toBe('Schematic');
  expect(get(root.tag, 'Version', 'int')!.value).toBe(2);
  expect(get(root.tag, 'PaletteMax', 'int')!.value).toBeGreaterThan(0);
  const be = get(root.tag, 'BlockEntities', 'list')!.value[0] as Compound;
  expect(get(be, 'Items', 'list')).toBeDefined();
  expect(get(be, 'Id', 'string')!.value).toBe('minecraft:chest');
});

it('reads a hand-made version 2 file with an int width and a sparse palette', () => {
  const palette = nbt.compound({ 'minecraft:air': nbt.int(5), 'minecraft:dirt': nbt.int(0) });
  const root = nbt.compound({
    Version: nbt.int(2),
    DataVersion: nbt.int(3465),
    Width: nbt.int(2),
    Height: nbt.short(1),
    Length: nbt.short(1),
    Palette: palette,
    BlockData: nbt.byteArray(encodeVarints([0, 5])),
  });
  const { schematic } = readSponge(gzipSync(writeNbt('Schematic', root)));
  expect(blockAt(schematic, 0, 0, 0)).toBe('minecraft:dirt');
  expect(blockAt(schematic, 1, 0, 0)).toBe('minecraft:air');
});

it('keeps sides up to 65535 by storing them as unsigned shorts', () => {
  const s: Schematic = { width: 40000, height: 1, length: 1, offset: [0, 0, 0], dataVersion: 1, palette: ['minecraft:air'], blocks: new Uint32Array(40000), blockEntities: [] };
  expect(readSponge(writeSponge(s, 3)).schematic.width).toBe(40000);
});

it('encodes varints the way the spec does', () => {
  expect([...encodeVarints([0, 127, 128, 300])].map((b) => b & 0xff)).toEqual([0, 127, 0x80, 0x01, 0xac, 0x02]);
  expect([...decodeVarints(encodeVarints([0, 127, 128, 300, 70000]), 5)]).toEqual([0, 127, 128, 300, 70000]);
  expect(() => decodeVarints(Int8Array.from([0x80]), 1)).toThrow(/ends early/);
  expect(() => decodeVarints(Int8Array.from([1, 2]), 1)).toThrow(/extra bytes/);
});

it('refuses schematics over the size limit, with unknown versions, or with indices outside the palette', () => {
  expect(() => readSponge(writeSponge(house(), 3), { maxBlocks: 10 })).toThrow(/over the limit of 10/);
  const v9 = gzipSync(writeNbt('', nbt.compound({ Schematic: nbt.compound({ Version: nbt.int(9) }) })));
  expect(() => readSponge(v9)).toThrow(/Unsupported schematic version 9/);
  const bad = nbt.compound({
    Version: nbt.int(2), Width: nbt.short(1), Height: nbt.short(1), Length: nbt.short(1),
    Palette: nbt.compound({ 'minecraft:air': nbt.int(0) }), BlockData: nbt.byteArray(encodeVarints([4])),
  });
  expect(() => readSponge(gzipSync(writeNbt('Schematic', bad)))).toThrow(SchematicError);
  expect(() => readSponge(Buffer.from('not a schematic'))).toThrow(/Not a readable schematic/);
});
