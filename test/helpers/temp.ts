import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PARENT = join(tmpdir(), 'stonecut-map-builder-tests');

export function tempDir(label: string): string {
  mkdirSync(PARENT, { recursive: true });
  return mkdtempSync(join(PARENT, `${label}-`));
}
