import { z } from 'zod';
import { makeBox } from '../mc/box.js';
import { classifyReply } from '../rcon/rcon.js';
import { inDimension } from '../ops/world.js';
import { command, dimension, vec3 } from '../schemas.js';
import { tool } from './define.js';

export const serverTools = [
  tool({
    name: 'start_server',
    title: 'Start the test server',
    description:
      'Starts the active test server in the background and waits until RCON answers (the first start makes the world and can take a minute or two). Before starting it puts back the settings the tool depends on: listen on 127.0.0.1 only, RCON on, no query port. The person then joins in Minecraft at localhost:<game port>.',
    input: {},
    readOnly: false,
    destructive: false,
    idempotent: true,
    run: async (_a, ctx) => {
      const s = ctx.server();
      const r = await s.start();
      return {
        started: true,
        seconds: r.seconds,
        join_address: `localhost:${s.gamePort}`,
        ...(r.fixed.length ? { settings_put_back: r.fixed } : {}),
        tip: 'To let the person use commands in game, run_command "op <their Minecraft name>".',
      };
    },
  }),
  tool({
    name: 'stop_server',
    title: 'Stop the test server',
    description: 'Stops the test server cleanly through RCON (the world is saved) and waits for it to exit. force: true ends the process if it does not answer; unsaved changes may then be lost.',
    input: {
      force: z.boolean().optional().describe('End the process if it does not answer on RCON. Default false.'),
    },
    readOnly: false,
    destructive: false,
    idempotent: true,
    run: async (a, ctx) => {
      const r = await ctx.server().stop(a.force ?? false);
      return { stopped: true, ...r };
    },
  }),
  tool({
    name: 'restart_server',
    title: 'Restart the test server',
    description: 'Stops the server cleanly and starts it again, for example after changing server.properties, datapacks that need a restart, or mods.',
    input: {},
    readOnly: false,
    destructive: false,
    idempotent: false,
    run: async (_a, ctx) => {
      const s = ctx.server();
      const st = await s.status();
      const stopped = st.running ? await s.stop(false) : null;
      const started = await s.start();
      return { stop_seconds: stopped?.seconds ?? 0, start_seconds: started.seconds, join_address: `localhost:${s.gamePort}` };
    },
  }),
  tool({
    name: 'server_logs',
    title: 'Read the server log',
    description: 'The last lines of the server log (logs/latest.log), or of the console output if the server failed to start. Optional filter keeps only lines containing that text. The RCON password is hidden.',
    input: {
      lines: z.number().int().min(1).max(500).default(80).describe('How many lines. Default 80.'),
      filter: z.string().max(200).optional().describe('Only lines containing this text (not case sensitive)'),
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    run: async (a, ctx) => ({ lines: ctx.server().logs(a.lines, a.filter) }),
  }),
  tool({
    name: 'run_command',
    title: 'Run a server command',
    description:
      'Runs any Minecraft server command through RCON and returns the reply, for example gamerule, time, weather, summon, give, op, reload, function, scoreboard, team, tp, data. Commands from mods and datapacks work too. Give backup_area to snapshot an area first so undo can put it back; otherwise this cannot be undone.',
    input: {
      command,
      backup_area: z.object({ from: vec3, to: vec3 }).optional().describe('Area this command may change; it is saved first so undo can restore it'),
      dimension: dimension.describe('Dimension to run the command in (and of backup_area). Default overworld.'),
    },
    readOnly: false,
    destructive: true,
    idempotent: false,
    run: async (a, ctx) => {
      const w = ctx.world();
      const opts = { dimension: a.dimension };
      let undo: number | null = null;
      const exec = async () => {
        if (a.backup_area) undo = (await w.snapshot(makeBox(a.backup_area.from, a.backup_area.to), a.dimension, `command: ${a.command.slice(0, 60)}`, opts))?.id ?? null;
        return (await ctx.server().connection()).command(inDimension(a.dimension, a.command.replace(/^\//, '')));
      };
      const reply = a.backup_area ? await w.withLoaded([makeBox(a.backup_area.from, a.backup_area.to)], a.dimension, exec) : await exec();
      return { reply, looks_like: classifyReply(reply), undo };
    },
  }),
];
