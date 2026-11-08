#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { cliAnswer } from './cli.js';
import { loadConfig } from './config.js';
import { Context } from './context.js';
import { doctor } from './doctor.js';
import { createServer } from './server.js';

async function serve(): Promise<void> {
  const server = createServer(new Context(loadConfig()));
  await server.connect(new StdioServerTransport());
}

const fail = (e: unknown) => {
  process.stderr.write(`stonecut-map-builder: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
};

const argv = process.argv.slice(2);
if (argv[0] === 'doctor') {
  doctor().then((code) => (process.exitCode = code), fail);
} else {
  const answer = cliAnswer(argv);
  if (answer !== null) process.stdout.write(`${answer}\n`);
  else serve().catch(fail);
}
