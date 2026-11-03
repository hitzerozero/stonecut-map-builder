import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertDownloadUrl } from '../safety/address.js';

// Every download comes over https from an allowed official host, follows redirects only to
// allowed hosts, and is checked against a published hash before it is used.

export class DownloadError extends Error {}

export type HashAlgo = 'sha1' | 'sha256';

async function get(url: string, timeoutMs: number): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    assertDownloadUrl(current);
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new DownloadError(`Redirect without a target from ${current}`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new DownloadError(`Download failed (${res.status}) for ${current}`);
    return res;
  }
  throw new DownloadError(`Too many redirects for ${url}`);
}

export async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  return (await get(url, timeoutMs)).text();
}

export function hashOf(data: Buffer | string, algo: HashAlgo): string {
  return createHash(algo).update(data).digest('hex');
}

/** Fetches JSON and checks its hash when one is given (Mojang publishes sha1 for version files). */
export async function fetchJson<T = unknown>(url: string, sha1?: string): Promise<T> {
  const text = await fetchText(url);
  if (sha1 && hashOf(Buffer.from(text, 'utf8'), 'sha1') !== sha1.toLowerCase()) {
    throw new DownloadError(`Hash mismatch for ${url}: the file is not what Mojang published`);
  }
  return JSON.parse(text) as T;
}

/** Downloads to dest through a temporary file. The file only appears at dest if the hash matches. */
export async function downloadFile(url: string, dest: string, expected: { algo: HashAlgo; hash: string; size?: number }, timeoutMs = 600_000): Promise<{ bytes: number; hash: string }> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await get(url, timeoutMs);
  if (!res.body) throw new DownloadError(`Empty download from ${url}`);
  const hash = createHash(expected.algo);
  let bytes = 0;
  const out = createWriteStream(tmp);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (expected.size !== undefined && bytes > expected.size) throw new DownloadError(`${url} is bigger than published`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((res2, rej) => out.end((e?: Error | null) => (e ? rej(e) : res2())));
  } catch (e) {
    out.destroy();
    await rm(tmp, { force: true });
    throw e;
  }
  const got = hash.digest('hex');
  if (got !== expected.hash.toLowerCase() || (expected.size !== undefined && bytes !== expected.size)) {
    await rm(tmp, { force: true });
    throw new DownloadError(`Hash check failed for ${url} (expected ${expected.algo} ${expected.hash}, got ${got}). Nothing was installed.`);
  }
  await rename(tmp, dest);
  return { bytes, hash: got };
}
