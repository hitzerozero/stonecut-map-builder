import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_ENV, configFile, exampleConfig } from './config.js';
import { VERSION } from './version.js';

export const HELP = `stonecut-map-builder ${VERSION}

Without options it runs the MCP server on stdio (an MCP client starts it for you).

Options:
  --config-path   Print where the settings file is read from.
  --init-config   Write the settings file with every setting at its default, if it does not exist.
  --skill-path    Print the folder of the bundled map-builder skill.
  --version       Print the version.
  --help          Print this help.

Environment:
  ${CONFIG_ENV}   Use this settings file instead of the standard one.`;

export function skillPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'map-builder');
}

export function initConfig(file = configFile()): string {
  if (existsSync(file)) return `Settings file already exists, left unchanged: ${file}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(exampleConfig(), null, 2)}\n`);
  return `Wrote ${file}`;
}

export function cliAnswer(argv: string[]): string | null {
  if (argv.includes('--config-path')) return configFile();
  if (argv.includes('--init-config')) return initConfig();
  if (argv.includes('--skill-path')) return skillPath();
  if (argv.includes('--version')) return VERSION;
  if (argv.includes('--help') || argv.includes('-h')) return HELP;
  return null;
}
