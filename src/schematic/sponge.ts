import { gzipSync } from 'node:zlib';
import { get, nbt, NbtError, need, num, unpackNbt, writeNbt, type Compound, type Tag } from '../nbt/nbt.js';

// Sponge Schematic Specification, versions 2 and 3, written from the public spec
// (github.com/SpongePowered/Schematic-Specification). Blocks are stored as a palette plus
// varint indices, ordered x first, then z, then y: index = x + z * width + y * width * length.

export type Vec3 = [number, number, number];

export interface BlockEntity {
  /** Position inside the schematic, 0-based. */
  pos: Vec3;
  id: string;
  /** Block entity data without position and id. */
  data: Compound;
}

export interface Schematic {
  width: number;
  height: number;
  length: number;
  offset: Vec3;
  dataVersion: number;
  palette: string[];
  blocks: Uint32Array;
  blockEntities: BlockEntity[];
}

export type SpongeVersion = 2 | 3;

export class SchematicError extends Error {}

export function indexOf(s: Pick<Schematic, 'width' | 'length'>, x: number, y: number, z: number): number {
  return x + z * s.width + y * s.width * s.length;
}

export function blockAt(s: Schematic, x: number, y: number, z: number): string {
  return s.palette[s.blocks[indexOf(s, x, y, z)]!]!;
}

// ---- varints (unsigned LEB128, as the spec uses) ----

export function encodeVarints(values: ArrayLike<number>): Int8Array {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let v = values[i]!;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
  }
  return Int8Array.from(out, (b) => (b > 127 ? b - 256 : b));
}

export function decodeVarints(bytes: Int8Array, count: number): Uint32Array {
  const out = new Uint32Array(count);
  let p = 0;
  for (let i = 0; i < count; i++) {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (p >= bytes.length) throw new SchematicError('Block data ends early');
      const b = bytes[p++]! & 0xff;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new SchematicError('Block data has a varint that is too long');
    }
    out[i] = value >>> 0;
  }
  if (p !== bytes.length) throw new SchematicError('Block data has extra bytes after the last block');
  return out;
}

// ---- reading ----

function dims(root: Compound): { width: number; height: number; length: number } {
  const read = (k: string) => {
    const v = num(root, k);
    if (v === undefined) throw new SchematicError(`Schematic has no ${k}`);
    return v & 0xffff;
  };
  return { width: read('Width'), height: read('Height'), length: read('Length') };
}

function readPalette(p: Compound): string[] {
  const palette: string[] = [];
  for (const [state, t] of p.value) {
    if (t.type !== 'int') throw new SchematicError('Palette values must be ints');
    if (t.value < 0 || t.value > 1_000_000) throw new SchematicError('Palette index out of range');
    if (palette[t.value] !== undefined) throw new SchematicError(`Palette index ${t.value} is used twice`);
    palette[t.value] = state;
  }
  return palette;
}

function readPos(c: Compound, where: string): Vec3 {
  const p = get(c, 'Pos', 'intArray');
  if (!p || p.value.length !== 3) throw new SchematicError(`${where}: Pos must be 3 ints`);
  return [p.value[0]!, p.value[1]!, p.value[2]!];
}

function readBlockEntities(list: Tag | undefined, version: number, size: Vec3): BlockEntity[] {
  if (!list || list.type !== 'list') return [];
  const out: BlockEntity[] = [];
  for (const t of list.value) {
    if (t.type !== 'compound') continue;
    const pos = readPos(t, 'Block entity');
    if (pos.some((v, i) => v < 0 || v >= size[i]!)) throw new SchematicError('Block entity outside the schematic');
    const id = get(t, 'Id', 'string')?.value ?? get(t, 'id', 'string')?.value;
    if (!id) throw new SchematicError('Block entity without Id');
    let data: Compound;
    const nested = get(t, 'Data', 'compound');
    if (version >= 3 && nested) {
      data = nbt.compound(new Map(nested.value));
    } else {
      data = nbt.compound(new Map(t.value));
    }
    for (const k of ['Pos', 'Id', 'id', 'x', 'y', 'z']) data.value.delete(k);
    out.push({ pos, id, data });
  }
  return out;
}

export interface ReadOptions {
  /** Refuse schematics with more blocks (width * height * length) than this. */
  maxBlocks?: number;
}

