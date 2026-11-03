import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import {
  type Batch,
  cloneCommand,
  type FillMode,
  fillCommands,
  isAir,
  packPlacements,
  type Placement,
  schematicPlacements,
} from '../mc/blocks.js';
import { type Box, boxAt, boxSize, boxVolume, chunksOf, makeBox, splitBox, unionBox, type Vec3 } from '../mc/box.js';
import { STATE_DIR, type TestServer } from '../mc/testserver.js';
import { type BatchResult, emptyResult, mergeResults, runInOrder, runParallel } from '../rcon/rcon.js';
import { resolveInside, shown } from '../safety/paths.js';
import { readSponge, writeSponge, type Schematic, type SpongeVersion } from '../schematic/sponge.js';
import { AIR, type AreaRead, type Dimension, readArea, regionDir } from '../world/region.js';
import { readEntities, toSchematicEntities, type WorldEntity } from '../world/entities.js';
import { removeCommands, summonCommands, uuidString } from '../mc/entities.js';
import type { SchematicEntity } from '../schematic/sponge.js';
import { UndoStore, type UndoEntry } from './undo.js';

// Block work on the test server: keeps the area loaded, takes a snapshot for undo first,
// then sends the commands in batches over RCON.

const PARALLEL = 4;
const MAX_CHUNKS = 1024;

export class WorldError extends Error {}

const DIM_ID: Record<Dimension, string> = { overworld: 'minecraft:overworld', the_nether: 'minecraft:the_nether', the_end: 'minecraft:the_end' };

