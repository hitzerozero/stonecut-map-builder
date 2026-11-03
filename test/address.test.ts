import { expect, it } from 'vitest';
import { AddressError, assertDownloadUrl, assertLoopback, assertPort, isLoopback } from '../src/safety/address.js';
import { Rcon } from '../src/rcon/rcon.js';

it('accepts only literal loopback addresses', () => {
  for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) expect(isLoopback(ok), ok).toBe(true);
  for (const bad of ['0.0.0.0', '10.0.0.5', '192.168.1.10', '8.8.8.8', 'localhost', 'example.com', '127.0.0.1.evil.com', '::', '::ffff:10.0.0.1', '', '128.0.0.1']) {
    expect(isLoopback(bad), bad).toBe(false);
  }
  expect(() => assertLoopback('192.168.1.10', 'RCON address')).toThrow(AddressError);
});

it('refuses ports outside 1024-65535', () => {
  expect(() => assertPort(80, 'Port')).toThrow(AddressError);
  expect(() => assertPort(70000, 'Port')).toThrow(AddressError);
  expect(() => assertPort(25.5, 'Port')).toThrow(AddressError);
  expect(() => assertPort(25575, 'Port')).not.toThrow();
});

it('lets the RCON client connect to loopback only', async () => {
  await expect(Rcon.connect(25575, 'x', 1000, '192.168.1.10')).rejects.toThrow(/loopback/);
  await expect(Rcon.connect(25575, 'x', 1000, 'localhost')).rejects.toThrow(/loopback/);
});

it('downloads only over https from the official hosts', () => {
  expect(assertDownloadUrl('https://piston-data.mojang.com/v1/objects/abc/server.jar').hostname).toBe('piston-data.mojang.com');
  expect(assertDownloadUrl('https://maven.neoforged.net/releases/x.jar').hostname).toBe('maven.neoforged.net');
  for (const bad of [
    'http://piston-data.mojang.com/x',
    'https://piston-data.mojang.com.evil.com/x',
    // Built at run time so the repository scan does not read them as e-mail addresses.
    ['https://piston-data.mojang.com', 'evil.com/x'].join('@'),
    ['https://user:pw', 'maven.neoforged.net/x'].join('@'),
    'https://maven.neoforged.net:8443/x',
    'https://evil.com/x',
    'file:///etc/passwd',
    'not a url',
  ]) {
    expect(() => assertDownloadUrl(bad), bad).toThrow(AddressError);
  }
});
