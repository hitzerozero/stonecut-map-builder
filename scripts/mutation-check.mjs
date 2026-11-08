// Breaks one line of code at a time, runs the unit tests, and puts the line back. Shows that
// every test runs real code: each test must fail under at least one of these breaks, and every
// break must make at least one test fail.
//
//   node scripts/mutation-check.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const M = (file, find, replace) => ({ file, find, replace });
const MUTATIONS = [
  M('src/nbt/nbt.ts', "case 'short': return this.i16(tag.value);", "case 'short': return this.i32(tag.value);"),
  M('src/nbt/nbt.ts', 'if (buf[0] === 0x1f && buf[1] === 0x8b) raw', 'if (false) raw'),
  M('src/nbt/nbt.ts', 'if (c !== 0 && c < 0x80) out.push(c);', 'if (c < 0x80) out.push(c);'),
  M('src/nbt/nbt.ts', 'if (n < 0 || this.pos + n > this.buf.length) throw', 'if (n < 0) throw'),
  M('src/nbt/snbt.ts', "case 'byte': return `${tag.value}b`;", "case 'byte': return `${tag.value}`;"),
  M('src/schematic/sponge.ts', "['Offset', nbt.intArray(s.offset)],", "['Offset', nbt.intArray([0, 0, 0])],"),
  M('src/schematic/sponge.ts', "['Id', nbt.string(be.id)], ...be.data.value])", "['Id', nbt.string(be.id)]])"),
  M('src/schematic/sponge.ts', "writeNbt('', nbt.compound({ Schematic: inner }))", "writeNbt('', inner)"),
  M('src/schematic/sponge.ts', "gzipSync(writeNbt('Schematic', root))", "gzipSync(writeNbt('', root))"),
  M('src/schematic/sponge.ts', '    palette[t.value] = state;', '    palette.push(state);'),
  M('src/schematic/sponge.ts', '    return v & 0xffff;', '    return v;'),
  M('src/schematic/sponge.ts', '      v >>>= 7;', '      v >>>= 6;'),
  M('src/schematic/sponge.ts', 'if (options.maxBlocks !== undefined && volume > options.maxBlocks)', 'if (false)'),
  M('src/world/region.ts', '  if (paletteSize <= 1 || !data) return out;\n  const bits = Math.max(4,', '  if (paletteSize <= 1 || !data) return out;\n  const bits = Math.max(5,'),
  M('src/world/region.ts', "    .sort();\n  return `${name}[", "\n  return `${name}["),
  M('src/safety/paths.ts', "const parts = cleaned.split('/').filter((s) => s !== '' && s !== '.');", "const parts = cleaned.split('/').filter((s) => s !== '');"),
  M('src/safety/paths.ts', "if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || isAbsolute(userPath))", 'if (false)'),
  M('src/safety/paths.ts', 'if (WINDOWS_DEVICE.test(part))', 'if (false)'),
  M('src/safety/paths.ts', 'if (hidden.includes(fold(parts[0]!)))', 'if (false)'),
  M('src/safety/paths.ts', 'if (!isInside(rootReal, real)) throw', 'if (false) throw'),
  M('src/safety/paths.ts', "if (part === '..') throw", "if (false) throw"),
  M('src/safety/paths.ts', 'if (isInside(realOrSelf(resolve(root)), real)) return real;', 'return real;'),
  M('src/safety/address.ts', "if (isIP(h) === 4) return h.split('.')[0] === '127';", 'if (isIP(h) === 4) return true;'),
  M('src/safety/address.ts', 'port < 1024', 'port < 1'),
  M('src/rcon/rcon.ts', "    assertLoopback(host, 'RCON address');\n", ''),
  M('src/safety/address.ts', "if (u.protocol !== 'https:')", 'if (false)'),
  M('src/mc/box.ts', 'max[axis] = Math.min(b.max[axis]!, s + thick - 1);', 'max[axis] = Math.min(b.max[axis]!, s + thick);'),
  M('src/mc/blocks.ts', '(o, r) => (o.y1 = r.y1),', '(o, r) => void [o, r],'),
  M('src/mc/blocks.ts', 'for (const p of list) last.set(xyz(p.pos), p);', 'for (const p of list) if (!last.has(xyz(p.pos))) last.set(xyz(p.pos), p);'),
  M('src/mc/blocks.ts', 'if (isFragile(r.state)) fragile.push', 'if (false) fragile.push'),
  M('src/mc/blocks.ts', 'if (Buffer.byteLength(cmd) > MAX_COMMAND_BYTES) {\n      batch.warnings', 'if (false) {\n      batch.warnings'),
  M('src/mc/blocks.ts', "if ((mode === 'hollow' || mode === 'outline') && boxSize(b)", "if (false && boxSize(b)"),
  M('src/mc/blocks.ts', 'const BLOCK_STATE = new RegExp(`^(?:', 'const BLOCK_STATE = new RegExp(`(?:'),
  M('src/mc/blocks.ts', '        if (isAir(state)) continue;\n', ''),
  M('src/ops/readout.ts', 'out.push(j - i > 1 ?', 'out.push(j - i > 2 ?'),
  M('src/rcon/rcon.ts', '    if (buf.length - p - 4 < len) break;\n', ''),
  M('src/rcon/rcon.ts', 'if (pkt.body.length >= FRAGMENT) w.settle', 'if (false) w.settle'),
  M('src/rcon/rcon.ts', 'if (pkt.id === -1) {', 'if (false) {'),
  M('src/rcon/rcon.ts', 'if (Buffer.byteLength(c) > MAX_COMMAND_BYTES) {', 'if (false) {'),
  M('src/rcon/rcon.ts', 'const m = /(\\d+) block/i.exec(reply);', 'const m = /(\\d+)x block/i.exec(reply);'),
  M('src/rcon/rcon.ts', "  if (UNCHANGED.test(r)) return 'unchanged';\n", ''),
  M('src/config.ts', '  allowModInstall: false,', '  allowModInstall: true,'),
  M('src/config.ts', "join(home, 'Library', 'Application Support', APP_FOLDER)", "join(home, 'Library', 'Application', APP_FOLDER)"),
  M('src/config.ts', "if (p.startsWith('~/') || p.startsWith('~\\\\'))", "if (p.startsWith('~~/'))"),
  M('src/config.ts', 'export const configSchema = z.strictObject({', 'export const configSchema = z.object({'),
  M('src/config.ts', '    maxFileBytes: DEFAULTS.maxFileBytes,\n    maxEntities', '    maxFileBytes: 1,\n    maxEntities'),
  M('src/config.ts', '    undoHistory: DEFAULTS.undoHistory,\n    rconAddress', '    undoHistory: 5,\n    rconAddress'),
  M('src/mc/versions.ts', "export const MIN_VERSION = '1.20.1';", "export const MIN_VERSION = '1.19.4';"),
  M('src/mc/versions.ts', 'const version = stable[stable.length - 1] ?? beta[beta.length - 1];', 'const version = beta[beta.length - 1] ?? stable[stable.length - 1];'),
  M('src/mc/java.ts', 'const major = parts[0] === 1 ? parts[1]! : parts[0]!;', 'const major = parts[0]!;'),
  M('src/mc/java.ts', '  if (env.JAVA_HOME) out.push(bin(env.JAVA_HOME));\n', ''),
  M('src/mc/properties.ts', '  for (const [k, v] of left) kept.push(`${k}=${escape(v)}`);\n', ''),
  M('src/mc/properties.ts', "isLoopback(props.get('server-ip') ?? '') ? props.get('server-ip')! : RCON_HOST", "props.get('server-ip') ?? RCON_HOST"),
  M('src/mc/setup.ts', "    'server-ip': '127.0.0.1',", "    'server-ip': '0.0.0.0',"),
  M('src/server.ts', '...schematicTools, ...backupTools, ...fileTools', '...schematicTools, ...fileTools'),
  M('src/tools/define.ts', 'destructiveHint: spec.readOnly ? false : spec.destructive,', 'destructiveHint: true,'),
  M('src/schemas.ts', "z.number().int('Coordinates are whole numbers')", 'z.number()'),
  M('src/tools/define.ts', 'if (spec.needsOk && ctx.config.confirmDestructive && args.confirm !== true)', 'if (false)'),
  M('src/tools/blocks.ts', 'if (v > ctx.config.maxReadBlocks) {', 'if (false) {'),
  M('src/tools/setup.ts', '      if (!s) {\n        const java', '      if (false) {\n        const java'),
  M('src/mc/testserver.ts', 'if (!eulaAccepted(this.dir)) {', 'if (false) {'),
  M('src/ops/files.ts', "      if (dir === server.dir && d.name.toLowerCase() === STATE_DIR) continue;\n", ''),
  M('src/ops/files.ts', 'if (PROTECTED_EXT.test(name))', 'if (false)'),
  M('src/ops/files.ts', 'if (existed && !overwrite) throw', 'if (false) throw'),
  M('src/ops/files.ts', 'if (isCodeFile(shown(server.dir, p)) && !config.allowModInstall) {', 'if (false) {'),
  M('src/mc/properties.ts', "'$1<hidden>'", "'$1'"),
  M('src/ops/files.ts', "  if (!existsSync(start)) throw new FileError(`Nothing at ${rel}`);\n", ''),
  M('src/ops/undo.ts', 'ids.slice(0, Math.max(0, ids.length + 1 - this.keep))', 'ids.slice(0, 0)'),
  M('src/ops/undo.ts', '    if (id === undefined) return null;\n', ''),
  M('src/world/entities.ts', "if (id === 'minecraft:player' || isDead(e) || !insideBox(pos, box)) continue;", "if (id === 'minecraft:player') continue;"),
  M('src/world/entities.ts', 'return health !== undefined && health <= 0;', 'return false;'),
  M('src/schematic/sponge.ts', 'nbt.compound({ Pos: posList(e.pos), Id: nbt.string(e.id), Data: e.data })', 'nbt.compound({ Pos: posList([0, 0, 0]), Id: nbt.string(e.id), Data: e.data })'),
  M('src/schematic/sponge.ts', '...(s.origin ? { Stonecut:', '...(false ? { Stonecut:'),
  M('src/mc/entities.ts', "if (t?.type === 'intArray' && t.value.length === 3) t.value.forEach((v, i) => (t.value[i] = v + d[i]!));", "if (t?.type === 'intArray' && t.value.length === 3) t.value.forEach((v, i) => (t.value[i] = v));"),
  M('src/mc/entities.ts', 'if (next) next.forEach((v, i) => (t.value[i] = v));', 'if (false) next.forEach((v, i) => (t.value[i] = v));'),
  M('src/mc/entities.ts', 'const place = hb ?? at;', 'const place = at;'),
  M('src/mc/entities.ts', "if (e.id === 'minecraft:player' || e.id === 'player') {", 'if (false) {'),
  M('src/mc/entities.ts', 'else if (savedPos && savedPos.every(Number.isFinite)) d =', 'else if (false) d ='),
  M('src/mc/entities.ts', 'merges.push(`data merge entity ${uuid} ${part}`)', 'void part'),
  M('src/mc/entities.ts', "for (const r of get(data, 'Passengers', 'list')?.value ?? []) if (r.type === 'compound') remove(r);", ''),
  M('src/mc/entities.ts', ".padStart(8, '0')", ".padStart(7, '0')"),
  M('src/config.ts', '  includeEntities: true,', '  includeEntities: false,'),
  M('src/tools/blocks.ts', 'input: { ...area, include_entities: includeEntities, dimension, confirm, skip_backup: skipBackup },', 'input: { ...area, dimension, confirm, skip_backup: skipBackup },'),
  M('src/version.ts', "export const VERSION = '0.1.0';", "export const VERSION = '0.1.0'; // " + ['C:', 'Us' + 'ers', 'someone', 'x'].join('\\\\')),
  M('src/mc/properties.ts', 'const physicalLines = (text: string) => text.split(/\\r\\n|\\r|\\n/);', 'const physicalLines = (text: string) => text.split(/\\r?\\n/);'),
  M('src/mc/properties.ts', '    for (let i = e.first + 1; i <= e.last; i++) lines[i] = null;\n', ''),
  M('src/mc/properties.ts', '...(management !== undefined && !isLoopback(management) ? {', '...(false ? {'),
  M('src/safety/paths.ts', "if (first !== '' && hidden.includes(fold(first))) throw", 'if (false) throw'),
  M('src/ops/files.ts', "  if (pw) text = text.split(pw).join('<hidden>');\n", ''),
  M('src/ops/files.ts', "  if (settings) parseProperties(data.toString('utf8'));\n", ''),
  M('src/mc/testserver.ts', '      return resolveInside(this.dir, name, { hidden: [STATE_DIR] });', '      return join(this.dir, name);'),
  M('src/mc/testserver.ts', '    if (statSync(this.pidFile).mtimeMs < Date.now() - uptime() * 1000) return null;\n', ''),
  M('src/mc/testserver.ts', '  return canListen.then(async (free) => free && !(await answers()));', '  return Promise.resolve(true);'),
  M('src/mc/setup.ts', '  if (inServerFolder) throw', '  if (false) throw'),
  M('src/ops/world.ts', '    checkChunks(chunkCount(box));\n', ''),
  M('src/nbt/nbt.ts', "    if (--this.tagsLeft < 0) throw new NbtError('NBT data has too many tags');\n", ''),
  M('src/mc/versions.ts', '/^[\\w.-]+$/.test(v) && ', ''),
  M('src/doctor.ts', 'return major >= MIN_NODE', 'return major >= 0'),
  M('src/doctor.ts', " : ' (not made yet)'", " : ''"),
  M('src/doctor.ts', 'const enough = JAVA_FOR_MINECRAFT.filter((r) => best >= r.java);', 'const enough = JAVA_FOR_MINECRAFT.filter((r) => best > r.java);'),
  M('src/doctor.ts', "const places = [personal, join(cwd, '.claude', 'skills', 'map-builder')];", 'const places = [personal];'),
  M('src/doctor.ts', "readFileSync(join(p, 'SKILL.md'), 'utf8') !== want", "readFileSync(join(p, 'SKILL.md'), 'utf8') === want"),
  M('src/doctor.ts', '    eulaAccepted(s.dir)\n', '    true\n'),
  M('src/doctor.ts', 'if (!(await portFree(port))) busy.push(', 'if (false) busy.push('),
  M('src/doctor.ts', 'return tools === ALL_TOOLS.length', 'return tools > 0'),
  M('test/hygiene.test.ts',"{ name: 'Linux home path', re: /(?<![\\w.])\\/home\\/", "{ name: 'Linux home path', re: /(?<![\\w.])\\/hom\\/"),
];

