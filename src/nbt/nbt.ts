import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';

// Named Binary Tag, the format Minecraft and Sponge schematics use. Big-endian, strings in Java's modified UTF-8.

export type Tag =
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'byteArray'; value: Int8Array }
  | { type: 'string'; value: string }
  | { type: 'list'; itemType: TagType; value: Tag[] }
  | { type: 'compound'; value: Map<string, Tag> }
  | { type: 'intArray'; value: Int32Array }
  | { type: 'longArray'; value: BigInt64Array };

export type TagType = Tag['type'] | 'end';
export type Compound = Extract<Tag, { type: 'compound' }>;

const IDS: TagType[] = [
  'end', 'byte', 'short', 'int', 'long', 'float', 'double', 'byteArray', 'string', 'list', 'compound', 'intArray', 'longArray',
];
const MAX_DEPTH = 512;

export const nbt = {
  byte: (value: number): Tag => ({ type: 'byte', value }),
  short: (value: number): Tag => ({ type: 'short', value }),
  int: (value: number): Tag => ({ type: 'int', value }),
  long: (value: bigint): Tag => ({ type: 'long', value }),
  float: (value: number): Tag => ({ type: 'float', value }),
  double: (value: number): Tag => ({ type: 'double', value }),
  string: (value: string): Tag => ({ type: 'string', value }),
  byteArray: (value: Int8Array): Tag => ({ type: 'byteArray', value }),
  intArray: (value: Int32Array | number[]): Tag => ({ type: 'intArray', value: Int32Array.from(value) }),
  longArray: (value: BigInt64Array): Tag => ({ type: 'longArray', value }),
  list: (itemType: TagType, value: Tag[]): Tag => ({ type: 'list', itemType: value.length ? value[0]!.type : itemType, value }),
  compound: (entries: Record<string, Tag> | Map<string, Tag>): Compound => ({
    type: 'compound',
    value: entries instanceof Map ? entries : new Map(Object.entries(entries)),
  }),
};

export class NbtError extends Error {}

// ---- modified UTF-8 ----

export function encodeModifiedUtf8(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

export function decodeModifiedUtf8(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const a = b[i]!;
    if (a < 0x80) {
      s += String.fromCharCode(a);
      i += 1;
    } else if ((a & 0xe0) === 0xc0) {
      s += String.fromCharCode(((a & 0x1f) << 6) | (b[i + 1]! & 0x3f));
      i += 2;
    } else {
      s += String.fromCharCode(((a & 0x0f) << 12) | ((b[i + 1]! & 0x3f) << 6) | (b[i + 2]! & 0x3f));
      i += 3;
    }
  }
  return s;
}

// ---- reading ----

