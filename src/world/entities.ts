import { get, nbt, num, type Compound } from '../nbt/nbt.js';
import type { Box } from '../mc/box.js';
import type { SchematicEntity, Vec3 } from '../schematic/sponge.js';
import { readChunk, RegionError } from './region.js';

// Reads entities from the world's saved entity files (entities/r.X.Z.mca, Minecraft 1.17 and newer).
// Like block reading, the server saves first and the files are only read.

export interface WorldEntity {
  id: string;
  /** World position. */
  pos: Vec3;
  /** UUID as the game stores it: four ints, most significant first. */
  uuid: number[] | null;
  data: Compound;
}

export function entityPos(c: Compound): Vec3 | null {
  const p = c.value.get('Pos');
  if (!p || p.type !== 'list' || p.value.length !== 3) return null;
  const v = p.value.map((t) => (t.type === 'double' || t.type === 'float' ? t.value : NaN));
  return v.every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!] : null;
}

export function entityUuid(c: Compound): number[] | null {
  const u = get(c, 'UUID', 'intArray');
  return u && u.value.length === 4 ? Array.from(u.value) : null;
}

/** A mob in its death animation is still saved for a moment; it is not part of the build. */
function isDead(c: Compound): boolean {
  const health = num(c, 'Health');
  return health !== undefined && health <= 0;
}

/** True when a position is inside the box, counting the whole of each edge block. */
export function insideBox(p: Vec3, box: Box): boolean {
  return [0, 1, 2].every((i) => p[i]! >= box.min[i]! && p[i]! < box.max[i]! + 1);
}

export async function readEntities(dir: string, box: Box): Promise<WorldEntity[]> {
  const out: WorldEntity[] = [];
  const regions = new Map<string, Buffer | null>();
  for (let cx = Math.floor(box.min[0] / 16); cx <= Math.floor(box.max[0] / 16); cx++) {
    for (let cz = Math.floor(box.min[2] / 16); cz <= Math.floor(box.max[2] / 16); cz++) {
      const chunk = await readChunk(dir, regions, cx, cz);
      if (!chunk) continue;
      const list = get(chunk, 'Entities', 'list');
      if (!list) continue;
      for (const e of list.value) {
        if (e.type !== 'compound') continue;
        const id = get(e, 'id', 'string')?.value;
        const pos = entityPos(e);
        if (!id || !pos) throw new RegionError(`An entity in chunk ${cx},${cz} has no id or position`);
        if (id === 'minecraft:player' || isDead(e) || !insideBox(pos, box)) continue;
        out.push({ id, pos, uuid: entityUuid(e), data: e });
      }
    }
  }
  return out;
}

/** Entities as schematic entries, with positions relative to the box's lowest corner. */
export function toSchematicEntities(list: WorldEntity[], box: Box): SchematicEntity[] {
  return list.map((e) => {
    const data = nbt.compound(new Map(e.data.value));
    data.value.delete('id');
    return { id: e.id, pos: [e.pos[0] - box.min[0], e.pos[1] - box.min[1], e.pos[2] - box.min[2]], data };
  });
}
