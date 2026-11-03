import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { decodeModifiedUtf8, encodeModifiedUtf8, nbt, NbtError, packNbt, readNbt, unpackNbt, writeNbt } from '../src/nbt/nbt.js';
import { toSnbt } from '../src/nbt/snbt.js';

const sample = () =>
  nbt.compound({
    b: nbt.byte(-5),
    s: nbt.short(-300),
    i: nbt.int(123456),
    l: nbt.long(-9007199254740993n),
    f: nbt.float(0.5),
    d: nbt.double(1.25),
    ba: nbt.byteArray(Int8Array.from([1, -1, 127])),
    str: nbt.string('Grüße \u0000 \u{1F600}'),
    list: nbt.list('int', [nbt.int(1), nbt.int(2)]),
    empty: nbt.list('end', []),
    nested: nbt.compound({ x: nbt.string('y') }),
    ia: nbt.intArray([1, -2, 3]),
    la: nbt.longArray(BigInt64Array.from([1n, -2n])),
  });

it('writes and reads back every tag type unchanged', () => {
  const back = readNbt(writeNbt('root', sample()));
  expect(back.name).toBe('root');
  expect(back.tag).toEqual(sample());
});

it('reads gzip, zlib and raw NBT the same way', () => {
  const raw = writeNbt('', sample());
  expect(unpackNbt(packNbt('', sample())).tag).toEqual(sample());
  expect(unpackNbt(raw).tag).toEqual(sample());
  expect(unpackNbt(gzipSync(raw)).tag).toEqual(sample());
});

it('encodes NUL and characters outside the BMP the way Java does', () => {
  expect([...encodeModifiedUtf8('\u0000')]).toEqual([0xc0, 0x80]);
  const smile = encodeModifiedUtf8('\u{1F600}');
  expect(smile.length).toBe(6);
  expect(decodeModifiedUtf8(smile)).toBe('\u{1F600}');
});

it('refuses cut-off data and unknown tag ids', () => {
  const raw = writeNbt('', sample());
  expect(() => readNbt(raw.subarray(0, raw.length - 3))).toThrow(NbtError);
  const bad = Buffer.from(raw);
  bad[0] = 99;
  expect(() => readNbt(bad)).toThrow(/Unknown NBT tag id 99/);
});

it('writes SNBT that commands accept, quoting and escaping text', () => {
  const tag = nbt.compound({
    Items: nbt.list('compound', [nbt.compound({ Slot: nbt.byte(0), id: nbt.string('minecraft:diamond'), count: nbt.int(3) })]),
    'odd key': nbt.string('say "hi" \\o/'),
    f: nbt.float(2),
    L: nbt.longArray(BigInt64Array.from([5n])),
  });
  expect(toSnbt(tag)).toBe('{Items:[{Slot:0b,id:"minecraft:diamond",count:3}],"odd key":"say \\"hi\\" \\\\o/",f:2.0f,L:[L;5L]}');
  expect(() => toSnbt(nbt.string('two\nlines'))).toThrow(/control characters/);
});
