import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { removeCommands, summonCommands, uuidString } from '../src/mc/entities.js';
import { get, nbt, writeNbt, type Compound, type Tag } from '../src/nbt/nbt.js';
import { readSponge, writeSponge, type Schematic, type SchematicEntity } from '../src/schematic/sponge.js';
import { readEntities, toSchematicEntities } from '../src/world/entities.js';
import { regionDir } from '../src/world/region.js';
import { tempDir } from './helpers/temp.js';

const pos = (x: number, y: number, z: number) => nbt.list('double', [nbt.double(x), nbt.double(y), nbt.double(z)]);
const uuid = (...v: number[]) => nbt.intArray(v);

// Saved entities as Minecraft 1.21 writes them (trimmed), around the corner 100, -60, 100.
const frame = () => nbt.compound({
  id: nbt.string('minecraft:item_frame'), Pos: pos(105.5, -57.5, 101.03125), UUID: uuid(1, 1, 1, 1), Facing: nbt.byte(3),
  block_pos: nbt.intArray([105, -58, 101]), ItemRotation: nbt.byte(3), Rotation: nbt.list('float', [nbt.float(0), nbt.float(0)]),
  Item: nbt.compound({ id: nbt.string('minecraft:diamond_sword'), count: nbt.int(1) }),
});
const painting = () => nbt.compound({
  id: nbt.string('minecraft:painting'), Pos: pos(107.96875, -57, 104), UUID: uuid(2, 2, 2, 2), facing: nbt.byte(1),
  block_pos: nbt.intArray([107, -58, 104]), variant: nbt.string('minecraft:skull_and_roses'),
});
const bob = () => nbt.compound({
  id: nbt.string('minecraft:villager'), Pos: pos(103.5, -58, 103.5), UUID: uuid(11, 22, 33, 44), Health: nbt.float(20),
  NoAI: nbt.byte(1), CustomName: nbt.string('Bob'), Brain: nbt.compound({ memories: nbt.compound({}) }),
});
const follower = () => nbt.compound({
  id: nbt.string('minecraft:sheep'), Pos: pos(101.5, -58, 102.5), UUID: uuid(5, 5, 5, 5), Health: nbt.float(8),
  CustomName: nbt.string('Follower'), leash: nbt.compound({ UUID: uuid(11, 22, 33, 44) }),
});
const dolly = () => nbt.compound({
  id: nbt.string('minecraft:sheep'), Pos: pos(106.5, -58, 104.5), UUID: uuid(6, 6, 6, 6), Health: nbt.float(8),
  CustomName: nbt.string('Dolly'), leash: nbt.intArray([106, -58, 103]),
});
const cart = () => nbt.compound({
  id: nbt.string('minecraft:minecart'), Pos: pos(104.5, -58, 106.5), UUID: uuid(7, 7, 7, 7),
  Passengers: nbt.list('compound', [nbt.compound({ id: nbt.string('minecraft:pig'), Pos: pos(104.5, -57.6, 106.5), UUID: uuid(8, 8, 8, 8), Health: nbt.float(10), CustomName: nbt.string('Rider') })]),
});

const BOX = { min: [100, -60, 100] as [number, number, number], max: [108, -55, 108] as [number, number, number] };

function asSchematic(list: Compound[]): SchematicEntity[] {
  return toSchematicEntities(list.map((c) => ({ id: (c.value.get('id') as { value: string }).value, pos: (get(c, 'Pos', 'list')!.value.map((t) => (t as { value: number }).value)) as [number, number, number], uuid: null, data: c })), BOX);
}

