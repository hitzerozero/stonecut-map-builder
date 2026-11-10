import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { skillPath } from './cli.js';
import { loadConfig, type Config } from './config.js';
import { Context } from './context.js';
import { findJava, javaInstallHint, type JavaInstall } from './mc/java.js';
import { eulaAccepted, portFree, type TestServer } from './mc/testserver.js';
import { EULA_URL, JAVA_FOR_MINECRAFT, javaNeededFor } from './mc/versions.js';
import { isLoopback } from './safety/address.js';
import { ALL_TOOLS } from './server.js';
import { VERSION } from './version.js';

// `stonecut-map-builder doctor`: checks the setup and says how to fix each problem. It changes
// nothing. It runs `java -version` for each Java it finds, asks the test server over RCON on
// 127.0.0.1 whether it runs, listens on 127.0.0.1 for a moment to see whether the ports are free,
// and starts this MCP server once to list its tools. It contacts nothing else.

export interface Check {
  ok: boolean;
  label: string;
  fix?: string;
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** Where doctor runs; a project's own skills folder is looked for here. */
  cwd: string;
  nodeVersion: string;
  findJava: (extra: string[]) => Promise<JavaInstall[]>;
  /** Starts this MCP server over stdio and returns how many tools it lists. */
  startServer: () => Promise<number>;
}

const MIN_NODE = 20;
const START_TIMEOUT_MS = 20_000;
const ADD_COMMAND =
  process.platform === 'win32'
    ? 'claude mcp add --scope user stonecut-map-builder -- cmd /c npx -y stonecut-map-builder'
    : 'claude mcp add --scope user stonecut-map-builder -- npx -y stonecut-map-builder';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const yesNo = (b: boolean) => (b ? 'yes' : 'no');

export function checkNode(version: string): Check {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return major >= MIN_NODE
    ? { ok: true, label: `Node.js ${version} (needs ${MIN_NODE} or newer)` }
    : { ok: false, label: `Node.js ${version} is too old (needs ${MIN_NODE} or newer)`, fix: 'Install the LTS version from https://nodejs.org, then open a new terminal.' };
}

function checkSettings(env: NodeJS.ProcessEnv, home: string): { check: Check; config: Config | null } {
  let config: Config;
  try {
    config = loadConfig(env, home);
  } catch (e) {
    return {
      check: { ok: false, label: message(e), fix: 'Fix that value in the settings file, or move the file away to use the defaults. Until then the MCP server does not start.' },
      config: null,
    };
  }
  const where = config.fileExists ? `Settings file ${config.file} is valid.` : `No settings file at ${config.file}; the defaults are in use.`;
  const folders = config.serverFolders.map((f) => `${f}${existsSync(f) ? '' : ' (not made yet)'}`).join(', ');
  return {
    check: {
      ok: true,
      label: `${where} Allowed server folders: ${folders}. File writes: ${yesNo(config.allowFileWrites)}. Mods: ${yesNo(config.allowModInstall)}. Asks before destructive changes: ${yesNo(config.confirmDestructive)}.`,
    },
    config,
  };
}

export function checkJava(found: JavaInstall[], javaPath?: string): Check {
  const hint = `Install Java ${JAVA_FOR_MINECRAFT[1].java} (or the one your Minecraft version needs) and open a new terminal. ${javaInstallHint(JAVA_FOR_MINECRAFT[1].java).join('; ')}`;
  if (javaPath && !found.some((j) => j.path === javaPath)) {
    return { ok: false, label: `javaPath in the settings file is ${javaPath}, which is not a Java that answers to java -version`, fix: 'Point javaPath at a java program (java.exe on Windows), or remove it so Java is found by itself.' };
  }
  if (!found.length) return { ok: false, label: 'No Java found (looked in JAVA_HOME, PATH and the usual install folders)', fix: hint };
  const best = Math.max(...found.map((j) => j.major));
  const enough = JAVA_FOR_MINECRAFT.filter((r) => best >= r.java);
  const missing = JAVA_FOR_MINECRAFT.filter((r) => best < r.java);
  const list = found.map((j) => `${j.path} (Java ${j.major})`).join('; ');
  if (!enough.length) return { ok: false, label: `Java found: ${list}. Too old for Minecraft ${JAVA_FOR_MINECRAFT[0].minecraft} (needs Java ${JAVA_FOR_MINECRAFT[0].java})`, fix: hint };
  const notEnough = missing.length ? ` Not enough for Minecraft ${missing.map((r) => `${r.minecraft} (needs Java ${r.java})`).join(', ')}.` : '';
  return { ok: true, label: `Java found: ${list}. Enough for Minecraft ${enough.map((r) => r.minecraft).join(', ')}.${notEnough}` };
}

