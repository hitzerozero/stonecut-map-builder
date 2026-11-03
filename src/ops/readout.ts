import type { Box } from '../mc/box.js';
import { isAir } from '../mc/blocks.js';
import type { AreaRead } from '../world/region.js';

// Turns an area into compact text for the agent: a palette, then one line per row of blocks
// with repeats written as index*count.

export function rle(values: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j < values.length && values[j] === values[i]) j++;
    out.push(j - i > 1 ? `${values[i]}*${j - i}` : String(values[i]));
    i = j;
  }
  return out.join(' ');
}

export function describeArea(read: AreaRead, box: Box, format: 'layers' | 'list') {
  const s = read.schematic;
  const counts = new Map<string, number>();
  for (const i of s.blocks) counts.set(s.palette[i]!, (counts.get(s.palette[i]!) ?? 0) + 1);
  const base = {
    from: box.min,
    to: box.max,
    size: [s.width, s.height, s.length],
    counts: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
    block_entities: s.blockEntities.map((b) => ({ pos: [box.min[0] + b.pos[0], box.min[1] + b.pos[1], box.min[2] + b.pos[2]], id: b.id })),
    ...(read.missingChunks.length ? { not_generated_chunks: read.missingChunks, note: 'Chunks that are not generated read as air.' } : {}),
  };
  if (format === 'list') {
    const blocks: [number, number, number, string][] = [];
    for (let y = 0; y < s.height; y++)
      for (let z = 0; z < s.length; z++)
        for (let x = 0; x < s.width; x++) {
          const state = s.palette[s.blocks[x + z * s.width + y * s.width * s.length]!]!;
          if (!isAir(state)) blocks.push([box.min[0] + x, box.min[1] + y, box.min[2] + z, state]);
        }
    return { ...base, blocks };
  }
  const layers: { y: number; rows: string[] | string }[] = [];
  for (let y = 0; y < s.height; y++) {
    const rows: string[] = [];
    let allAir = true;
    for (let z = 0; z < s.length; z++) {
      const row: number[] = [];
      for (let x = 0; x < s.width; x++) {
        const v = s.blocks[x + z * s.width + y * s.width * s.length]!;
        if (!isAir(s.palette[v]!)) allAir = false;
        row.push(v);
      }
      rows.push(rle(row));
    }
    layers.push({ y: box.min[1] + y, rows: allAir ? 'all air' : rows });
  }
  return {
    ...base,
    palette: s.palette,
    how_to_read: `Each layer is one y level. rows[0] is z=${box.min[2]}, the last is z=${box.max[2]}. Each row runs from x=${box.min[0]} to x=${box.max[0]} as palette indices; "3*5" means index 3 five times.`,
    layers,
  };
}
