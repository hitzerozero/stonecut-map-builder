import { randomBytes } from 'node:crypto';
import { get, nbt, num, type Compound, type Tag } from '../nbt/nbt.js';
import { SnbtError, toSnbt } from '../nbt/snbt.js';
import type { SchematicEntity, Vec3 } from '../schematic/sponge.js';
import { MAX_COMMAND_BYTES } from './blocks.js';

// Turns saved entities back into /summon commands at a new place. Every copy gets a fresh UUID,
// and every reference to an entity of the same import (leads tied to another mob, riders and the
// like) is pointed at the new UUID, so copies never clash with the originals or with each other.
// Positions inside the data (the block a frame or painting hangs on, the fence a lead is tied to,
// homes and hives) move by the same offset as the entity.

export const ENTITY_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

export class EntityError extends Error {}

/** Whole-number world positions stored as [I; x, y, z]. */
const POS_ARRAYS = [
  'block_pos', 'leash', 'home_pos', 'hive_pos', 'flower_pos', 'sleeping_pos', 'beam_target', 'anchor_pos',
  'wander_target', 'patrol_target', 'bound_pos', 'travel_pos', 'jukebox_pos',
];
/** Older form: a compound with X, Y and Z. */
const POS_COMPOUNDS = ['Leash', 'HivePos', 'FlowerPos', 'BeamTarget', 'PatrolTarget', 'WanderTarget'];
/** Oldest form: three separate ints. */
const POS_TRIPLES = [
  ['TileX', 'TileY', 'TileZ'], ['SleepingX', 'SleepingY', 'SleepingZ'], ['BoundX', 'BoundY', 'BoundZ'],
  ['HomePosX', 'HomePosY', 'HomePosZ'], ['TravelPosX', 'TravelPosY', 'TravelPosZ'], ['APX', 'APY', 'APZ'],
];

