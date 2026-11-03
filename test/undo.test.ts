import { expect, it } from 'vitest';
import { UndoStore } from '../src/ops/undo.js';
import { tempDir } from './helpers/temp.js';

const entry = (label: string) => ({ label, box: { min: [0, 0, 0], max: [1, 1, 1] } as never, dimension: 'overworld' as const, blocks: 8 });

it('keeps the newest snapshots up to the history limit and hands back the latest first', () => {
  const store = new UndoStore(tempDir('undo'), 3);
  for (const n of [1, 2, 3, 4, 5]) store.push(entry(`change ${n}`), Buffer.from(`schem ${n}`));
  expect(store.list().map((e) => e.label)).toEqual(['change 3', 'change 4', 'change 5']);
  const last = store.latest()!;
  expect(last.entry.label).toBe('change 5');
  expect(last.schem.toString()).toBe('schem 5');
  store.remove(last.entry.id);
  expect(store.latest()!.entry.label).toBe('change 4');
});

it('has nothing to undo when empty', () => {
  expect(new UndoStore(tempDir('undo'), 3).latest()).toBeNull();
});
