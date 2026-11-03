import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { classifyReply, decodePackets, encodePacket, Rcon, runParallel, changedCount } from '../src/rcon/rcon.js';

// A small RCON server that behaves like Minecraft's: one auth packet, replies split at 4096 characters.

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function fake(password: string, reply: (cmd: string) => string): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((s: Socket) => {
      let buf: Buffer = Buffer.alloc(0);
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === 3) s.write(encodePacket(p.body === password ? p.id : -1, 2, ''));
          else {
            const text = reply(p.body);
            for (let i = 0; i === 0 || i < text.length; i += 4096) s.write(encodePacket(p.id, 0, text.slice(i, i + 4096)));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
  });
}

it('encodes and decodes packets, keeping a partial packet for later', () => {
  const two = Buffer.concat([encodePacket(1, 2, 'list'), encodePacket(2, 0, 'Grüße')]);
  const { packets, rest } = decodePackets(two.subarray(0, two.length - 3));
  expect(packets).toEqual([{ id: 1, type: 2, body: 'list' }]);
  expect(rest.length).toBeGreaterThan(0);
  expect(decodePackets(two).packets[1]).toEqual({ id: 2, type: 0, body: 'Grüße' });
  expect(() => decodePackets(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/Bad RCON packet length/);
});

it('logs in, runs commands one after another and joins long replies', async () => {
  const port = await fake('secret-password', (cmd) => (cmd === 'long' ? 'x'.repeat(9000) : `ran ${cmd}`));
  const r = await Rcon.connect(port, 'secret-password', 5000);
  const replies = await Promise.all([r.command('/time set day'), r.command('list'), r.command('long')]);
  expect(replies[0]).toBe('ran time set day');
  expect(replies[1]).toBe('ran list');
  expect(replies[2]).toHaveLength(9000);
  r.close();
});

it('reports a wrong password', async () => {
  const port = await fake('right', () => '');
  await expect(Rcon.connect(port, 'wrong', 5000)).rejects.toThrow(/refused the password/);
});

it('refuses commands that are too long or span lines before sending them', async () => {
  const port = await fake('pw', (c) => c);
  const r = await Rcon.connect(port, 'pw', 5000);
  await expect(r.command('say ' + 'x'.repeat(1500))).rejects.toThrow(/at most 1446/);
  await expect(r.command('say hi\nop me')).rejects.toThrow(/one line/);
  r.close();
});

it('runs a batch over several connections and counts changed blocks and errors', async () => {
  const port = await fake('pw', (c) => (c.startsWith('fill') ? 'Successfully filled 8 block(s)' : c.startsWith('bad') ? 'Unknown or incomplete command, see below for error' : 'Could not set the block'));
  const conns = await Promise.all([1, 2, 3].map(() => Rcon.connect(port, 'pw', 5000)));
  const cmds = [...Array.from({ length: 30 }, () => 'fill 0 0 0 1 1 1 stone'), 'setblock 0 0 0 stone', 'bad'];
  const r = await runParallel(conns, cmds);
  expect(r.ran).toBe(32);
  expect(r.changed).toBe(240);
  expect(r.unchanged).toBe(1);
  expect(r.errors).toEqual([{ command: 'bad', reply: 'Unknown or incomplete command, see below for error' }]);
  conns.forEach((c) => c.close());
});

it('classifies Minecraft replies', () => {
  expect(classifyReply('Successfully filled 125 block(s)')).toBe('ok');
  expect(classifyReply('Changed the block at 1, 2, 3')).toBe('ok');
  expect(classifyReply('No blocks were filled')).toBe('unchanged');
  expect(classifyReply('Could not set the block')).toBe('unchanged');
  expect(classifyReply('That position is not loaded')).toBe('error');
  expect(classifyReply('Unknown block type \'minecraft:nope\'')).toBe('error');
  expect(classifyReply('Too many blocks in the specified area (maximum 32768, specified 40000)')).toBe('error');
  expect(changedCount('Successfully cloned 27 block(s)')).toBe(27);
  expect(changedCount('Changed the block at 1, 2, 3')).toBe(1);
});