/** Writes an entity region file with one chunk holding the given entities. */
function writeEntityRegion(dir: string, cx: number, cz: number, entities: Tag[]) {
  const chunk = nbt.compound({ DataVersion: nbt.int(4671), Position: nbt.intArray([cx, cz]), Entities: nbt.list('compound', entities) });
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

/** Parses "summon <id> x y z {...}" into its parts (the SNBT is checked as text). */
function parseSummon(c: string) {
  const m = /^summon (\S+) (\S+) (\S+) (\S+) (\{.*\})$/.exec(c)!;
  return { id: m[1]!, at: [Number(m[2]), Number(m[3]), Number(m[4])], snbt: m[5]! };
}

it('reads entities inside an area from a saved entity file, leaving out players, dead mobs and those outside', async () => {
  const world = tempDir('entities');
  const dead = nbt.compound({ id: nbt.string('minecraft:sheep'), Pos: pos(102, -58, 102), Health: nbt.float(0) });
  const outside = nbt.compound({ id: nbt.string('minecraft:cow'), Pos: pos(109.2, -58, 102), Health: nbt.float(10) });
  const player = nbt.compound({ id: nbt.string('minecraft:player'), Pos: pos(103, -58, 103) });
  writeEntityRegion(regionDir(world, 'overworld', 'entities'), 6, 6, [frame(), bob(), dead, outside, player]);
  const list = await readEntities(regionDir(world, 'overworld', 'entities'), BOX);
  expect(list.map((e) => e.id)).toEqual(['minecraft:item_frame', 'minecraft:villager']);
  expect(list[1]!.uuid).toEqual([11, 22, 33, 44]);
  expect(list[0]!.pos).toEqual([105.5, -57.5, 101.03125]);
  expect(await readEntities(regionDir(world, 'overworld', 'entities'), { min: [0, 0, 0], max: [5, 5, 5] })).toEqual([]);
});

it('round-trips entities through version 3 and version 2 schematics, with the export corner', () => {
  const s: Schematic = {
    width: 1, height: 1, length: 1, offset: [0, 0, 0], dataVersion: 4671, palette: ['minecraft:air'], blocks: new Uint32Array(1), blockEntities: [],
    entities: asSchematic([frame(), cart()]), origin: [100, -60, 100],
  };
  for (const v of [3, 2] as const) {
    const back = readSponge(writeSponge(s, v)).schematic;
    expect(back.origin).toEqual([100, -60, 100]);
    expect(back.entities!.map((e) => [e.id, e.pos])).toEqual([['minecraft:item_frame', [5.5, 2.5, 1.03125]], ['minecraft:minecart', [4.5, 2, 6.5]]]);
    expect(get(back.entities![0]!.data, 'Item', 'compound')).toEqual(get(frame(), 'Item', 'compound'));
    expect(get(back.entities![1]!.data, 'Passengers', 'list')!.value).toHaveLength(1);
  }
  expect(() => readSponge(writeSponge(s, 3), { maxEntities: 1 })).toThrow(/2 entities, over the limit of 1/);
});

it('summons copies at the new place: hanging entities on their block, others at their exact position', () => {
  const plan = summonCommands(asSchematic([bob(), frame(), painting()]), [100, -60, 130], [100, -60, 100]);
  const cmds = plan.commands.map(parseSummon);
  expect(cmds.map((c) => c.id)).toEqual(['minecraft:item_frame', 'minecraft:painting', 'minecraft:villager']);
  expect(cmds[0]!.at).toEqual([105, -58, 131]);
  expect(cmds[0]!.snbt).toContain('block_pos:[I;105,-58,131]');
  expect(cmds[0]!.snbt).toContain('Item:{id:"minecraft:diamond_sword",count:1}');
  expect(cmds[0]!.snbt).toContain('ItemRotation:3b');
  expect(cmds[1]!.at).toEqual([107, -58, 134]);
  expect(cmds[1]!.snbt).toContain('variant:"minecraft:skull_and_roses"');
  expect(cmds[2]!.at).toEqual([103.5, -58, 133.5]);
  expect(cmds[2]!.snbt).not.toMatch(/Pos:|Brain:|id:/);
  expect(cmds[2]!.snbt).toContain('CustomName:"Bob"');
});

it('gives every copy a fresh UUID and keeps leads and riders pointing at the copies', () => {
  const plan = summonCommands(asSchematic([bob(), follower(), dolly(), cart()]), [100, -60, 130], [100, -60, 100]);
  const byName = (n: string) => plan.commands.find((c) => c.includes(`CustomName:"${n}"`))!;
  const uuidOf = (c: string) => /UUID:\[I;(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/.exec(c)!.slice(1, 5).join(',');
  const newBob = uuidOf(byName('Bob'));
  expect(newBob).not.toBe('11,22,33,44');
  expect(byName('Follower')).toContain(`leash:{UUID:[I;${newBob}]}`);
  expect(byName('Dolly')).toContain('leash:[I;106,-58,133]');
  const cartCmd = plan.commands.find((c) => c.startsWith('summon minecraft:minecart'))!;
  expect(cartCmd).toContain('Passengers:[{id:"minecraft:pig"');
  expect(cartCmd).not.toContain('UUID:[I;8,8,8,8]');
  expect(new Set(plan.uuids).size).toBe(5);
  expect(plan.uuids).not.toContain(uuidString([11, 22, 33, 44]));
  // A second import makes different UUIDs again.
  expect(uuidOf(summonCommands(asSchematic([bob()]), [0, 0, 0], [100, -60, 100]).commands[0]!)).not.toBe(newBob);
});

it('works out the offset from the saved position when the file has no export corner', () => {
  const plan = summonCommands(asSchematic([dolly()]), [200, -60, 100]);
  expect(plan.commands[0]).toContain('leash:[I;206,-58,103]');
  expect(parseSummon(plan.commands[0]!).at).toEqual([206.5, -58, 104.5]);
});

it('refuses players and bad ids, and splits data too long for one command into data merges', () => {
  const big = bob();
  big.value.set('Inventory', nbt.list('compound', Array.from({ length: 20 }, (_, i) => nbt.compound({ id: nbt.string(`minecraft:item_number_${i}`), count: nbt.int(1) }))));
  big.value.set('Gossips', nbt.list('compound', Array.from({ length: 20 }, (_, i) => nbt.compound({ Type: nbt.string('minor_positive'), Value: nbt.int(i), Target: uuid(i, i, i, i) }))));
  const ents: SchematicEntity[] = [
    { id: 'minecraft:player', pos: [0, 0, 0], data: nbt.compound({}) },
    { id: 'minecraft:bad id; op me', pos: [0, 0, 0], data: nbt.compound({}) },
    ...asSchematic([big]),
  ];
  const plan = summonCommands(ents, [100, -60, 100], [100, -60, 100]);
  expect(plan.warnings.join(' ')).toMatch(/player/);
  expect(plan.warnings.join(' ')).toMatch(/invalid id/);
  expect(plan.commands[0]).toMatch(/^summon minecraft:villager /);
  expect(plan.commands.every((c) => Buffer.byteLength(c) <= 1446)).toBe(true);
  const merges = plan.commands.filter((c) => c.startsWith('data merge entity '));
  expect(merges.length).toBeGreaterThan(0);
  expect(merges.some((c) => /Inventory:\[|Gossips:\[/.test(c))).toBe(true);
  expect(plan.warnings.join(' ')).not.toMatch(/too long/);
  expect(merges.every((c) => c.startsWith(`data merge entity ${uuidString(JSON.parse(`[${/UUID:\[I;([^\]]+)\]/.exec(plan.commands[0]!)![1]}]`))} `))).toBe(true);
});

it('removes riders before their vehicle and empties the loot of living entities first', () => {
  const data = cart();
  expect(removeCommands([{ uuid: [7, 7, 7, 7], data }])).toEqual([
    `data merge entity ${uuidString([8, 8, 8, 8])} {DeathLootTable:"minecraft:empty"}`,
    `kill ${uuidString([8, 8, 8, 8])}`,
    `kill ${uuidString([7, 7, 7, 7])}`,
  ]);
  expect(uuidString([11, 22, 33, 44])).toBe('0000000b-0000-0016-0000-00210000002c');
  expect(uuidString([-1, 0, 0, 1])).toBe('ffffffff-0000-0000-0000-000000000001');
});