export function inDimension(dim: Dimension, cmd: string): string {
  return dim === 'overworld' ? cmd : `execute in ${DIM_ID[dim]} run ${cmd}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChangeResult {
  commands: number;
  changed: number;
  unchanged: number;
  errors: { command: string; reply: string }[];
  warnings: string[];
  undo: number | null;
  seconds: number;
  /** Entities removed from and summoned into the area. */
  entities?: { removed: number; summoned: number };
}

export type EntityMode = 'none' | 'replace' | 'restore';

export interface AreaWithEntities extends AreaRead {
  entities: WorldEntity[];
}

export interface ChangeOptions {
  dimension: Dimension;
  /** Skip the undo snapshot (only allowed for areas too big to snapshot, after backup_world). */
  skipBackup?: boolean;
}

export class World {
  readonly undo: UndoStore;

  constructor(readonly server: TestServer, readonly config: Config) {
    this.undo = new UndoStore(join(server.dir, STATE_DIR, 'undo'), config.undoHistory);
  }

  private async cmd(c: string): Promise<string> {
    return (await this.server.connection()).command(c);
  }

  /** Asks the server to write everything to disk, so the region files match the world. */
  async save(): Promise<void> {
    const reply = await this.cmd('save-all flush');
    if (/error|failed/i.test(reply)) throw new WorldError(`Saving failed: ${reply}`);
  }

  async read(box: Box, dim: Dimension, withEntities = false): Promise<AreaWithEntities> {
    await this.save();
    const area = await readArea(regionDir(this.server.worldDir, dim), box);
    if (!withEntities) return { ...area, entities: [] };
    const entities = await readEntities(regionDir(this.server.worldDir, dim, 'entities'), box);
    this.checkEntities(entities.length, 'The area has');
    area.schematic.entities = toSchematicEntities(entities, box);
    area.schematic.origin = [...box.min];
    return { ...area, entities };
  }

  /** Entities in the area right now (saved first). */
  async entitiesIn(box: Box, dim: Dimension): Promise<WorldEntity[]> {
    await this.save();
    return readEntities(regionDir(this.server.worldDir, dim, 'entities'), box);
  }

  checkEntities(n: number, what: string): void {
    if (n > this.config.maxEntities) {
      throw new WorldError(`${what} ${n} entities, over the limit of ${this.config.maxEntities} (maxEntities in the config). Use a smaller area, or include_entities: false.`);
    }
  }

  /** Removes entities without loot (living ones get an empty loot table first). */
  async removeEntities(list: WorldEntity[], dim: Dimension): Promise<{ removed: number; result: BatchResult }> {
    if (!list.length) return { removed: 0, result: emptyResult() };
    const result = await runInOrder(await this.server.connection(), removeCommands(list).map((c) => inDimension(dim, c)), 1000);
    result.errors = result.errors.filter((e) => !e.command.includes('DeathLootTable'));
    return { removed: list.length, result };
  }

  /** UUIDs of the items and XP orbs in and right around the box, before a change. */
  private async dropsBefore(box: Box, dim: Dimension): Promise<Set<string>> {
    return new Set((await this.entitiesIn(grow(box), dim)).filter(isDrop).map((e) => e.uuid?.join(',') ?? ''));
  }

  /**
   * Removes items and XP orbs that appeared in or right around the box during a change: blocks such as
   * doors and torches pop off when what holds them is cleared, and leads drop when their mob goes.
   */
  private async sweepDrops(box: Box, dim: Dimension, before: Set<string>): Promise<number> {
    await sleep(100);
    const drops = (await this.entitiesIn(grow(box), dim)).filter((e) => isDrop(e) && e.uuid && !before.has(e.uuid.join(',')));
    await runInOrder(await this.server.connection(), drops.map((e) => inDimension(dim, `kill ${uuidString(e.uuid!)}`)));
    return drops.length;
  }

  /** Summons schematic entities with their corner at origin, in order (a summon may be followed by data merges). */
  async summonEntities(entities: SchematicEntity[], origin: Vec3, oldOrigin: Vec3 | undefined, dim: Dimension, warnings: string[]): Promise<{ summoned: number; result: BatchResult }> {
    if (!entities.length) return { summoned: 0, result: emptyResult() };
    const plan = summonCommands(entities, origin, oldOrigin);
    warnings.push(...plan.warnings);
    const result = await runInOrder(await this.server.connection(), plan.commands.map((c) => inDimension(dim, c)), 1000);
    const summoned = plan.commands.filter((c) => c.startsWith('summon ')).length - result.errors.filter((e) => e.command.includes('summon ')).length;
    return { summoned, result };
  }

  /** Whether an entity with this UUID is alive anywhere loaded. A mob in its death animation counts as gone. */
  private async alive(uuid: string): Promise<boolean> {
    const r = await this.cmd(`data get entity ${uuid} Health`);
    if (/No entity was found/i.test(r)) return false;
    const m = /:\s*(-?[\d.]+)f\s*$/.exec(r.trim());
    return !(m && Number(m[1]) <= 0);
  }

  /** Force-loads the chunks of boxes while fn runs, then releases only the ones it added. */
  async withLoaded<T>(boxes: Box[], dim: Dimension, fn: () => Promise<T>): Promise<T> {
    const keys = new Map<string, [number, number]>();
    for (const b of boxes) for (const c of chunksOf(b)) keys.set(`${c[0]},${c[1]}`, c);
    if (keys.size > MAX_CHUNKS) throw new WorldError(`That touches ${keys.size} chunks; the limit is ${MAX_CHUNKS} per call. Split the work into smaller areas.`);
    const listed = await this.cmd(inDimension(dim, 'forceload query'));
    const already = new Set([...listed.matchAll(/\[(-?\d+), (-?\d+)\]/g)].map((m) => `${m[1]},${m[2]}`));
    const added = [...keys.entries()].filter(([k]) => !already.has(k)).map(([, c]) => c);
    const conns = await this.server.connections(PARALLEL);
    const add = await runParallel(conns, added.map(([cx, cz]) => inDimension(dim, `forceload add ${cx * 16} ${cz * 16}`)));
    try {
      if (add.errors.length) throw new WorldError(`Could not load the area: ${add.errors[0]!.reply}`);
      await this.waitLoaded([...keys.values()], dim);
      return await fn();
    } finally {
      await runParallel(conns, added.map(([cx, cz]) => inDimension(dim, `forceload remove ${cx * 16} ${cz * 16}`))).catch(() => undefined);
    }
  }

  private async waitLoaded(chunks: [number, number][], dim: Dimension, timeoutMs = 60_000): Promise<void> {
    let pending = chunks;
    const until = Date.now() + timeoutMs;
    const conns = await this.server.connections(PARALLEL);
    while (pending.length) {
      const still: [number, number][] = [];
      let next = 0;
      await Promise.all(
        conns.map(async (c) => {
          while (next < pending.length) {
            const ch = pending[next++]!;
            const r = await c.command(inDimension(dim, `execute if loaded ${ch[0] * 16} 0 ${ch[1] * 16}`));
            if (!/passed/i.test(r)) still.push(ch);
          }
        }),
      );
      pending = still;
      if (!pending.length) return;
      if (Date.now() > until) throw new WorldError(`${pending.length} chunks did not load within ${timeoutMs / 1000}s`);
      await sleep(200);
    }
  }

  /** Saves the area as it is now, so undo can put it back. Null when automatic backups are off. */
  async snapshot(box: Box, dim: Dimension, label: string, opts: ChangeOptions): Promise<UndoEntry | null> {
    if (!this.config.autoBackup) return null;
    const volume = boxVolume(box);
    if (volume > this.config.maxImportBlocks) {
      if (opts.skipBackup) return null;
      throw new WorldError(
        `The area is ${volume} blocks, too big for an undo snapshot (limit ${this.config.maxImportBlocks}). Run backup_world first, then call again with skip_backup: true.`,
      );
    }
    const { schematic } = await this.read(box, dim, this.config.includeEntities);
    return this.undo.push({ label, box, dimension: dim, blocks: volume, entities: this.config.includeEntities }, writeSponge(schematic, 3));
  }

  private async runBatch(batch: Batch, dim: Dimension): Promise<BatchResult> {
    const conns = await this.server.connections(PARALLEL);
    const first = await runParallel(conns, batch.first.map((c) => inDimension(dim, c)));
    const second = await runInOrder(conns[0]!, batch.second.map((c) => inDimension(dim, c)));
    return mergeResults(first, second);
  }

  private result(r: BatchResult, warnings: string[], undo: UndoEntry | null, began: number, entities?: { removed: number; summoned: number }): ChangeResult {
    return {
      ...(entities ? { entities } : {}),
      commands: r.ran,
      changed: r.changed,
      unchanged: r.unchanged,
      errors: r.errors,
      warnings,
      undo: undo?.id ?? null,
      seconds: Math.round((Date.now() - began) / 100) / 10,
    };
  }

  private checkSize(volume: number, what: string): void {
    if (volume > this.config.maxFillBlocks) {
      throw new WorldError(`${what} covers ${volume} blocks, over the limit of ${this.config.maxFillBlocks} (maxFillBlocks in the config). Split it into smaller steps.`);
    }
  }

  async place(placements: Placement[], opts: ChangeOptions): Promise<ChangeResult> {
    const began = Date.now();
    const box = unionBox(placements.map((p) => ({ min: p.pos, max: p.pos })));
    this.checkSize(placements.length, 'This placement');
    const batch = packPlacements(placements);
    return this.withLoaded([box], opts.dimension, async () => {
      const undo = await this.snapshot(box, opts.dimension, `place ${placements.length} blocks`, opts);
      const r = await this.runBatch(batch, opts.dimension);
      return this.result(r, batch.warnings, undo, began);
    });
  }

  async fill(fills: { box: Box; state: string; mode?: FillMode; filter?: string }[], opts: ChangeOptions, label = 'fill'): Promise<ChangeResult> {
    const began = Date.now();
    const total = fills.reduce((a, f) => a + boxVolume(f.box), 0);
    this.checkSize(total, 'This fill');
    const box = unionBox(fills.map((f) => f.box));
    return this.withLoaded(fills.map((f) => f.box), opts.dimension, async () => {
      const undo = await this.snapshot(box, opts.dimension, label, opts);
      const conns = await this.server.connections(PARALLEL);
      let r = emptyResult();
      for (const f of fills) {
        const cmds = fillCommands(f.box, f.state, f.mode, f.filter).map((c) => inDimension(opts.dimension, c));
        const hollow = f.mode === 'hollow' || f.mode === 'outline';
        r = mergeResults(r, hollow ? await runInOrder(conns[0]!, cmds) : await runParallel(conns, cmds));
      }
      return this.result(r, [], undo, began);
    });
  }

  async copy(src: Box, dest: Vec3, masked: boolean, opts: ChangeOptions): Promise<ChangeResult> {
    const began = Date.now();
    const destBox = boxAt(dest, boxSize(src));
    this.checkSize(boxVolume(src), 'This copy');
    const overlap = [0, 1, 2].every((i) => src.min[i]! <= destBox.max[i]! && destBox.min[i]! <= src.max[i]!);
    const parts = splitBox(src, 32768);
    if (overlap && parts.length > 1) throw new WorldError('Source and destination overlap and the area is over 32768 blocks. Copy it in two steps through a free spot.');
    return this.withLoaded([src, destBox], opts.dimension, async () => {
      const undo = await this.snapshot(destBox, opts.dimension, 'copy', opts);
      const cmds = parts.map((p) => {
        const d: Vec3 = [dest[0] + p.min[0] - src.min[0], dest[1] + p.min[1] - src.min[1], dest[2] + p.min[2] - src.min[2]];
        return inDimension(opts.dimension, cloneCommand(p, d, masked, overlap));
      });
      const r = await runInOrder(await this.server.connection(), cmds);
      return this.result(r, [], undo, began);
    });
  }

  /** Sets the box to air. With entities, removes the entities in it first (undo brings them back). */
  async clear(box: Box, opts: ChangeOptions, withEntities: boolean): Promise<ChangeResult> {
    const began = Date.now();
    this.checkSize(boxVolume(box), 'This clear');
    return this.withLoaded([box], opts.dimension, async () => {
      const undo = await this.snapshot(box, opts.dimension, 'clear', opts);
      const drops = await this.dropsBefore(box, opts.dimension);
      let removed = 0;
      let r = emptyResult();
      if (withEntities) {
        const gone = await this.removeEntities(await this.entitiesIn(box, opts.dimension), opts.dimension);
        removed = gone.removed;
        r = gone.result;
      }
      const conns = await this.server.connections(PARALLEL);
      r = mergeResults(r, await runParallel(conns, fillCommands(box, AIR).map((c) => inDimension(opts.dimension, c))));
      await this.sweepDrops(box, opts.dimension, drops);
      return this.result(r, [], undo, began, withEntities ? { removed, summoned: 0 } : undefined);
    });
  }

  /**
   * Pastes a schematic with its corner at origin. includeAir clears the area first.
   * Entities: 'replace' removes the entities in the area (when includeAir) and summons those of the
   * schematic; 'restore' (undo) removes only entities that were not there before and summons only
   * the missing ones.
   */
  async paste(s: Schematic, origin: Vec3, includeAir: boolean, opts: ChangeOptions, label: string, snapshot = true, entityMode: EntityMode = 'none'): Promise<ChangeResult> {
    const began = Date.now();
    const box = boxAt(origin, [s.width, s.height, s.length]);
    const volume = boxVolume(box);
    if (volume > this.config.maxImportBlocks) {
      throw new WorldError(`The schematic is ${volume} blocks, over the limit of ${this.config.maxImportBlocks} (maxImportBlocks in the config).`);
    }
    const { placements, warnings } = schematicPlacements(s, origin);
    const batch = packPlacements(placements);
    warnings.push(...batch.warnings);
    const entities = entityMode === 'none' ? [] : (s.entities ?? []);
    this.checkEntities(entities.length, 'The schematic has');
    const dim = opts.dimension;
    return this.withLoaded([box], dim, async () => {
      const undo = snapshot ? await this.snapshot(box, dim, label, opts) : null;
      const drops = includeAir ? await this.dropsBefore(box, dim) : null;
      let r = emptyResult();
      let removed = 0;
      let toSummon = entities;
      if (entityMode === 'replace' && includeAir) {
        const gone = await this.removeEntities(await this.entitiesIn(box, dim), dim);
        removed = gone.removed;
        r = gone.result;
      } else if (entityMode === 'restore') {
        const before = new Set(entities.map((e) => snapshotUuid(e)).filter((u): u is string => u !== null));
        const added = (await this.entitiesIn(box, dim)).filter((e) => !e.uuid || !before.has(uuidString(e.uuid)));
        const gone = await this.removeEntities(added, dim);
        removed = gone.removed;
        r = gone.result;
        const missing: SchematicEntity[] = [];
        for (const e of entities) {
          const u = snapshotUuid(e);
          if (u === null || !(await this.alive(u))) missing.push(e);
        }
        toSummon = missing;
      }
      if (includeAir) {
        const conns = await this.server.connections(PARALLEL);
        r = mergeResults(r, await runParallel(conns, fillCommands(box, AIR).map((c) => inDimension(dim, c))));
      }
      r = mergeResults(r, await this.runBatch(batch, dim));
      if (drops) await this.sweepDrops(box, dim, drops);
      let summoned = 0;
      if (entityMode !== 'none') {
        const made = await this.summonEntities(toSummon, origin, s.origin, dim, warnings);
        summoned = made.summoned;
        r = mergeResults(r, made.result);
      }
      return this.result(r, warnings, undo, began, entityMode === 'none' ? undefined : { removed, summoned });
    });
  }

  async importFile(file: string, origin: Vec3, includeAir: boolean, opts: ChangeOptions, withEntities: boolean): Promise<ChangeResult & { size: Vec3; version: SpongeVersion; dataVersion: number }> {
    const { schematic, version } = readSponge(readFileSync(file), { maxBlocks: this.config.maxImportBlocks, ...(withEntities ? { maxEntities: this.config.maxEntities } : {}) });
    const r = await this.paste(schematic, origin, includeAir, opts, `import ${shown(this.server.dir, file)}`, true, withEntities ? 'replace' : 'none');
    return { ...r, size: [schematic.width, schematic.height, schematic.length], version, dataVersion: schematic.dataVersion };
  }

  async exportFile(box: Box, file: string, version: SpongeVersion, dim: Dimension, withEntities: boolean): Promise<{ file: string; size: Vec3; blocks: number; nonAir: number; blockEntities: number; entities: number; bytes: number; missingChunks: [number, number][] }> {
    const volume = boxVolume(box);
    if (volume > this.config.maxImportBlocks) throw new WorldError(`The area is ${volume} blocks, over the limit of ${this.config.maxImportBlocks} (maxImportBlocks in the config).`);
    const { schematic, missingChunks } = await this.read(box, dim, withEntities);
    const data = writeSponge(schematic, version);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    let nonAir = 0;
    for (const i of schematic.blocks) if (!isAir(schematic.palette[i]!)) nonAir++;
    return { file: shown(this.server.dir, file), size: boxSize(box), blocks: volume, nonAir, blockEntities: schematic.blockEntities.length, entities: schematic.entities?.length ?? 0, bytes: data.length, missingChunks };
  }

  async undoLast(): Promise<ChangeResult & { label: string } | null> {
    const last = this.undo.latest();
    if (!last) return null;
    const { schematic } = readSponge(last.schem);
    const r = await this.paste(schematic, last.entry.box.min, true, { dimension: last.entry.dimension }, 'undo', false, last.entry.entities ? 'restore' : 'none');
    if (r.errors.length === 0) this.undo.remove(last.entry.id);
    return { ...r, label: last.entry.label };
  }
}

/** The box with one more block on every side. */
function grow(b: Box): Box {
  return { min: [b.min[0] - 1, b.min[1] - 1, b.min[2] - 1], max: [b.max[0] + 1, b.max[1] + 1, b.max[2] + 1] };
}

function isDrop(e: WorldEntity): boolean {
  return e.id === 'minecraft:item' || e.id === 'minecraft:experience_orb';
}

function snapshotUuid(e: SchematicEntity): string | null {
  const u = e.data.value.get('UUID');
  return u?.type === 'intArray' && u.value.length === 4 ? uuidString(u.value) : null;
}

export function boxFrom(from: Vec3, to: Vec3): Box {
  return makeBox(from, to);
}

export function serverPath(server: TestServer, rel: string): string {
  return resolveInside(server.dir, rel, { hidden: [STATE_DIR] });
}

export function exists(p: string): boolean {
  return existsSync(p);
}