export function uuidString(u: ArrayLike<number>): string {
  const hex = Array.from(u, (n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A random version 4 UUID as four ints, the way the game stores it. */
export function randomUuid(): number[] {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return [0, 4, 8, 12].map((i) => b.readInt32BE(i));
}

export function cloneTag<T extends Tag>(t: T): T {
  switch (t.type) {
    case 'compound': return { type: 'compound', value: new Map([...t.value].map(([k, v]) => [k, cloneTag(v)])) } as T;
    case 'list': return { type: 'list', itemType: t.itemType, value: t.value.map(cloneTag) } as T;
    case 'byteArray': return { type: t.type, value: Int8Array.from(t.value) } as T;
    case 'intArray': return { type: t.type, value: Int32Array.from(t.value) } as T;
    case 'longArray': return { type: t.type, value: BigInt64Array.from(t.value) } as T;
    default: return { ...t };
  }
}

/** Moves every known position in the entity (and its riders) by d. Changes c in place. */
export function shiftPositions(c: Compound, d: Vec3): void {
  const pos = c.value.get('Pos');
  if (pos?.type === 'list') pos.value.forEach((t, i) => t.type === 'double' && (t.value += d[i]!));
  for (const k of POS_ARRAYS) {
    const t = c.value.get(k);
    if (t?.type === 'intArray' && t.value.length === 3) t.value.forEach((v, i) => (t.value[i] = v + d[i]!));
  }
  for (const k of POS_COMPOUNDS) {
    const t = get(c, k, 'compound');
    if (!t) continue;
    ['X', 'Y', 'Z'].forEach((axis, i) => {
      const v = t.value.get(axis);
      if (v?.type === 'int') v.value += d[i]!;
    });
  }
  for (const keys of POS_TRIPLES) {
    keys.forEach((k, i) => {
      const v = c.value.get(k);
      if (v?.type === 'int') v.value += d[i]!;
    });
  }
  const riders = get(c, 'Passengers', 'list');
  for (const r of riders?.value ?? []) if (r.type === 'compound') shiftPositions(r, d);
}

const uuidKey = (u: ArrayLike<number>) => Array.from(u).join(',');

/** Collects the UUIDs of entities and their riders. */
export function collectUuids(c: Compound, into: number[][] = []): number[][] {
  const u = get(c, 'UUID', 'intArray');
  if (u && u.value.length === 4) into.push(Array.from(u.value));
  for (const r of get(c, 'Passengers', 'list')?.value ?? []) if (r.type === 'compound') collectUuids(r, into);
  return into;
}

/** Replaces, anywhere in the tag, each four-int UUID found in map by its new value. Changes t in place. */
export function remapUuids(t: Tag, map: Map<string, number[]>): void {
  if (t.type === 'intArray' && t.value.length === 4) {
    const next = map.get(uuidKey(t.value));
    if (next) next.forEach((v, i) => (t.value[i] = v));
  } else if (t.type === 'compound') {
    for (const v of t.value.values()) remapUuids(v, map);
  } else if (t.type === 'list') {
    for (const v of t.value) remapUuids(v, map);
  }
}

/** The block a frame, painting or lead knot hangs on, if the entity is one. */
export function hangingBlock(c: Compound): Vec3 | null {
  const bp = get(c, 'block_pos', 'intArray');
  if (bp && bp.value.length === 3) return [bp.value[0]!, bp.value[1]!, bp.value[2]!];
  const [x, y, z] = ['TileX', 'TileY', 'TileZ'].map((k) => num(c, k));
  return x !== undefined && y !== undefined && z !== undefined ? [x, y, z] : null;
}

function coord(n: number): string {
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(10) : s;
}

function dropDeep(c: Compound, key: string): void {
  c.value.delete(key);
  for (const r of get(c, 'Passengers', 'list')?.value ?? []) if (r.type === 'compound') dropDeep(r, key);
}

export interface SummonPlan {
  /** Commands in order: hanging entities first (they need their wall), then the rest. */
  commands: string[];
  /** New UUIDs of the summoned entities (riders included), as text for selectors. */
  uuids: string[];
  warnings: string[];
}

/**
 * Builds /summon commands for schematic entities pasted with their 0,0,0 corner at origin.
 * oldOrigin is where that corner was when exported, if known; otherwise the world position inside
 * each entity's data is used to work out the offset.
 */
export function summonCommands(entities: SchematicEntity[], origin: Vec3, oldOrigin?: Vec3, budget = MAX_COMMAND_BYTES): SummonPlan {
  const plan: SummonPlan = { commands: [], uuids: [], warnings: [] };
  const fresh = new Map<string, number[]>();
  for (const e of entities) for (const u of collectUuids(e.data)) fresh.set(uuidKey(u), randomUuid());
  const hanging: string[][] = [];
  const others: string[][] = [];

  for (const e of entities) {
    if (e.id === 'minecraft:player' || e.id === 'player') {
      plan.warnings.push('Skipped a player entity: players cannot be copied');
      continue;
    }
    const id = e.id.includes(':') ? e.id : `minecraft:${e.id}`;
    if (!ENTITY_ID.test(id)) {
      plan.warnings.push(`Skipped an entity with an invalid id: ${e.id.slice(0, 60)}`);
      continue;
    }
    const at: Vec3 = [origin[0] + e.pos[0], origin[1] + e.pos[1], origin[2] + e.pos[2]];
    const data = cloneTag(e.data);
    let d: Vec3;
    const saved = data.value.get('Pos');
    const savedPos = saved?.type === 'list' && saved.value.length === 3 ? saved.value.map((t) => (t.type === 'double' ? t.value : NaN)) : null;
    if (oldOrigin) d = [origin[0] - oldOrigin[0], origin[1] - oldOrigin[1], origin[2] - oldOrigin[2]];
    else if (savedPos && savedPos.every(Number.isFinite)) d = [0, 1, 2].map((i) => Math.round(at[i]! - savedPos[i]!)) as Vec3;
    else {
      const hb = hangingBlock(data);
      d = hb ? ([0, 1, 2].map((i) => Math.floor(at[i]!) - hb[i]!) as Vec3) : [0, 0, 0];
    }
    shiftPositions(data, d);
    if (!get(data, 'UUID', 'intArray')) {
      const u = randomUuid();
      data.value.set('UUID', nbt.intArray(u));
      fresh.set(uuidKey(u), u);
    }
    remapUuids(data, fresh);
    const newUuid = uuidString(get(data, 'UUID', 'intArray')!.value);
    for (const u of collectUuids(data)) plan.uuids.push(uuidString(u));
    data.value.delete('Pos');
    data.value.delete('id');
    dropDeep(data, 'Brain');

    const hb = hangingBlock(data);
    const place = hb ?? at;
    const head = `summon ${id} ${place.map(coord).join(' ')} `;
    const cmds = fitCommands(head, newUuid, data, budget, plan.warnings);
    if (!cmds) {
      plan.warnings.push(`Skipped ${id} at ${at.map((v) => v.toFixed(1)).join(' ')}: its data cannot go into a command`);
      continue;
    }
    (hb ? hanging : others).push(cmds);
  }
  plan.commands = [...hanging.flat(), ...others.flat()];
  return plan;
}

/** One summon if it fits; otherwise a summon with what fits and a data merge per remaining key. */
function fitCommands(head: string, uuid: string, data: Compound, budget: number, warnings: string[]): string[] | null {
  let full: string;
  try {
    full = head + toSnbt(data);
  } catch (e) {
    if (!(e instanceof SnbtError)) throw e;
    full = '';
  }
  if (full && Buffer.byteLength(full) <= budget) return [full];
  const core = nbt.compound({ UUID: data.value.get('UUID')! });
  const merges: string[] = [];
  for (const [k, v] of data.value) {
    if (k === 'UUID') continue;
    let part: string;
    try {
      part = toSnbt(nbt.compound({ [k]: v }));
    } catch {
      warnings.push(`Left out ${k} of an entity: it has text that cannot go into a command`);
      continue;
    }
    const trial = nbt.compound(new Map([...core.value, [k, v]]));
    if (Buffer.byteLength(head + toSnbt(trial)) <= budget) core.value.set(k, v);
    else if (k !== 'Passengers' && Buffer.byteLength(`data merge entity ${uuid} ${part}`) <= budget) merges.push(`data merge entity ${uuid} ${part}`);
    else warnings.push(`Left out ${k} of an entity: it is too long for RCON`);
  }
  const summon = head + toSnbt(core);
  return Buffer.byteLength(summon) <= budget ? [summon, ...merges] : null;
}

/** Commands that remove entities without loot: living ones get an empty loot table first. */
export function removeCommands(list: { uuid: number[] | null; data: Compound }[]): string[] {
  const out: string[] = [];
  const remove = (data: Compound) => {
    // Riders first: killing a vehicle would only throw them off.
    for (const r of get(data, 'Passengers', 'list')?.value ?? []) if (r.type === 'compound') remove(r);
    const uuid = get(data, 'UUID', 'intArray');
    if (!uuid || uuid.value.length !== 4) return;
    const u = uuidString(uuid.value);
    if (data.value.has('Health')) out.push(`data merge entity ${u} {DeathLootTable:"minecraft:empty"}`);
    out.push(`kill ${u}`);
  };
  for (const e of list) remove(e.data);
  return out;
}
