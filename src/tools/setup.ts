import { z } from 'zod';
import { findJava } from '../mc/java.js';
import { createServer, planSetup, type Plan } from '../mc/setup.js';
import { eulaAccepted, writeEula } from '../mc/testserver.js';
import { EULA_URL } from '../mc/versions.js';
import { listBackups } from '../ops/backup.js';
import { tool } from './define.js';

function showPlan(p: Plan) {
  return {
    plan_id: p.planId,
    ready: p.ready,
    folder: p.folder,
    minecraft: p.minecraft,
    loader: p.loader,
    ...(p.loaderVersion ? { neoforge_version: p.loaderVersion, neoforge_is_beta: p.loaderIsBeta } : {}),
    java: p.java
      ? { needed: p.javaNeeded, using: p.java.path, version: p.java.version }
      : { needed: p.javaNeeded, found: p.javaFound.map((j) => `${j.path} (Java ${j.major})`), missing: true, where_to_get_it: p.javaMissing },
    downloads: p.downloads.map((d) => ({ what: d.what, from: d.source, url: d.url, checked_with: `${d.hash.algo} ${d.hash.value}`, ...(d.size ? { bytes: d.size } : {}) })),
    game_port: p.gamePort,
    rcon_port: p.rconPort,
    memory_mb: p.memoryMb,
    world_type: p.worldType,
    eula: `The person must read and accept the Minecraft EULA themselves before the server can start: ${p.eulaUrl}`,
    next: p.ready
      ? 'Show this plan to the person: what gets downloaded, from where, the folder and the ports. Only if they say yes, call create_server with this plan_id and person_confirmed: true. The plan expires in 30 minutes.'
      : `Java ${p.javaNeeded} or newer is missing. Tell the person where to get it (where_to_get_it), wait until they have installed it, then call plan_setup again. Do not install Java yourself unless they ask you to.`,
  };
}

