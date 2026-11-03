import { isIP } from 'node:net';

// The tool only ever talks to this computer. RCON is always 127.0.0.1; these checks also guard
// server.properties so the test server never listens on a network address.

export const RCON_HOST = '127.0.0.1';

export class AddressError extends Error {}

/** True for literal loopback addresses: 127.0.0.0/8, ::1 and ::ffff:127.x.x.x. Host names are not accepted. */
export function isLoopback(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(h) === 4) return h.split('.')[0] === '127';
  if (isIP(h) === 6) {
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
    const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return mapped !== null && isIP(mapped[1]!) === 4 && mapped[1]!.split('.')[0] === '127';
  }
  return false;
}

export function assertLoopback(host: string, what: string): void {
  if (!isLoopback(host)) throw new AddressError(`${what} must be a loopback address such as 127.0.0.1, not "${host}". Only a test server on this computer is supported.`);
}

export function assertPort(port: number, what: string): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AddressError(`${what} must be a whole number from 1024 to 65535, not ${port}`);
}

/** Hosts the setup may download from. Every download is also checked against a published hash. */
export const DOWNLOAD_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com', 'maven.neoforged.net'];

export function assertDownloadUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AddressError(`Not a URL: ${url}`);
  }
  if (u.protocol !== 'https:') throw new AddressError(`Downloads must use https: ${url}`);
  if (!DOWNLOAD_HOSTS.includes(u.hostname) || u.port !== '' || u.username || u.password) {
    throw new AddressError(`Downloads only come from official sources (${DOWNLOAD_HOSTS.join(', ')}), not ${u.host}`);
  }
  return u;
}
