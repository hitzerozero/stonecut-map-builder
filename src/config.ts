import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { RCON_HOST } from './safety/address.js';

// The person's own settings. Nothing here may point at a particular computer: every default comes
// from the operating system (home folder, standard config folder), and the person can override it.

export const APP_FOLDER = 'stonecut-map-builder';
export const CONFIG_ENV = 'STONECUT_MAP_CONFIG';

/** Standard per-user config folder for this OS. */
export function configDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), platform = process.platform): string {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), APP_FOLDER);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_FOLDER);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), APP_FOLDER);
}

export function defaultServerFolder(home: string = homedir()): string {
  return join(home, APP_FOLDER, 'servers');
}

export const DEFAULTS = {
  maxFillBlocks: 100_000,
  maxReadBlocks: 32_768,
  maxImportBlocks: 500_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxEntities: 256,
  includeEntities: true,
  allowFileWrites: true,
  allowModInstall: false,
  confirmDestructive: true,
  autoBackup: true,
  undoHistory: 10,
} as const;

const folder = z.string().min(1).describe('Absolute path, or one starting with ~/ for the home folder');

export const configSchema = z.strictObject({
  serverFolders: z.array(folder).min(1).max(16).optional(),
  maxFillBlocks: z.number().int().min(1).max(10_000_000).default(DEFAULTS.maxFillBlocks),
  maxReadBlocks: z.number().int().min(1).max(1_000_000).default(DEFAULTS.maxReadBlocks),
  maxImportBlocks: z.number().int().min(1).max(20_000_000).default(DEFAULTS.maxImportBlocks),
  maxFileBytes: z.number().int().min(1).max(512 * 1024 * 1024).default(DEFAULTS.maxFileBytes),
  maxEntities: z.number().int().min(0).max(10_000).default(DEFAULTS.maxEntities),
  includeEntities: z.boolean().default(DEFAULTS.includeEntities),
  allowFileWrites: z.boolean().default(DEFAULTS.allowFileWrites),
  allowModInstall: z.boolean().default(DEFAULTS.allowModInstall),
  confirmDestructive: z.boolean().default(DEFAULTS.confirmDestructive),
  autoBackup: z.boolean().default(DEFAULTS.autoBackup),
  undoHistory: z.number().int().min(1).max(100).default(DEFAULTS.undoHistory),
  rconAddress: z
    .literal(RCON_HOST, { error: `rconAddress can only be ${RCON_HOST}: RCON never listens on a network address in this version` })
    .default(RCON_HOST),
  javaPath: z.string().min(1).optional(),
  $schema: z.string().optional(),
  _comment: z.string().optional(),
});

export interface Config {
  /** Where the settings were read from (the file may not exist; then these are the defaults). */
  file: string;
  fileExists: boolean;
  /** Folder for the tool's own state (which server is active). */
  stateDir: string;
  serverFolders: string[];
  maxFillBlocks: number;
  maxReadBlocks: number;
  maxImportBlocks: number;
  maxFileBytes: number;
  maxEntities: number;
  includeEntities: boolean;
  allowFileWrites: boolean;
  allowModInstall: boolean;
  confirmDestructive: boolean;
  autoBackup: boolean;
  undoHistory: number;
  rconAddress: typeof RCON_HOST;
  javaPath?: string;
}

export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

export function configFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env[CONFIG_ENV]?.trim();
  return override ? resolve(expandHome(override, home)) : join(configDir(env, home), 'config.json');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Config {
  const file = configFile(env, home);
  const fileExists = existsSync(file);
  let raw: unknown = {};
  if (fileExists) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
      throw new Error(`Config file ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Config file ${file} has a problem:\n${z.prettifyError(parsed.error)}`);
  const c = parsed.data;
  const serverFolders = (c.serverFolders ?? [defaultServerFolder(home)]).map((f) => {
    const p = expandHome(f, home);
    if (!isAbsolute(p)) throw new Error(`Config file ${file}: server folder "${f}" must be a full path or start with ~/`);
    return resolve(p);
  });
  const javaPath = c.javaPath ? resolve(expandHome(c.javaPath, home)) : undefined;
  return {
    file,
    fileExists,
    stateDir: env[CONFIG_ENV]?.trim() ? dirname(file) : configDir(env, home),
    serverFolders,
    maxFillBlocks: c.maxFillBlocks,
    maxReadBlocks: c.maxReadBlocks,
    maxImportBlocks: c.maxImportBlocks,
    maxFileBytes: c.maxFileBytes,
    maxEntities: c.maxEntities,
    includeEntities: c.includeEntities,
    allowFileWrites: c.allowFileWrites,
    allowModInstall: c.allowModInstall,
    confirmDestructive: c.confirmDestructive,
    autoBackup: c.autoBackup,
    undoHistory: c.undoHistory,
    rconAddress: c.rconAddress,
    ...(javaPath ? { javaPath } : {}),
  };
}

/** The example config with every setting at its default, as written by --init-config. */
export function exampleConfig(): Record<string, unknown> {
  return {
    _comment: 'Stonecut Map Builder settings. Every key is optional; see the Safety section of the README.',
    serverFolders: [`~/${APP_FOLDER}/servers`],
    maxFillBlocks: DEFAULTS.maxFillBlocks,
    maxReadBlocks: DEFAULTS.maxReadBlocks,
    maxImportBlocks: DEFAULTS.maxImportBlocks,
    maxFileBytes: DEFAULTS.maxFileBytes,
    maxEntities: DEFAULTS.maxEntities,
    includeEntities: DEFAULTS.includeEntities,
    allowFileWrites: DEFAULTS.allowFileWrites,
    allowModInstall: DEFAULTS.allowModInstall,
    confirmDestructive: DEFAULTS.confirmDestructive,
    autoBackup: DEFAULTS.autoBackup,
    undoHistory: DEFAULTS.undoHistory,
    rconAddress: RCON_HOST,
  };
}