export const setupTools = [
  tool({
    name: 'status',
    title: 'Status and settings',
    description:
      'Call this first. Shows the person\'s safety settings (config file, allowed server folders, size limits, file and mod rules), the active test server (version, folder, running or not, ports, EULA), Java found on this computer, the undo history and world backups.',
    input: {},
    readOnly: true,
    destructive: false,
    idempotent: true,
    run: async (_args, ctx) => {
      const c = ctx.config;
      const s = ctx.current();
      const settings = {
        config_file: c.file,
        config_file_exists: c.fileExists,
        server_folders: c.serverFolders,
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
      };
      if (!s) {
        const java = await findJava(c.javaPath ? [c.javaPath] : []);
        return {
          settings,
          server: null,
          java_found: java.map((j) => `${j.path} (Java ${j.major})`),
          next: 'No test server yet. Ask the person which Minecraft version and which modpack (or plain vanilla) they use, recommend a separate test server, then call plan_setup.',
        };
      }
      const st = await s.status();
      return {
        settings,
        server: {
          folder: s.dir,
          minecraft: s.meta.minecraft,
          loader: s.meta.loader,
          ...(s.meta.loaderVersion ? { loader_version: s.meta.loaderVersion } : {}),
          running: st.running,
          rcon_connected: st.rcon,
          join_address: `localhost:${s.gamePort}`,
          rcon_port: s.meta.rconPort,
          eula_accepted: eulaAccepted(s.dir),
          java: s.meta.javaPath,
        },
        known_servers: ctx.knownServers(),
        undo: ctx.world().undo.list().map((u) => ({ id: u.id, label: u.label, from: u.box.min, to: u.box.max, dimension: u.dimension, time: u.time })),
        world_backups: listBackups(s),
      };
    },
  }),
  tool({
    name: 'plan_setup',
    title: 'Plan a test server (changes nothing)',
    description:
      'Looks up everything needed for a new local test server and changes nothing: the exact Minecraft (and NeoForge) version, which Java it needs and whether it is installed, every file that would be downloaded with its official source and hash, the folder and the ports. Show the result to the person and ask before create_server. Minecraft Java Edition 1.20.1 or newer.',
    input: {
      minecraft: z.string().min(1).max(20).describe('Minecraft version such as "1.21.11", or "latest" for the newest release'),
      loader: z.enum(['vanilla', 'neoforge']).describe('vanilla, or neoforge for modpacks'),
      name: z.string().min(1).max(40).default('test-server').describe('Folder name for the server. Default "test-server".'),
      server_folder: z.string().optional().describe('Which allowed folder to put it in (see status). Default the first one.'),
      game_port: z.number().int().min(1024).max(65535).optional().describe('Port to join on. Default: the first free port from 25565.'),
      rcon_port: z.number().int().min(1024).max(65535).optional().describe('RCON port on 127.0.0.1. Default: the first free port from 25575.'),
      memory_mb: z.number().int().min(1024).max(32768).optional().describe('Memory for the server. Default 2048 (vanilla) or 4096 (NeoForge).'),
      world_type: z.enum(['flat', 'normal']).optional().describe('flat (default, good for building) or normal terrain'),
      java_path: z.string().optional().describe('A specific java executable to use'),
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
    run: async (a, ctx) => {
      const plan = await planSetup(ctx.config, {
        minecraft: a.minecraft,
        loader: a.loader,
        name: a.name,
        ...(a.server_folder ? { serverFolder: a.server_folder } : {}),
        ...(a.game_port ? { gamePort: a.game_port } : {}),
        ...(a.rcon_port ? { rconPort: a.rcon_port } : {}),
        ...(a.memory_mb ? { memoryMb: a.memory_mb } : {}),
        ...(a.world_type ? { worldType: a.world_type } : {}),
        ...(a.java_path ? { javaPath: a.java_path } : {}),
      });
      for (const [id, p] of ctx.plans) if (p.expires < Date.now()) ctx.plans.delete(id);
      ctx.plans.set(plan.planId, plan);
      return showPlan(plan);
    },
  }),
  tool({
    name: 'create_server',
    title: 'Create the planned test server',
    description:
      'Carries out a plan from plan_setup: makes the folder, downloads the server from the official source, checks every hash (nothing is kept if a hash is wrong), runs the NeoForge installer if chosen, and writes server.properties with RCON on 127.0.0.1 and a random password. Does not accept the EULA and does not start the server. Only call this after the person said yes to the plan.',
    input: {
      plan_id: z.string().uuid().describe('plan_id from plan_setup'),
      person_confirmed: z.literal(true).describe('true only after you showed the person the plan (downloads, sources, folder, ports) and they said yes'),
    },
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
    run: async (a, ctx) => {
      const plan = ctx.plans.get(a.plan_id);
      if (!plan) throw new Error('Unknown or expired plan_id. Call plan_setup, show the person the plan, and use the new plan_id.');
      const created = await createServer(plan);
      ctx.plans.delete(a.plan_id);
      ctx.setActive(created.folder);
      return {
        folder: created.folder,
        minecraft: created.meta.minecraft,
        loader: created.meta.loader,
        downloaded: created.downloaded,
        seconds: created.seconds,
        next: `Show the person the Minecraft EULA (${EULA_URL}) and ask whether they accept it. Only if they say yes, call accept_eula with person_accepted: true. Then start_server.`,
      };
    },
  }),
  tool({
    name: 'accept_eula',
    title: 'Record that the person accepted the EULA',
    description: `Writes eula=true for the active test server. Minecraft needs this to start. Only call it after you showed the person the Minecraft EULA (${EULA_URL}) and they said they accept it. Never accept it for them.`,
    input: {
      person_accepted: z.literal(true).describe('true only if the person read the EULA and said they accept it'),
    },
    readOnly: false,
    destructive: false,
    idempotent: true,
    run: async (_a, ctx) => {
      const s = ctx.server();
      writeEula(s.dir, true);
      return { folder: s.dir, eula_accepted: true, next: 'Call start_server.' };
    },
  }),
  tool({
    name: 'use_server',
    title: 'Switch to another test server folder',
    description:
      'Makes another server folder the active one. It must be inside one of the allowed server folders in the person\'s config (see status). A server this tool did not make is adopted: the tool works out how to start it and keeps its settings, except that it always keeps RCON on 127.0.0.1.',
    input: {
      folder: z.string().min(1).describe('Full path of the server folder'),
    },
    readOnly: false,
    destructive: false,
    idempotent: true,
    run: async (a, ctx) => {
      const { server, adopted } = await ctx.adopt(a.folder);
      return { folder: server.dir, adopted, loader: server.meta.loader, minecraft: server.meta.minecraft, eula_accepted: eulaAccepted(server.dir) };
    },
  }),
];