export function readSponge(file: Buffer, options: ReadOptions = {}): { schematic: Schematic; version: SpongeVersion } {
  let rootTag: Compound;
  try {
    rootTag = unpackNbt(file).tag;
  } catch (e) {
    throw new SchematicError(`Not a readable schematic: ${e instanceof Error ? e.message : String(e)}`);
  }
  const root = get(rootTag, 'Schematic', 'compound') ?? rootTag;
  const version = num(root, 'Version');
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new SchematicError(`Unsupported schematic version ${version ?? 'missing'} (Sponge versions 2 and 3 are supported)`);
  }
  const { width, height, length } = dims(root);
  const volume = width * height * length;
  if (volume === 0) throw new SchematicError('Schematic is empty');
  if (options.maxBlocks !== undefined && volume > options.maxBlocks) {
    throw new SchematicError(`Schematic has ${volume} blocks (${width}x${height}x${length}), over the limit of ${options.maxBlocks}`);
  }
  const off = get(root, 'Offset', 'intArray');
  const offset: Vec3 = off && off.value.length === 3 ? [off.value[0]!, off.value[1]!, off.value[2]!] : [0, 0, 0];
  const dataVersion = num(root, 'DataVersion') ?? 0;

  let paletteTag: Compound;
  let dataTag: Int8Array;
  let entitiesTag: Tag | undefined;
  try {
    if (version === 3) {
      const blocks = need(root, 'Blocks', 'compound', 'Schematic');
      paletteTag = need(blocks, 'Palette', 'compound', 'Blocks');
      dataTag = need(blocks, 'Data', 'byteArray', 'Blocks').value;
      entitiesTag = blocks.value.get('BlockEntities');
    } else {
      paletteTag = need(root, 'Palette', 'compound', 'Schematic');
      dataTag = need(root, 'BlockData', 'byteArray', 'Schematic').value;
      entitiesTag = root.value.get('BlockEntities') ?? root.value.get('TileEntities');
    }
  } catch (e) {
    if (e instanceof NbtError) throw new SchematicError(e.message);
    throw e;
  }

  const palette = readPalette(paletteTag);
  const blocks = decodeVarints(dataTag, volume);
  for (let i = 0; i < blocks.length; i++) {
    if (palette[blocks[i]!] === undefined) throw new SchematicError(`Block ${i} uses palette index ${blocks[i]} that is not in the palette`);
  }
  const blockEntities = readBlockEntities(entitiesTag, version, [width, height, length]);
  return {
    schematic: { width, height, length, offset, dataVersion, palette, blocks, blockEntities },
    version: version === 3 ? 3 : 2,
  };
}

// ---- writing ----

function u16(v: number): Tag {
  if (!Number.isInteger(v) || v < 1 || v > 0xffff) throw new SchematicError('Schematic sides must be 1-65535');
  return nbt.short(v > 0x7fff ? v - 0x10000 : v);
}

/** Drops palette entries no block uses and renumbers the rest in order of first use. */
export function compactPalette(s: Schematic): Schematic {
  const map = new Map<number, number>();
  const palette: string[] = [];
  const blocks = new Uint32Array(s.blocks.length);
  for (let i = 0; i < s.blocks.length; i++) {
    const old = s.blocks[i]!;
    let next = map.get(old);
    if (next === undefined) {
      next = palette.length;
      map.set(old, next);
      palette.push(s.palette[old]!);
    }
    blocks[i] = next;
  }
  return { ...s, palette, blocks };
}

export function writeSponge(input: Schematic, version: SpongeVersion = 3): Buffer {
  const s = compactPalette(input);
  if (s.blocks.length !== s.width * s.height * s.length) throw new SchematicError('Block count does not match the size');
  const palette = nbt.compound(new Map(s.palette.map((state, i) => [state, nbt.int(i)])));
  const data = nbt.byteArray(encodeVarints(s.blocks));
  const common: [string, Tag][] = [
    ['Version', nbt.int(version)],
    ['DataVersion', nbt.int(s.dataVersion)],
    ['Metadata', nbt.compound({ Date: nbt.long(BigInt(Date.now())) })],
    ['Width', u16(s.width)],
    ['Height', u16(s.height)],
    ['Length', u16(s.length)],
    ['Offset', nbt.intArray(s.offset)],
  ];
  if (version === 2) {
    const entities = s.blockEntities.map((be) =>
      nbt.compound(new Map<string, Tag>([['Pos', nbt.intArray(be.pos)], ['Id', nbt.string(be.id)], ...be.data.value])),
    );
    const root = nbt.compound(
      new Map<string, Tag>([
        ...common,
        ['PaletteMax', nbt.int(s.palette.length)],
        ['Palette', palette],
        ['BlockData', data],
        ['BlockEntities', nbt.list('compound', entities)],
      ]),
    );
    return gzipSync(writeNbt('Schematic', root));
  }
  const entities = s.blockEntities.map((be) =>
    nbt.compound({ Pos: nbt.intArray(be.pos), Id: nbt.string(be.id), Data: be.data }),
  );
  const blocks = nbt.compound({ Palette: palette, Data: data, BlockEntities: nbt.list('compound', entities) });
  const inner = nbt.compound(new Map<string, Tag>([...common, ['Blocks', blocks]]));
  return gzipSync(writeNbt('', nbt.compound({ Schematic: inner })));
}