class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}

  need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) throw new NbtError('NBT data ends too early');
  }
  u8(): number { this.need(1); return this.buf.readUInt8(this.pos++); }
  i8(): number { this.need(1); return this.buf.readInt8(this.pos++); }
  i16(): number { this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u16(): number { this.need(2); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i32(): number { this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i64(): bigint { this.need(8); const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  f32(): number { this.need(4); const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  str(): string {
    const n = this.u16();
    this.need(n);
    const s = decodeModifiedUtf8(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  count(width: number): number {
    const n = this.i32();
    if (n < 0) throw new NbtError('Negative NBT array length');
    this.need(n * width);
    return n;
  }

  payload(type: TagType, depth: number): Tag {
    if (depth > MAX_DEPTH) throw new NbtError('NBT nested too deeply');
    switch (type) {
      case 'byte': return { type, value: this.i8() };
      case 'short': return { type, value: this.i16() };
      case 'int': return { type, value: this.i32() };
      case 'long': return { type, value: this.i64() };
      case 'float': return { type, value: this.f32() };
      case 'double': return { type, value: this.f64() };
      case 'string': return { type, value: this.str() };
      case 'byteArray': {
        const n = this.count(1);
        const value = new Int8Array(n);
        for (let i = 0; i < n; i++) value[i] = this.i8();
        return { type, value };
      }
      case 'intArray': {
        const n = this.count(4);
        const value = new Int32Array(n);
        for (let i = 0; i < n; i++) value[i] = this.i32();
        return { type, value };
      }
      case 'longArray': {
        const n = this.count(8);
        const value = new BigInt64Array(n);
        for (let i = 0; i < n; i++) value[i] = this.i64();
        return { type, value };
      }
      case 'list': {
        const itemType = tagType(this.u8());
        const n = this.count(0);
        if (itemType === 'end' && n > 0) throw new NbtError('List of end tags');
        const value: Tag[] = [];
        for (let i = 0; i < n; i++) value.push(this.payload(itemType, depth + 1));
        return { type, itemType, value };
      }
      case 'compound': {
        const value = new Map<string, Tag>();
        for (;;) {
          const id = tagType(this.u8());
          if (id === 'end') break;
          const name = this.str();
          value.set(name, this.payload(id, depth + 1));
        }
        return { type, value };
      }
      case 'end':
        throw new NbtError('Unexpected end tag');
    }
  }
}

function tagType(id: number): TagType {
  const t = IDS[id];
  if (!t) throw new NbtError(`Unknown NBT tag id ${id}`);
  return t;
}

export interface NamedTag {
  name: string;
  tag: Compound;
}

/** Reads one named root compound from uncompressed NBT bytes. */
export function readNbt(buf: Buffer): NamedTag {
  const r = new Reader(buf);
  const id = tagType(r.u8());
  if (id !== 'compound') throw new NbtError('NBT root is not a compound');
  const name = r.str();
  return { name, tag: r.payload('compound', 0) as Compound };
}

/** Accepts gzip, zlib or uncompressed NBT. */
export function unpackNbt(buf: Buffer, maxBytes = 512 * 1024 * 1024): NamedTag {
  let raw = buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) raw = gunzipSync(buf, { maxOutputLength: maxBytes });
  else if (buf[0] === 0x78) raw = inflateSync(buf, { maxOutputLength: maxBytes });
  return readNbt(raw);
}

// ---- writing ----

class Writer {
  private chunks: Buffer[] = [];
  bytes(b: Buffer): void { this.chunks.push(b); }
  u8(v: number): void { const b = Buffer.alloc(1); b.writeUInt8(v); this.bytes(b); }
  i8(v: number): void { const b = Buffer.alloc(1); b.writeInt8(v); this.bytes(b); }
  i16(v: number): void { const b = Buffer.alloc(2); b.writeInt16BE(v); this.bytes(b); }
  i32(v: number): void { const b = Buffer.alloc(4); b.writeInt32BE(v); this.bytes(b); }
  i64(v: bigint): void { const b = Buffer.alloc(8); b.writeBigInt64BE(v); this.bytes(b); }
  str(s: string): void {
    const b = encodeModifiedUtf8(s);
    if (b.length > 0xffff) throw new NbtError('NBT string too long');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    this.bytes(len);
    this.bytes(b);
  }

  payload(tag: Tag): void {
    switch (tag.type) {
      case 'byte': return this.i8(tag.value);
      case 'short': return this.i16(tag.value);
      case 'int': return this.i32(tag.value);
      case 'long': return this.i64(tag.value);
      case 'float': { const b = Buffer.alloc(4); b.writeFloatBE(tag.value); return this.bytes(b); }
      case 'double': { const b = Buffer.alloc(8); b.writeDoubleBE(tag.value); return this.bytes(b); }
      case 'string': return this.str(tag.value);
      case 'byteArray': this.i32(tag.value.length); return this.bytes(Buffer.from(tag.value.buffer, tag.value.byteOffset, tag.value.length));
      case 'intArray': {
        this.i32(tag.value.length);
        const b = Buffer.alloc(tag.value.length * 4);
        tag.value.forEach((v, i) => b.writeInt32BE(v, i * 4));
        return this.bytes(b);
      }
      case 'longArray': {
        this.i32(tag.value.length);
        const b = Buffer.alloc(tag.value.length * 8);
        tag.value.forEach((v, i) => b.writeBigInt64BE(v, i * 8));
        return this.bytes(b);
      }
      case 'list': {
        const itemType = tag.value.length ? tag.value[0]!.type : tag.itemType;
        if (tag.value.some((t) => t.type !== itemType)) throw new NbtError('NBT list items must share one type');
        this.u8(IDS.indexOf(itemType));
        this.i32(tag.value.length);
        for (const t of tag.value) this.payload(t);
        return;
      }
      case 'compound':
        for (const [name, t] of tag.value) {
          this.u8(IDS.indexOf(t.type));
          this.str(name);
          this.payload(t);
        }
        return this.u8(0);
    }
  }

  done(): Buffer { return Buffer.concat(this.chunks); }
}

export function writeNbt(name: string, root: Compound): Buffer {
  const w = new Writer();
  w.u8(IDS.indexOf('compound'));
  w.str(name);
  w.payload(root);
  return w.done();
}

export function packNbt(name: string, root: Compound): Buffer {
  return gzipSync(writeNbt(name, root));
}

// ---- small accessors ----

export function get<T extends Tag['type']>(c: Compound, key: string, type: T): Extract<Tag, { type: T }> | undefined {
  const t = c.value.get(key);
  return t && t.type === type ? (t as Extract<Tag, { type: T }>) : undefined;
}

export function need<T extends Tag['type']>(c: Compound, key: string, type: T, where: string): Extract<Tag, { type: T }> {
  const t = get(c, key, type);
  if (!t) throw new NbtError(`${where}: missing ${type} "${key}"`);
  return t;
}

/** Reads a number from any numeric tag (schematic writers differ on short vs int). */
export function num(c: Compound, key: string): number | undefined {
  const t = c.value.get(key);
  if (!t) return undefined;
  if (t.type === 'byte' || t.type === 'short' || t.type === 'int' || t.type === 'float' || t.type === 'double') return t.value;
  if (t.type === 'long') return Number(t.value);
  return undefined;
}
