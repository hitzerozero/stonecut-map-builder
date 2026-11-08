export type Vec3 = [number, number, number];

/** An inclusive block box: min and max corners are both inside. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export function makeBox(a: Vec3, b: Vec3): Box {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

export function boxSize(b: Box): Vec3 {
  return [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
}

export function boxVolume(b: Box): number {
  const [w, h, l] = boxSize(b);
  return w * h * l;
}

export function boxAt(origin: Vec3, size: Vec3): Box {
  return { min: [...origin], max: [origin[0] + size[0] - 1, origin[1] + size[1] - 1, origin[2] + size[2] - 1] };
}

export function unionBox(boxes: Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, b.min[i]!);
      max[i] = Math.max(max[i]!, b.max[i]!);
    }
  }
  return { min, max };
}

/**
 * Splits a box into boxes of at most maxVolume blocks (Minecraft refuses a /fill or /clone over
 * 32768 blocks). Cuts whole slabs along the longest side when they fit, otherwise halves it.
 */
export function splitBox(b: Box, maxVolume: number): Box[] {
  if (maxVolume < 1) throw new Error('maxVolume must be at least 1');
  if (boxVolume(b) <= maxVolume) return [b];
  const size = boxSize(b);
  const axis = size.indexOf(Math.max(...size));
  const cross = boxVolume(b) / size[axis]!;
  const out: Box[] = [];
  if (cross <= maxVolume) {
    const thick = Math.floor(maxVolume / cross);
    for (let s = b.min[axis]!; s <= b.max[axis]!; s += thick) {
      const min: Vec3 = [...b.min];
      const max: Vec3 = [...b.max];
      min[axis] = s;
      max[axis] = Math.min(b.max[axis]!, s + thick - 1);
      out.push({ min, max });
    }
    return out;
  }
  const mid = b.min[axis]! + Math.floor(size[axis]! / 2) - 1;
  const lowMax: Vec3 = [...b.max];
  lowMax[axis] = mid;
  const highMin: Vec3 = [...b.min];
  highMin[axis] = mid + 1;
  return [...splitBox({ min: b.min, max: lowMax }, maxVolume), ...splitBox({ min: highMin, max: b.max }, maxVolume)];
}

/** How many chunk columns a box touches, without listing them. */
export function chunkCount(b: Box): number {
  return (Math.floor(b.max[0] / 16) - Math.floor(b.min[0] / 16) + 1) * (Math.floor(b.max[2] / 16) - Math.floor(b.min[2] / 16) + 1);
}

/** Chunk columns (x, z in chunk units) a box touches. */
export function chunksOf(b: Box): [number, number][] {
  const out: [number, number][] = [];
  for (let cx = Math.floor(b.min[0] / 16); cx <= Math.floor(b.max[0] / 16); cx++) {
    for (let cz = Math.floor(b.min[2] / 16); cz <= Math.floor(b.max[2] / 16); cz++) out.push([cx, cz]);
  }
  return out;
}