async function checkServer(config: Config): Promise<Check[]> {
  const s = new Context(config).findServer();
  if (!s) return [{ ok: true, label: 'No test server yet. Ask your agent to set one up; it starts with plan_setup and asks you before it downloads anything.' }];
  try {
    return await serverChecks(s);
  } catch (e) {
    return [{ ok: false, label: `Test server ${s.dir}: ${message(e)}`, fix: 'Fix what the message says; ask your agent to read the file with read_file if needed.' }];
  } finally {
    s.closeConnections();
  }
}

async function serverChecks(s: TestServer): Promise<Check[]> {
  const m = s.meta;
  const name = `Test server ${s.dir} (Minecraft ${m.minecraft}, ${m.loader}${m.loaderVersion ? ` ${m.loaderVersion}` : ''})`;
  const checks: Check[] = [
    eulaAccepted(s.dir)
      ? { ok: true, label: `${name}, EULA accepted` }
      : { ok: false, label: `${name}: the Minecraft EULA is not accepted yet, so it cannot start`, fix: `Read the EULA at ${EULA_URL}. If you accept it, tell your agent, which then calls accept_eula.` },
  ];
  const needed = javaNeededFor(m.minecraft);
  if (!existsSync(m.javaPath)) {
    checks.push({ ok: false, label: `The server's Java ${m.javaPath} is gone`, fix: 'Install Java again, or ask your agent to run plan_setup to see which Java is needed and make the server again.' });
  } else if (needed !== null && m.javaMajor < needed) {
    checks.push({ ok: false, label: `The server's Java ${m.javaPath} is Java ${m.javaMajor}; Minecraft ${m.minecraft} needs Java ${needed}`, fix: `Install Java ${needed}, then ask your agent to make the server again with it.` });
  } else {
    checks.push({ ok: true, label: `The server's Java ${m.javaPath} (Java ${m.javaMajor}) is there${needed !== null ? `; Minecraft ${m.minecraft} needs Java ${needed}` : ''}` });
  }
  const st = await s.status();
  const ports = `game port ${s.gamePort}, RCON port ${m.rconPort}`;
  if (st.rcon) {
    const ip = s.properties().get('server-ip') ?? '';
    checks.push(
      isLoopback(ip)
        ? { ok: true, label: `The server is running and answers on RCON (127.0.0.1); ${ports}. Join at localhost:${s.gamePort}.` }
        : { ok: false, label: `The server is running, but server.properties says server-ip=${ip}, so it may be reachable from other computers`, fix: 'Ask your agent to stop_server and then start_server: the tool puts back 127.0.0.1 before every start.' },
    );
  } else if (st.pid !== null) {
    checks.push({ ok: false, label: `The server process ${st.pid} runs but does not answer on RCON (still starting, or stuck)`, fix: 'Wait a minute and run doctor again. If it stays like this, ask your agent to stop_server with force: true.' });
  } else {
    const busy: string[] = [];
    for (const [what, port] of [['Game', s.gamePort], ['RCON', m.rconPort]] as const) if (!(await portFree(port))) busy.push(`${what} port ${port}`);
    checks.push(
      busy.length
        ? { ok: false, label: `The server is stopped, and ${busy.join(' and ')} ${busy.length > 1 ? 'are' : 'is'} in use by another program`, fix: 'Close the other program (often another Minecraft server), or ask your agent to change the port in server.properties.' }
        : { ok: true, label: `The server is stopped; ${ports} are free` },
    );
  }
  return checks;
}