const root = join(import.meta.dirname, '..');
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const out = join(tmpdir(), `stonecut-mutation-${process.pid}.json`);

function runTests() {
  try {
    execFileSync(process.execPath, [vitest, 'run', '--reporter=json', `--outputFile=${out}`], { cwd: root, stdio: 'ignore' });
  } catch {
    // failing tests make vitest exit non-zero; the JSON says which
  }
  const report = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  const all = [];
  for (const file of report.testResults) {
    for (const t of file.assertionResults) all.push({ name: `${file.name.slice(root.length + 1).replace(/\\/g, '/')} > ${t.title}`, failed: t.status !== 'passed' });
  }
  return all;
}

const baseline = runTests();
if (baseline.some((t) => t.failed)) {
  console.error('Some tests fail before any change; fix them first.');
  process.exit(1);
}
const caughtBy = new Map(baseline.map((t) => [t.name, []]));
const missed = [];

for (const [i, m] of MUTATIONS.entries()) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    console.error(`Break ${i + 1} (${m.file}): the line to break appears ${count} times`);
    process.exit(1);
  }
  writeFileSync(path, original.replace(m.find, m.replace));
  let results;
  try {
    results = runTests();
  } finally {
    writeFileSync(path, original);
  }
  const failed = results.filter((t) => t.failed).map((t) => t.name);
  console.log(`Break ${String(i + 1).padStart(2)} ${m.file}: ${m.find.split('\n')[0].trim().slice(0, 70)}`);
  for (const f of failed) console.log(`    fails: ${f}`);
  if (!failed.length) missed.push(i + 1);
  for (const f of failed) caughtBy.get(f)?.push(i + 1);
}

const neverFailed = [...caughtBy.entries()].filter(([, v]) => v.length === 0).map(([k]) => k);
console.log(`\n${MUTATIONS.length} breaks, ${baseline.length} tests.`);
console.log(`Every line was put back. Tests that failed under at least one break: ${baseline.length - neverFailed.length}/${baseline.length}.`);
if (missed.length) console.log(`Breaks no test caught: ${missed.join(', ')}`);
if (neverFailed.length) console.log(`Tests that never failed:\n  ${neverFailed.join('\n  ')}`);
const after = runTests();
console.log(after.every((t) => !t.failed) ? 'All tests pass again with the code restored.' : 'WARNING: tests fail after restoring.');
process.exit(missed.length || neverFailed.length || after.some((t) => t.failed) ? 1 : 0);
