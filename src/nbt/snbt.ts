import type { Tag } from './nbt.js';

// Stringified NBT, the text form commands such as /setblock accept.

const BARE_KEY = /^[A-Za-z0-9._+-]+$/;

export class SnbtError extends Error {}

function quote(s: string): string {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new SnbtError('Text with control characters cannot go into a command');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function decimal(v: number, suffix: string): string {
  if (!Number.isFinite(v)) throw new SnbtError('NaN or infinite number cannot go into a command');
  const s = String(v);
  return `${/[.eE]/.test(s) ? s : `${s}.0`}${suffix}`;
}

export function toSnbt(tag: Tag): string {
  switch (tag.type) {
    case 'byte': return `${tag.value}b`;
    case 'short': return `${tag.value}s`;
    case 'int': return String(tag.value);
    case 'long': return `${tag.value}L`;
    case 'float': return decimal(tag.value, 'f');
    case 'double': return decimal(tag.value, 'd');
    case 'string': return quote(tag.value);
    case 'byteArray': return `[B;${Array.from(tag.value, (v) => `${v}b`).join(',')}]`;
    case 'intArray': return `[I;${Array.from(tag.value).join(',')}]`;
    case 'longArray': return `[L;${Array.from(tag.value, (v) => `${v}L`).join(',')}]`;
    case 'list': return `[${tag.value.map(toSnbt).join(',')}]`;
    case 'compound': {
      const parts: string[] = [];
      for (const [k, v] of tag.value) parts.push(`${BARE_KEY.test(k) ? k : quote(k)}:${toSnbt(v)}`);
      return `{${parts.join(',')}}`;
    }
  }
}
