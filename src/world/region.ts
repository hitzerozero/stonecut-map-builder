import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { get, nbt, num, readNbt, type Compound, type Tag } from '../nbt/nbt.js';
import type { BlockEntity, Schematic, Vec3 } from '../schematic/sponge.js';
import { type Box, boxSize } from '../mc/box.js';

// Reads blocks from the world's saved region files (Anvil format, Minecraft 1.18 and newer).
// The server is asked to save first (save-all flush), so the files match the world. Read only.

export const AIR = 'minecraft:air';
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export class RegionError extends Error {}

export type Dimension = 'overworld' | 'the_nether' | 'the_end';

export function regionDir(worldDir: string, dimension: Dimension): string {
  const legacy = { overworld: 'region', the_nether: join('DIM-1', 'region'), the_end: join('DIM1', 'region') }[dimension];
  const candidates = [join(worldDir, legacy), join(worldDir, 'dimensions', 'minecraft', dimension, 'region')];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

export function stateString(entry: Compound): string {
  const name = get(entry, 'Name', 'string')?.value;
  if (!name) throw new RegionError('Palette entry without a name');
  const props = get(entry, 'Properties', 'compound');
  if (!props || props.value.size === 0) return name;
  const parts = [...props.value.entries()]
    .map(([k, v]) => `${k}=${v.type === 'string' ? v.value : String((v as { value: unknown }).value)}`)
    .sort();
  return `${name}[${parts.join(',')}]`;
}

/** Unpacks a section's block indices: 4096 entries, at least 4 bits each, entries never span two longs. */
export function unpackIndices(data: BigInt64Array | undefined, paletteSize: number): Uint16Array {
  const out = new Uint16Array(4096);
  if (paletteSize <= 1 || !data) return out;
  const bits = Math.max(4, Math.ceil(Math.log2(paletteSize)));
  const perLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const need = Math.ceil(4096 / perLong);
  if (data.length < need) throw new RegionError(`Section data too short (${data.length} longs, need ${need})`);
  for (let i = 0; i < 4096; i++) {
    const word = BigInt.asUintN(64, data[Math.floor(i / perLong)]!);
    const v = Number((word >> BigInt((i % perLong) * bits)) & mask);
    if (v >= paletteSize) throw new RegionError('Section uses a palette index that does not exist');
    out[i] = v;
  }
  return out;
}

/** The inverse of unpackIndices, used by tests to build region files. */
export function packIndices(indices: ArrayLike<number>, paletteSize: number): BigInt64Array {
  const bits = Math.max(4, Math.ceil(Math.log2(paletteSize)));
  const perLong = Math.floor(64 / bits);
  const out = new BigInt64Array(Math.ceil(4096 / perLong));
  const words = new Array<bigint>(out.length).fill(0n);
  for (let i = 0; i < 4096; i++) {
    const w = Math.floor(i / perLong);
    words[w] = words[w]! | (BigInt(indices[i]!) << BigInt((i % perLong) * bits));
  }
  words.forEach((w, i) => (out[i] = BigInt.asIntN(64, w)));
  return out;
}

function decompress(kind: number, bytes: Buffer): Buffer {
  const opts = { maxOutputLength: MAX_CHUNK_BYTES };
  if (kind === 1) return gunzipSync(bytes, opts);
  if (kind === 2) return inflateSync(bytes, opts);
  if (kind === 3) return bytes;
  if (kind === 4) throw new RegionError('This world stores chunks with LZ4 (region-file-compression=lz4); set it back to deflate in server.properties');
  throw new RegionError(`Unknown chunk compression ${kind}`);
}

async function readChunk(dir: string, regions: Map<string, Buffer | null>, cx: number, cz: number): Promise<Compound | null> {
  const rx = Math.floor(cx / 32);
  const rz = Math.floor(cz / 32);
  const key = `${rx}.${rz}`;
  if (!regions.has(key)) {
    const file = join(dir, `r.${key}.mca`);
    regions.set(key, existsSync(file) ? await readFile(file) : null);
  }
  const region = regions.get(key);
  if (!region || region.length < 8192) return null;
  const slot = 4 * ((cx & 31) + (cz & 31) * 32);
  const sector = (region[slot]! << 16) | (region[slot + 1]! << 8) | region[slot + 2]!;
  if (sector === 0 || region[slot + 3] === 0) return null;
  const at = sector * 4096;
  if (at + 5 > region.length) throw new RegionError(`Region ${key} is cut short`);
  const length = region.readUInt32BE(at);
  const kind = region[at + 4]!;
  let payload: Buffer;
  if (kind & 0x80) {
    const external = join(dir, `c.${cx}.${cz}.mcc`);
    if (!existsSync(external)) throw new RegionError(`Chunk ${cx},${cz} points to a missing ${external}`);
    payload = await readFile(external);
  } else {
    if (length < 1 || at + 4 + length > region.length) throw new RegionError(`Chunk ${cx},${cz} is cut short`);
    payload = region.subarray(at + 5, at + 4 + length);
  }
  return readNbt(decompress(kind & 0x7f, payload)).tag;
}

function isFull(chunk: Compound): boolean {
  const status = get(chunk, 'Status', 'string')?.value;
  return status === undefined || status === 'minecraft:full' || status === 'full';
}

export interface AreaRead {
  schematic: Schematic;
  /** Chunks inside the area that are not generated yet; their blocks read as air. */
  missingChunks: [number, number][];
}

export async function readArea(dir: string, box: Box): Promise<AreaRead> {
  const [w, h, l] = boxSize(box);
  const palette: string[] = [AIR];
  const paletteIndex = new Map<string, number>([[AIR, 0]]);
  const blocks = new Uint32Array(w * h * l);
  const blockEntities: BlockEntity[] = [];
  const missingChunks: [number, number][] = [];
  const regions = new Map<string, Buffer | null>();
  let dataVersion = 0;
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;

  for (let cx = Math.floor(x0 / 16); cx <= Math.floor(x1 / 16); cx++) {
    for (let cz = Math.floor(z0 / 16); cz <= Math.floor(z1 / 16); cz++) {
      const chunk = await readChunk(dir, regions, cx, cz);
      if (!chunk || !isFull(chunk)) {
        missingChunks.push([cx, cz]);
        continue;
      }
      dataVersion = Math.max(dataVersion, num(chunk, 'DataVersion') ?? 0);
      const sections = get(chunk, 'sections', 'list');
      if (!sections) throw new RegionError(`Chunk ${cx},${cz} has no sections (worlds from Minecraft 1.18 or newer are supported)`);
      for (const sec of sections.value) {
        if (sec.type !== 'compound') continue;
        const sy = num(sec, 'Y');
        if (sy === undefined || sy * 16 > y1 || sy * 16 + 15 < y0) continue;
        const states = get(sec, 'block_states', 'compound');
        if (!states) continue;
        const pal = get(states, 'palette', 'list');
        if (!pal || pal.value.length === 0) continue;
        const local = pal.value.map((e) => {
          const s = stateString(e as Compound);
          let i = paletteIndex.get(s);
          if (i === undefined) {
            i = palette.length;
            palette.push(s);
            paletteIndex.set(s, i);
          }
          return i;
        });
        const indices = unpackIndices(get(states, 'data', 'longArray')?.value, local.length);
        const bx0 = Math.max(x0, cx * 16), bx1 = Math.min(x1, cx * 16 + 15);
        const bz0 = Math.max(z0, cz * 16), bz1 = Math.min(z1, cz * 16 + 15);
        const by0 = Math.max(y0, sy * 16), by1 = Math.min(y1, sy * 16 + 15);
        for (let y = by0; y <= by1; y++) {
          for (let z = bz0; z <= bz1; z++) {
            for (let x = bx0; x <= bx1; x++) {
              const li = (((y & 15) * 16 + (z & 15)) * 16) + (x & 15);
              blocks[(x - x0) + (z - z0) * w + (y - y0) * w * l] = local[indices[li]!]!;
            }
          }
        }
      }
      const bes = get(chunk, 'block_entities', 'list');
      for (const be of bes?.value ?? []) {
        if (be.type !== 'compound') continue;
        const bx = num(be, 'x'), by = num(be, 'y'), bz = num(be, 'z');
        const id = get(be, 'id', 'string')?.value;
        if (bx === undefined || by === undefined || bz === undefined || !id) continue;
        if (bx < x0 || bx > x1 || by < y0 || by > y1 || bz < z0 || bz > z1) continue;
        const data = nbt.compound(new Map<string, Tag>(be.value));
        for (const k of ['id', 'x', 'y', 'z', 'keepPacked']) data.value.delete(k);
        const pos: Vec3 = [bx - x0, by - y0, bz - z0];
        blockEntities.push({ pos, id, data });
      }
    }
  }
  return {
    schematic: { width: w, height: h, length: l, offset: [0, 0, 0], dataVersion, palette, blocks, blockEntities },
    missingChunks,
  };
}