export function checkSkill(env: NodeJS.ProcessEnv, home: string, cwd: string, bundled = join(skillPath(), 'SKILL.md')): Check {
  const personal = join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'skills', 'map-builder');
  const places = [personal, join(cwd, '.claude', 'skills', 'map-builder')];
  const found = places.filter((p) => existsSync(join(p, 'SKILL.md')));
  const copy = `Copy the folder ${skillPath()} to ${personal} (npx -y stonecut-map-builder --skill-path prints the first one).`;
  if (!found.length) return { ok: false, label: `The map-builder skill is not installed (looked in ${places.join(' and ')})`, fix: copy };
  const want = readFileSync(bundled, 'utf8');
  const old = found.filter((p) => readFileSync(join(p, 'SKILL.md'), 'utf8') !== want);
  return old.length
    ? { ok: false, label: `The map-builder skill in ${old.join(' and ')} differs from the one in this version`, fix: `If you did not change it yourself, copy it again: ${copy}` }
    : { ok: true, label: `The map-builder skill is installed and up to date in ${found.join(' and ')}` };
}

async function checkStart(start: () => Promise<number>, settingsOk: boolean): Promise<Check> {
  try {
    const tools = await start();
    return tools === ALL_TOOLS.length
      ? { ok: true, label: `The MCP server starts and lists its ${tools} tools` }
      : { ok: false, label: `The MCP server starts but lists ${tools} tools instead of ${ALL_TOOLS.length}`, fix: 'Update to the latest version: npx -y stonecut-map-builder@latest doctor' };
  } catch (e) {
    return {
      ok: false,
      label: `The MCP server does not start: ${message(e)}`,
      fix: settingsOk ? `Check the message above. To add it to Claude Code again: ${ADD_COMMAND}. In VS Code, where the claude command is usually missing, use the VS Code command in the README's setup step 3.` : 'Fix the settings file first (see above).',
    };
  }
}

/** Every check, in order. Reads only; see the note at the top of this file for what it runs. */
export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [checkNode(deps.nodeVersion)];
  const settings = checkSettings(deps.env, deps.home);
  checks.push(settings.check);
  const config = settings.config;
  checks.push(checkJava(await deps.findJava(config?.javaPath ? [config.javaPath] : []), config?.javaPath));
  if (config) checks.push(...(await checkServer(config)));
  else checks.push({ ok: false, label: 'Test server not checked, because the settings file has a problem', fix: 'Fix the settings file first (see above).' });
  checks.push(checkSkill(deps.env, deps.home, deps.cwd));
  checks.push(await checkStart(deps.startServer, config !== null));
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.ok || !c.fix ? '' : `\n      Fix: ${c.fix}`}`);
  const failed = checks.filter((c) => !c.ok).length;
  return `${lines.join('\n')}\n\n${failed ? `${failed} of ${checks.length} checks failed.` : `All ${checks.length} checks passed.`}`;
}

/** Starts the built MCP server (dist/index.js) over stdio, as an MCP client would, and counts its tools. */
export async function startOnce(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./index.js', import.meta.url))],
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
    stderr: 'pipe',
  });
  let errors = '';
  transport.stderr?.on('data', (d: Buffer) => (errors += d.toString()));
  const client = new Client({ name: 'stonecut-doctor', version: VERSION });
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = async () => {
      await client.connect(transport);
      return (await client.listTools()).tools.length;
    };
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${START_TIMEOUT_MS / 1000}s`)), START_TIMEOUT_MS)));
    return await Promise.race([run(), late]);
  } catch (e) {
    throw new Error(errors.trim() || message(e));
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

/** The doctor command: prints every check and returns the exit code (0 when all pass). */
export async function doctor(): Promise<number> {
  process.stdout.write(
    `Stonecut Map Builder ${VERSION} doctor. It changes nothing. It runs java -version for each Java it finds, asks the test server whether it runs (RCON on 127.0.0.1), listens on 127.0.0.1 for a moment to see whether the ports are free, and starts this MCP server once. It contacts nothing else.\n\n`,
  );
  const checks = await runDoctor({ env: process.env, home: homedir(), cwd: process.cwd(), nodeVersion: process.version, findJava: (extra) => findJava(extra), startServer: () => startOnce() });
  process.stdout.write(`${formatChecks(checks)}\n`);
  return checks.every((c) => c.ok) ? 0 : 1;
}
