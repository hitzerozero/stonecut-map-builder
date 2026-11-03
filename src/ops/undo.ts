import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Box } from '../mc/box.js';
import type { Dimension } from '../world/region.js';

// Snapshots taken before each change, newest last. Each is a .schem of the area as it was, plus a
// small JSON with where it goes. Undo pastes the newest one back and removes it.

export interface UndoEntry {
  id: number;
  label: string;
  box: Box;
  dimension: Dimension;
  time: string;
  blocks: number;
  /** The snapshot holds the entities of the area too. */
  entities?: boolean;
}

export class UndoStore {
  constructor(private readonly dir: string, private readonly keep: number) {}

  private ids(): number[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
      .filter((x): x is string => !!x)
      .map(Number)
      .sort((a, b) => a - b);
  }

  list(): UndoEntry[] {
    return this.ids().map((id) => JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as UndoEntry);
  }

  push(entry: Omit<UndoEntry, 'id' | 'time'>, schem: Buffer): UndoEntry {
    mkdirSync(this.dir, { recursive: true });
    const ids = this.ids();
    const id = (ids[ids.length - 1] ?? 0) + 1;
    const full: UndoEntry = { id, time: new Date().toISOString(), ...entry };
    writeFileSync(join(this.dir, `${id}.schem`), schem);
    writeFileSync(join(this.dir, `${id}.json`), `${JSON.stringify(full)}\n`);
    for (const old of ids.slice(0, Math.max(0, ids.length + 1 - this.keep))) this.remove(old);
    return full;
  }

  latest(): { entry: UndoEntry; schem: Buffer } | null {
    const ids = this.ids();
    const id = ids[ids.length - 1];
    if (id === undefined) return null;
    const entry = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as UndoEntry;
    return { entry, schem: readFileSync(join(this.dir, `${id}.schem`)) };
  }

  remove(id: number): void {
    rmSync(join(this.dir, `${id}.schem`), { force: true });
    rmSync(join(this.dir, `${id}.json`), { force: true });
  }
}
