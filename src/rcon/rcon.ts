import { connect, type Socket } from 'node:net';
import { assertLoopback, assertPort, RCON_HOST } from '../safety/address.js';
import { MAX_COMMAND_BYTES } from '../mc/blocks.js';

// Source RCON protocol as Minecraft implements it: little-endian packets of
// [length][request id][type][body\0][\0]. Type 3 logs in, type 2 runs a command, type 0 is a reply.
// Minecraft reads one packet per read and drops the connection if two arrive together, so this
// client waits for each reply before sending the next command.

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
/** Minecraft splits long replies into packets of this many characters. */
const FRAGMENT = 4096;

export class RconError extends Error {}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const text = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + text.length);
  buf.writeInt32LE(10 + text.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  text.copy(buf, 12);
  return buf;
}

export interface Packet {
  id: number;
  type: number;
  body: string;
}

/** Takes whole packets off the front of buf. Returns them and the bytes left over. */
export function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let p = 0;
  while (buf.length - p >= 4) {
    const len = buf.readInt32LE(p);
    if (len < 10 || len > 1024 * 1024) throw new RconError(`Bad RCON packet length ${len}`);
    if (buf.length - p - 4 < len) break;
    packets.push({ id: buf.readInt32LE(p + 4), type: buf.readInt32LE(p + 8), body: buf.toString('utf8', p + 12, p + 4 + len - 2) });
    p += 4 + len;
  }
  return { packets, rest: buf.subarray(p) };
}

interface Waiting {
  id: number;
  parts: string[];
  resolve: (body: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  settle?: NodeJS.Timeout;
}

export class Rcon {
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private waiting: Waiting | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(private readonly socket: Socket, private readonly timeoutMs: number) {
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => this.fail(new RconError(`RCON connection error: ${e.message}`)));
    socket.on('close', () => {
      this.closed = true;
      this.fail(new RconError('RCON connection closed by the server'));
    });
  }

  static async connect(port: number, password: string, timeoutMs = 60_000, host = RCON_HOST): Promise<Rcon> {
    assertLoopback(host, 'RCON address');
    assertPort(port, 'RCON port');
    const socket = await new Promise<Socket>((res, rej) => {
      const s = connect({ host, port });
      const t = setTimeout(() => {
        s.destroy();
        rej(new RconError(`No answer from RCON on ${host}:${port}`));
      }, 5000);
      s.once('connect', () => {
        clearTimeout(t);
        res(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        rej(new RconError(`Cannot reach RCON on ${host}:${port}: ${e.message}`));
      });
    });
    const rcon = new Rcon(socket, timeoutMs);
    try {
      await rcon.send(TYPE_AUTH, password);
    } catch (e) {
      rcon.close();
      throw e;
    }
    return rcon;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Runs one command and returns the server's reply text. */
  command(cmd: string): Promise<string> {
    if (/[\r\n\0]/.test(cmd)) return Promise.reject(new RconError('A command must be one line'));
    const c = cmd.replace(/^\//, '');
    if (Buffer.byteLength(c) > MAX_COMMAND_BYTES) {
      return Promise.reject(new RconError(`Command is ${Buffer.byteLength(c)} bytes; RCON takes at most ${MAX_COMMAND_BYTES}`));
    }
    return this.send(TYPE_COMMAND, c);
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private send(type: number, body: string): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        if (this.closed) return reject(new RconError('RCON connection is closed'));
        const id = this.nextId++;
        const timer = setTimeout(() => this.fail(new RconError(`RCON gave no reply within ${this.timeoutMs / 1000}s`)), this.timeoutMs);
        this.waiting = { id, parts: [], resolve, reject, timer };
        this.socket.write(encodePacket(id, type, body));
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private onData(d: Buffer): void {
    let decoded;
    try {
      decoded = decodePackets(Buffer.concat([this.buf, d]));
    } catch (e) {
      this.fail(e as Error);
      this.close();
      return;
    }
    this.buf = decoded.rest;
    for (const pkt of decoded.packets) {
      const w = this.waiting;
      if (!w) continue;
      if (pkt.id === -1) {
        this.fail(new RconError('RCON refused the password'));
        continue;
      }
      if (pkt.id !== w.id) continue;
      w.parts.push(pkt.body);
      if (w.settle) clearTimeout(w.settle);
      if (pkt.body.length >= FRAGMENT) w.settle = setTimeout(() => this.finish(w), 150);
      else this.finish(w);
    }
  }

  private finish(w: Waiting): void {
    if (this.waiting !== w) return;
    clearTimeout(w.timer);
    if (w.settle) clearTimeout(w.settle);
    this.waiting = null;
    w.resolve(w.parts.join(''));
  }

  private fail(e: Error): void {
    const w = this.waiting;
    if (!w) return;
    clearTimeout(w.timer);
    if (w.settle) clearTimeout(w.settle);
    this.waiting = null;
    w.reject(e);
  }
}

export type ReplyKind = 'ok' | 'unchanged' | 'error';

const UNCHANGED = /^(Could not set the block|No blocks were (filled|cloned)|Nothing changed)/i;
const ERROR =
  /(Unknown or incomplete command|Unknown block|Unknown command|Incorrect argument|Expected |Invalid |<--\[HERE\]|not loaded|out of (this|the) world|Too many blocks|Cannot |Can't |Could not |Unknown |is not a valid|Unable to |No entity was found)/i;

export function classifyReply(reply: string): ReplyKind {
  const r = reply.trim();
  if (UNCHANGED.test(r)) return 'unchanged';
  if (ERROR.test(r)) return 'error';
  return 'ok';
}

/** Blocks a /fill, /clone or /setblock reply says it changed. */
export function changedCount(reply: string): number {
  const m = /(\d+) block/i.exec(reply);
  if (m) return Number(m[1]);
  return /^Changed the block/i.test(reply.trim()) ? 1 : 0;
}

export function mergeResults(a: BatchResult, b: BatchResult): BatchResult {
  return { ran: a.ran + b.ran, changed: a.changed + b.changed, ok: a.ok + b.ok, unchanged: a.unchanged + b.unchanged, errors: [...a.errors, ...b.errors].slice(0, 20) };
}

export function emptyResult(): BatchResult {
  return { ran: 0, changed: 0, ok: 0, unchanged: 0, errors: [] };
}

export interface BatchResult {
  ran: number;
  /** Blocks the server reported as changed. */
  changed: number;
  ok: number;
  unchanged: number;
  errors: { command: string; reply: string }[];
}

/**
 * Runs commands over several connections at once. Only for commands whose order does not
 * matter (they touch different blocks). Stops early after too many errors.
 */
export async function runParallel(conns: Rcon[], commands: string[], maxErrors = 20): Promise<BatchResult> {
  const result: BatchResult = { ran: 0, changed: 0, ok: 0, unchanged: 0, errors: [] };
  let next = 0;
  const worker = async (c: Rcon) => {
    while (next < commands.length && result.errors.length < maxErrors) {
      const cmd = commands[next++]!;
      const reply = await c.command(cmd);
      result.ran++;
      const kind = classifyReply(reply);
      if (kind === 'ok') {
        result.ok++;
        result.changed += changedCount(reply);
      }
      else if (kind === 'unchanged') result.unchanged++;
      else result.errors.push({ command: cmd, reply: reply.trim() });
    }
  };
  await Promise.all(conns.map(worker));
  return result;
}

export async function runInOrder(conn: Rcon, commands: string[], maxErrors = 20): Promise<BatchResult> {
  return runParallel([conn], commands, maxErrors);
}
