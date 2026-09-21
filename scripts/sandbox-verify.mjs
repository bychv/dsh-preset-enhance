#!/usr/bin/env node
/**
 * Independent adversarial verification driver for tool presets/groups (task-5).
 *
 * This script is deliberately separate from the implementation's own tests: it
 * asserts the SPEC from docs/TOOL_GROUPS_IMPLEMENTATION.md, not the code, and it
 * reports per acceptance item whether the claim was verified, falsified, or not
 * observed.
 *
 * Modes (nothing here ever writes to the host dsh install or host DSH_HOME):
 *   baseline [--out <file>]                  capture a host file inventory (read-only walk)
 *   diff [--before <f>] [--after <f>]        compare two inventories; exit 1 when the host changed
 *   api --url <token-or-base-url>            drive a RUNNING sandbox web instance over HTTP
 *   runtime                                  in-process harness on real DSH packages + mock adapter
 *   all --url <url>                          baseline diff (if given) + api + runtime
 *
 * All reports and scratch files go to %TEMP%\dsv (the sandbox path is read-only
 * for this session). Run with the sandbox's pinned Node when possible:
 *   & 'F:\Git\dsh-compact-sandbox\.runtime\node.exe' scripts/sandbox-verify.mjs ...
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SANDBOX = 'F:\\Git\\dsh-compact-sandbox';
const SLOT_NAME = (() => {
  const index = process.argv.indexOf('--slot');
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : 'candidate';
})();
const SLOT = path.join(SANDBOX, '.sandboxes', SLOT_NAME);
const APP_NM = path.join(SLOT, 'app', 'node_modules');
const SLOT_PROFILE = path.join(SLOT, 'home', 'profiles', 'web');
const SLOT_STATE = path.join(SLOT, 'home', 'preset-enhance', 'state.json');
const SLOT_SMOKE = path.join(SANDBOX, 'reports', `${SLOT_NAME}-smoke.json`);
const SANDBOX_NODE = path.join(SANDBOX, '.runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const HOST_DSH_PKG = 'C:\\Users\\Administrator.DESKTOP-UFD7LVF\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh';
const HOST_DSH_HOME = 'C:\\Users\\Administrator.DESKTOP-UFD7LVF\\.dsh';
const TEMP_ROOT = path.join(process.env.TEMP || os.tmpdir(), 'dsv');
const REPORT_DIR = path.join(TEMP_ROOT, 'reports');
// Slot-scoped scratch: a candidate run and an alpha run must never share a state.json.
const MIRROR = path.join(TEMP_ROOT, `${SLOT_NAME}-mirror`);
const BUILTIN_MODE_IDS = ['standard', 'minimal', 'ptc', 'cordis'];

// ---------------------------------------------------------------------------
// result model
// ---------------------------------------------------------------------------
const results = [];
const VERDICTS = new Set(['verified', 'falsified', 'not-verified', 'blocked', 'info']);
function record(item, verdict, title, detail = '', evidence = undefined) {
  if (!VERDICTS.has(verdict)) throw new Error(`bad verdict ${verdict}`);
  results.push({ item, verdict, title, detail, evidence });
  const tag = { verified: 'PASS ', falsified: 'FAIL ', 'not-verified': 'N/OBS', blocked: 'BLOCK', info: 'INFO ' }[verdict];
  console.log(`[${tag}] ${item}: ${title}${detail ? ` — ${detail}` : ''}`);
}
const say = (...args) => console.log(...args);

function finish(reportName) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(REPORT_DIR, `${reportName}-${stamp}.json`);
  const summary = {};
  for (const r of results) summary[r.verdict] = (summary[r.verdict] ?? 0) + 1;
  const payload = {
    driver: 'scripts/sandbox-verify.mjs',
    repo: REPO,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    hostGuards: [HOST_DSH_PKG, HOST_DSH_HOME],
    summary,
    results,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  say(`\n== summary == ${JSON.stringify(summary)}`);
  say(`report: ${file}`);
  return file;
}

// ---------------------------------------------------------------------------
// path / process helpers
// ---------------------------------------------------------------------------
function assertNotHost(target) {
  const abs = path.resolve(target).toLowerCase();
  for (const guard of [HOST_DSH_PKG, HOST_DSH_HOME]) {
    const g = path.resolve(guard).toLowerCase();
    if (abs === g || abs.startsWith(g + path.sep)) {
      throw new Error(`REFUSING to touch the host dsh path: ${target}`);
    }
  }
  return target;
}
function ensureDir(dir) {
  assertNotHost(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Spawn with file-redirected stdio (pipes are unavailable in this sandbox). */
function run(cmd, args, { cwd, env = process.env, log, timeoutMs = 300000 } = {}) {
  const outFile = log ?? path.join(TEMP_ROOT, 'logs', `spawn-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  ensureDir(path.dirname(outFile));
  const fd = fs.openSync(outFile, 'a');
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`timeout after ${timeoutMs}ms: ${cmd} ${args.join(' ')}\n${tail(outFile)}`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); fs.closeSync(fd); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      const output = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      resolve({ code, output, log: outFile });
    });
  });
}
function tail(file, bytes = 4000) {
  try { return fs.readFileSync(file, 'utf8').slice(-bytes); } catch { return ''; }
}
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// frozen-revision provenance
// ---------------------------------------------------------------------------
const REVISION_FILES = ['index.mjs', 'lib/tool-presets.mjs', 'lib/store.mjs', 'lib/preset-package.mjs', 'web/editor.js', 'web/index.html', 'web/editor.css'];
function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function slotVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_NM, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
}
/** The repo's declared engines.dsh range, i.e. the range the package actually ships. */
function declaredEngineRange() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines?.dsh ?? null; }
  catch { return null; }
}
/**
 * Evaluate a declared engines.dsh range against the slot with node-semver (the
 * library family npm/pnpm use, so prerelease rules match what an installer
 * would apply). Returns null when the range or an implementation is missing:
 * this driver must never guess a range the package.json does not declare.
 */
function engineRangeSatisfied(version, range) {
  if (!version || version === 'unknown' || !range) return null;
  const resolvers = [
    () => createRequire(path.join(SLOT, 'app', 'package.json'))('semver'),
    () => createRequire(path.join(SANDBOX, '.runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'))('semver'),
  ];
  for (const resolve of resolvers) {
    try { return resolve().satisfies(version, range); } catch {}
  }
  return null;
}
/** The live slot must run exactly the frozen repo revision, not a stale tarball. */
function revisionChecks() {
  const repo = {};
  for (const rel of REVISION_FILES) {
    const file = path.join(REPO, rel);
    repo[rel] = fs.existsSync(file) ? fileHash(file) : undefined;
  }
  const installedDir = path.join(SLOT_PROFILE, 'node_modules', 'dsh-preset-enhance');
  const mismatches = [];
  const hashes = {};
  for (const rel of REVISION_FILES) {
    const installed = path.join(installedDir, rel);
    const hash = fs.existsSync(installed) ? fileHash(installed) : undefined;
    hashes[rel] = { repo: repo[rel]?.slice(0, 12), installed: hash?.slice(0, 12) };
    if (!hash || hash !== repo[rel]) mismatches.push(rel);
  }
  const version = slotVersion();
  record('revision', 'info', `slot ${SLOT_NAME} runs dsh ${version}`,
    `pluginDir=${installedDir} packageVersion=${(() => { try { return JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8')).version; } catch { return '?'; } })()}`);
  const declaredRange = declaredEngineRange();
  const satisfied = engineRangeSatisfied(version, declaredRange);
  record('revision', mismatches.length === 0 ? 'verified' : 'falsified',
    'installed plugin in the live slot is byte-identical to the frozen repo revision',
    `mismatches=[${mismatches.join(',')}] hashes=${JSON.stringify(hashes)}`);
  record('revision', satisfied === true ? 'verified' : satisfied === false ? 'falsified' : 'not-verified',
    `declared engines.dsh vs slot dsh ${version}`,
    satisfied === null
      ? `could not evaluate (engines.dsh=${JSON.stringify(declaredRange ?? null)}, semver unavailable)`
      : `engines.dsh=${declaredRange} => ${satisfied ? 'SATISFIED' : 'NOT SATISFIED'} by ${version} (node-semver, prerelease rules included)`);
  try {
    const smoke = JSON.parse(fs.readFileSync(SLOT_SMOKE, 'utf8'));
    record('smoke', smoke.passed === true ? 'verified' : 'falsified', `sandbox smoke report ${SLOT_NAME}`,
      `passed=${smoke.passed} dshVersion=${smoke.dshVersion} checks=${JSON.stringify(smoke.checks)} plugins=${JSON.stringify(smoke.plugins)}`);
  } catch (error) {
    record('smoke', 'not-verified', `sandbox smoke report ${SLOT_NAME} unreadable`, String(error?.message ?? error));
  }
}

// ---------------------------------------------------------------------------
// host baseline
// ---------------------------------------------------------------------------
function walkFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.isDirectory()) stack.push(full);
      else found.push({ p: full, l: stat.size, t: stat.mtime.toISOString() });
    }
  }
  return found;
}
function captureHostBaseline(outFile) {
  const roots = [
    { id: 'dsh-install', path: HOST_DSH_PKG },
    { id: 'dsh-home', path: HOST_DSH_HOME },
  ];
  const entries = [];
  const meta = [];
  for (const root of roots) {
    const files = fs.existsSync(root.path) ? walkFiles(root.path) : [];
    let bytes = 0;
    for (const f of files) bytes += f.l;
    meta.push({ id: root.id, path: root.path, exists: fs.existsSync(root.path), files: files.length, bytes });
    for (const f of files) entries.push({ r: root.id, ...f });
  }
  ensureDir(path.dirname(assertNotHost(outFile)));
  const payload = { generatedAt: new Date().toISOString(), by: 'scripts/sandbox-verify.mjs', roots: meta, entries };
  const text = JSON.stringify(payload) + '\n';
  fs.writeFileSync(outFile, text);
  return { file: outFile, bytes: text.length, sha256: sha256(text), roots: meta, entries: entries.length };
}
function diffBaseline(beforeFile, afterFile) {
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));
  const index = list => {
    const map = new Map();
    for (const e of list) map.set(`${e.r}\u0000${e.p}`, e);
    return map;
  };
  const b = index(before.entries);
  const a = index(after.entries);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, entry] of a) {
    const prev = b.get(key);
    if (!prev) added.push(entry);
    else if (prev.l !== entry.l || prev.t !== entry.t) changed.push({ before: prev, after: entry });
  }
  for (const [key, entry] of b) if (!a.has(key)) removed.push(entry);
  const rootPaths = new Map();
  for (const root of [...(before.roots ?? []), ...(after.roots ?? [])]) rootPaths.set(root.id, root.path);
  const table = {};
  const bump = (entry, field) => {
    const relative = path.relative(rootPaths.get(entry.r) ?? '', entry.p);
    const top = relative.split(path.sep)[0] || '(root)';
    table[entry.r] ??= {};
    table[entry.r][top] ??= { added: 0, removed: 0, changed: 0 };
    table[entry.r][top][field] += 1;
  };
  for (const entry of added) bump(entry, 'added');
  for (const entry of removed) bump(entry, 'removed');
  for (const entry of changed) bump(entry.after, 'changed');
  // Plugin-install / host-configuration surfaces: any change here means the host was touched.
  const criticalTop = { 'dsh-home': ['profiles', 'node_modules', 'plugins', 'preset-enhance', 'settings.yaml', '.credentials.yaml', '.anonymous-user-id'] };
  const critical = [];
  for (const [root, tops] of Object.entries(table)) {
    if (root === 'dsh-install') {
      for (const [top, counts] of Object.entries(tops)) if (counts.added + counts.removed + counts.changed > 0) critical.push({ root, top, ...counts });
      continue;
    }
    for (const top of criticalTop[root] ?? []) {
      const counts = tops[top];
      if (counts && counts.added + counts.removed + counts.changed > 0) critical.push({ root, top, ...counts });
    }
  }
  return {
    before: { generatedAt: before.generatedAt, roots: before.roots, entries: before.entries.length },
    after: { generatedAt: after.generatedAt, roots: after.roots, entries: after.entries.length },
    added: added.length, removed: removed.length, changed: changed.length,
    byTopLevel: table,
    critical,
    addedSample: added.slice(0, 20),
    removedSample: removed.slice(0, 20),
    changedSample: changed.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------
class ApiClient {
  constructor(base, cookie = '') { this.base = base; this.cookie = cookie; this.log = []; }
  async request(method, relative, body, rawBody) {
    const url = relative.startsWith('http') ? relative : this.base + relative;
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (rawBody !== undefined) { headers['content-type'] = 'application/json'; payload = rawBody; }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const response = await fetch(url, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    const entry = { method, path: relative, status: response.status, json, text: json === undefined ? text.slice(0, 400) : undefined };
    this.log.push(entry);
    return { status: response.status, json, text, headers: response.headers };
  }
  get(qs = '') { return this.request('GET', `/preset-enhance/api${qs}`); }
  getState() { return this.get('?sessionId='); }
  post(body) { return this.request('POST', '/preset-enhance/api', body); }
  postRaw(raw) { return this.request('POST', '/preset-enhance/api', undefined, raw); }
}

async function attach(url) {
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token') ?? parsed.searchParams.get('access_token');
  let cookie = '';
  if (token) {
    const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const setCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [];
    cookie = setCookies.map(value => value.split(';')[0]).join('; ');
    await login.arrayBuffer();
    if (!cookie) throw new Error(`launch URL did not yield a session cookie (status ${login.status})`);
  }
  return new ApiClient(parsed.origin, cookie);
}

// ---------------------------------------------------------------------------
// HTTP spec checks
// ---------------------------------------------------------------------------
const NEW_GET_FIELDS = ['toolGroups', 'toolPresets', 'modeToolSelections', 'sessionToolSelection', 'toolPresetRefCounts', 'unresolvedToolRefs', 'mcpToolGroups'];
const LEGACY_GET_FIELDS = ['revision', 'presets', 'binding', 'selectedPresetId', 'agentModes', 'toolCatalogs', 'toolCatalogErrors',
  'modeToolPolicies', 'sessionToolPolicy', 'autoEnableModes', 'sessionMode'];

const UI_MARKERS = [
  { id: 'tablist', re: /role="tablist"/, file: 'index.html' },
  { id: 'tab-selected', re: /aria-selected/, file: 'editor.js' },
  { id: 'group-content', re: /tool-group-content/, file: 'editor.js' },
  { id: 'tri-state', re: /indeterminate/, file: 'editor.js' },
  { id: 'manage-groups', re: /管理分组/, file: 'index.html' },
  { id: 'tabs-collapsed-key', re: /dsh-preset-enhance\.tool-tabs-collapsed/, file: 'editor.js' },
  { id: 'content-open-key', re: /dsh-preset-enhance\.tool-group-content-open/, file: 'editor.js' },
  { id: 'active-group-key', re: /dsh-preset-enhance\.tool-active-group/, file: 'editor.js' },
  { id: 'import-package-tools', re: /import-package-tools/, file: 'editor.js' },
  { id: 'save-tool-groups', re: /save-tool-groups/, file: 'editor.js' },
  { id: 'select-tool-policy', re: /select-tool-policy/, file: 'editor.js' },
  { id: 'keyboard-nav', re: /ArrowLeft|ArrowRight|Home|End/, file: 'editor.js' },
  { id: 'draft-dirty', re: /尚未保存/, file: 'editor.js' },
  { id: 'discard-confirm', re: /discardOkay/, file: 'editor.js' },
  { id: 'range-session', re: /当前会话/, file: 'index.html' },
  { id: 'virtual-tabs', re: /@ungrouped/, file: 'editor.js' },
  { id: 'compact-select', re: /tool-group-select/, file: 'index.html' },
  { id: 'aria-controls', re: /aria-controls/, file: 'editor.js' },
  { id: 'batch-buttons', re: /仅启用此组/, file: 'editor.js' },
  { id: 'restore-preset-values', re: /恢复预设值/, file: 'editor.js' },
  { id: 'collapse-toggle', re: /收起标签栏/, file: 'index.html' },
  { id: 'mobile-select', re: /matchMedia/, file: 'editor.js' },
  { id: 'group-batch-on', re: /全开/, file: 'editor.js' },
];

function sillyTavernPreset(name = 'verify') {
  return {
    prompts: [{ identifier: 'main', role: 'system', content: `${name} prompt`, enabled: true }],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
  };
}
function packageDocument({ name, presetId, groupId, rule, unknown = false }) {
  const document = {
    format: 'dsh-preset-enhance',
    version: 1,
    metadata: { name },
    preset: { format: 'sillytavern', data: sillyTavernPreset(name) },
    tools: {
      version: 1,
      activePresetId: presetId,
      presets: [{
        id: presetId, name: `${name} 工具预设`, description: '', defaultEnabled: true,
        groupIds: [groupId],
        rules: rule ? [rule] : [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      groups: [{
        id: groupId, name: `${name} 工具组`, description: '', order: 500,
        members: rule ? [{ modeId: rule.modeId, toolName: rule.toolName }] : [],
      }],
    },
    extensions: { verifyProbe: { keep: true } },
  };
  if (unknown) document.verifyUnknown = { keep: true, nested: [1, 2, 3] };
  return document;
}

async function apiChecks(api, opts = {}) {
  // ---- T0 GET shape -------------------------------------------------------
  const initial = await api.getState();
  if (initial.status !== 200 || !initial.json) {
    record('GET-shape', 'blocked', 'GET /preset-enhance/api did not return JSON', `status=${initial.status} text=${initial.text}`);
    return;
  }
  record('GET-shape', 'verified', 'GET /preset-enhance/api returns 200 JSON', `status=${initial.status} revision=${initial.json.revision}`);
  const state = initial.json;
  const missingNew = NEW_GET_FIELDS.filter(field => !(field in state));
  const missingLegacy = LEGACY_GET_FIELDS.filter(field => !(field in state));
  record('item 1', missingLegacy.length === 0 ? 'verified' : 'falsified',
    'legacy GET fields still present', `missing=[${missingLegacy.join(',')}]`);
  record('items 1-6', missingNew.length === 0 ? 'verified' : 'falsified',
    'new GET fields present', `missing=[${missingNew.join(',')}]`);
  if (missingNew.length > 0) return;

  // ---- modes + catalogs ---------------------------------------------------
  const modes = Array.isArray(state.agentModes) ? state.agentModes : [];
  const catalogs = state.toolCatalogs ?? {};
  const catalogNames = id => (Array.isArray(catalogs[id]) ? catalogs[id].map(t => t.name) : []);
  const builtin = modes.find(mode => BUILTIN_MODE_IDS.includes(mode.id) && !mode.broken && catalogNames(mode.id).length > 0);
  const second = modes.find(mode => mode !== builtin && BUILTIN_MODE_IDS.includes(mode.id) && !mode.broken && catalogNames(mode.id).length > 0)
    ?? modes.find(mode => mode !== builtin && catalogNames(mode.id).length > 0);
  const stPreset = modes.find(mode => mode.id === 'st-preset');
  record('item 2/4', builtin && second ? 'verified' : 'falsified',
    'real agentModes include >=2 built-in modes with non-empty catalogs',
    `modes=[${modes.map(m => `${m.id}${m.broken ? '(broken)' : ''}`).join(',')}]`);
  record('item 4', stPreset && catalogNames('st-preset').length > 0 ? 'verified' : 'not-verified',
    'plugin-provided mode st-preset present with a real tool catalog',
    `st-preset=${stPreset ? 'present' : 'missing'} catalog=${catalogNames('st-preset').length}`);
  const shared = builtin && second ? catalogNames(builtin.id).filter(name => catalogNames(second.id).includes(name)) : [];
  record('item 2', shared.length > 0 ? 'verified' : 'not-verified',
    'two real modes share at least one tool name (needed for {modeId,toolName} checks)',
    `modeA=${builtin?.id} modeB=${second?.id} shared=[${shared.slice(0, 6).join(',')}] catalogSizes=${builtin ? catalogNames(builtin.id).length : 0}/${second ? catalogNames(second.id).length : 0}`);
  if (!builtin || !second || shared.length === 0) return;
  const modeA = builtin.id;
  const modeB = second.id;
  const toolName = shared[0];
  record('item 8', Array.isArray(state.unresolvedToolRefs) ? 'verified' : 'falsified', 'unresolvedToolRefs is an array', `len=${state.unresolvedToolRefs?.length}`);
  record('item 6', typeof state.toolPresetRefCounts === 'object' && state.toolPresetRefCounts !== null ? 'verified' : 'falsified', 'toolPresetRefCounts is an object');

  const revision = () => api.getState().then(r => r.json?.revision);
  let rev = state.revision;

  // ---- groups -------------------------------------------------------------
  const groups = [
    { id: 'verify-g1', name: '验证组一', description: '', order: 100, members: [{ modeId: modeA, toolName }] },
    { id: 'verify-g2', name: '验证组二', description: '', order: 200, members: [{ modeId: modeB, toolName }] },
  ];
  const saveGroups = async (list, body = {}) => api.post({ action: 'save-tool-groups', revision: rev, groups: list, ...body });
  let res = await saveGroups(groups);
  if (res.status === 200) rev = await revision();
  record('item 14 (positive)', res.status === 200 ? 'verified' : 'falsified',
    'save-tool-groups accepts two valid groups', `status=${res.status} body=${JSON.stringify(res.json)?.slice(0, 200)}`);

  const dup = await saveGroups([groups[0], { ...groups[1], members: [{ modeId: modeA, toolName }] }]);
  record('item 14', dup.status === 400 ? 'verified' : 'falsified',
    'duplicate {modeId,toolName} across groups rejected', `status=${dup.status} error=${dup.json?.error}`);
  const dupInside = await saveGroups([{ ...groups[0], members: [{ modeId: modeA, toolName }, { modeId: modeA, toolName }] }]);
  record('item 14', dupInside.status === 400 ? 'verified' : 'falsified',
    'duplicate member inside one group rejected', `status=${dupInside.status} error=${dupInside.json?.error}`);
  const atGroup = await saveGroups([{ ...groups[0], id: '@verify' }]);
  record('item 14', atGroup.status === 400 ? 'verified' : 'falsified',
    "'@'-prefixed group id rejected", `status=${atGroup.status} error=${atGroup.json?.error}`);
  const danglingMember = await saveGroups([{ ...groups[0], members: [{ modeId: modeA, toolName: 'no-such-tool-xyz' }] }]);
  record('item 14', danglingMember.status === 400 ? 'verified' : 'falsified',
    'unknown tool in a NEW group member rejected', `status=${danglingMember.status} error=${danglingMember.json?.error}`);
  const tooManyGroups = await saveGroups(Array.from({ length: 101 }, (_, index) => ({ id: `verify-limit-${index}`, name: `limit${index}`, description: '', order: index, members: [] })));
  record('item 14', tooManyGroups.status === 400 ? 'verified' : 'falsified',
    'more than 100 groups rejected', `status=${tooManyGroups.status} error=${tooManyGroups.json?.error}`);
  const tooManyMembers = await saveGroups([{ id: 'verify-members', name: '成员上限', description: '', order: 1, members: Array.from({ length: 2001 }, (_, index) => ({ modeId: modeA, toolName: `tool-${index}` })) }]);
  record('item 14', tooManyMembers.status === 400 ? 'verified' : 'falsified',
    'more than 2000 members in one group rejected', `status=${tooManyMembers.status} error=${tooManyMembers.json?.error}`);
  const tooManyRules = await api.post({
    action: 'save-tool-preset', revision: rev,
    preset: { name: '规则上限', defaultEnabled: true, groupIds: [], rules: Array.from({ length: 5001 }, (_, index) => ({ modeId: modeA, toolName: `tool-${index}`, enabled: false })) },
  });
  record('item 14', tooManyRules.status === 400 ? 'verified' : 'falsified',
    'more than 5000 rules in one preset rejected', `status=${tooManyRules.status} error=${tooManyRules.json?.error}`);
  const afterLimits = await api.getState();
  record('items 9/14', (afterLimits.json?.toolGroups?.length ?? 0) === 2 && !(afterLimits.json?.toolPresets ?? []).some(p => p.name === '规则上限') ? 'verified' : 'falsified',
    'over-limit payloads were rejected without partial writes',
    `groups=${afterLimits.json?.toolGroups?.length} hasRuleLimitPreset=${(afterLimits.json?.toolPresets ?? []).some(p => p.name === '规则上限')}`);
  const partial = await saveGroups([groups[0], { ...groups[1], id: '@bad' }]);
  record('items 9/14', partial.status === 400 ? 'verified' : 'falsified',
    'mixed valid+invalid save-tool-groups rejected', `status=${partial.status} error=${partial.json?.error}`);
  const afterPartial = await api.getState();
  record('items 9/14', JSON.stringify(afterPartial.json?.toolGroups) === JSON.stringify(groups) ? 'verified' : 'falsified',
    'rejected save left no partial write (all-or-nothing)',
    `stored=${JSON.stringify(afterPartial.json?.toolGroups)?.slice(0, 200)}`);

  // prototype-key probe (parsed from raw JSON so __proto__ is an own key)
  const protoRaw = JSON.stringify({
    action: 'save-tool-groups', revision: rev,
    groups: [{ id: 'verify-proto', name: 'proto', description: '', order: 300, members: [], pollute: { hacked: true } }],
  }).replace('"pollute"', '"__proto__"');
  const proto = await api.postRaw(protoRaw);
  record('item 14', proto.status === 400 || proto.status === 200 ? 'verified' : 'falsified',
    'prototype-key payload does not crash the handler', `status=${proto.status} body=${JSON.stringify(proto.json)?.slice(0, 200)}`);
  const afterProto = await api.getState();
  record('item 14', !JSON.stringify(afterProto.json?.toolGroups ?? []).includes('hacked') ? 'verified' : 'falsified',
    '__proto__ payload did not pollute the stored groups',
    `groups=${JSON.stringify(afterProto.json?.toolGroups)?.slice(0, 200)}`);
  if (proto.status === 200) rev = await revision();
  const protoRestore = await saveGroups(groups);
  if (protoRestore.status === 200) rev = await revision();
  record('item 14', protoRestore.status === 200 ? 'info' : 'falsified',
    'valid groups restored after the prototype probe', `status=${protoRestore.status} error=${protoRestore.json?.error}`);

  // ---- presets ------------------------------------------------------------
  const ruleA = { modeId: modeA, toolName, enabled: false };
  const ruleB = { modeId: modeB, toolName, enabled: false };
  const createPreset = async (preset, id) => api.post({ action: 'save-tool-preset', revision: rev, id, preset });
  let pA = await createPreset({ name: '验证预设A', description: 'spec', defaultEnabled: true, groupIds: ['verify-g1'], rules: [ruleA] });
  if (pA.status === 200) rev = await revision();
  let pB = await createPreset({ name: '验证预设B', description: 'spec', defaultEnabled: true, groupIds: ['verify-g2'], rules: [ruleB] });
  if (pB.status === 200) rev = await revision();
  record('item 3', pA.status === 200 && typeof pA.json?.id === 'string' ? 'verified' : 'falsified',
    'save-tool-preset creates a preset and returns its id', `A: status=${pA.status} id=${pA.json?.id} error=${pA.json?.error} warnings=${JSON.stringify(pA.json?.warnings)}`);
  record('item 3', pB.status === 200 ? 'verified' : 'falsified', 'second preset created', `B: status=${pB.status} id=${pB.json?.id} error=${pB.json?.error}`);

  const danglePreset = await createPreset({ name: '悬空', defaultEnabled: true, groupIds: ['verify-missing-group'], rules: [] });
  record('item 14', danglePreset.status === 400 ? 'verified' : 'falsified',
    'dangling groupIds rejected on save-tool-preset', `status=${danglePreset.status} error=${danglePreset.json?.error}`);
  if (danglePreset.status === 200) rev = await revision();
  const atPreset = await createPreset({ name: 'at', defaultEnabled: true, groupIds: [], rules: [] }, '@verify-preset');
  if (atPreset.status === 200) rev = await revision();
  const atState = await api.getState();
  record('item 14', atPreset.status === 400 || (typeof atPreset.json?.id === 'string' && atPreset.json.id !== '@verify-preset'
    && !(atState.json?.toolPresets ?? []).some(p => p.id.startsWith('@'))) ? 'verified' : 'falsified',
    "'@'-prefixed preset id can never be stored",
    `createStatus=${atPreset.status} returnedId=${atPreset.json?.id} storedAtIds=${JSON.stringify((atState.json?.toolPresets ?? []).map(p => p.id).filter(id => id.startsWith('@')))}`);
  const atDoc = packageDocument({ name: 'at-package', presetId: '@verify-at-pkg', groupId: 'verify-at-group', rule: null });
  const atImport = await api.post({ action: 'import', revision: rev, document: atDoc, name: 'at-package' });
  record('item 14', atImport.status === 400 ? 'verified' : 'falsified',
    "'@'-prefixed preset id inside an imported package rejected", `status=${atImport.status} error=${atImport.json?.error}`);
  const ghost = await createPreset({
    name: '失配引用', defaultEnabled: true, groupIds: [],
    rules: [{ modeId: 'missing-mode-xyz', toolName: 'ghost-tool', enabled: false }],
  });
  record('item 8', ghost.status === 200 && (ghost.json?.warnings?.length ?? 0) > 0 ? 'verified' : 'falsified',
    'preset with an unmatched ref saves with warnings', `status=${ghost.status} warnings=${JSON.stringify(ghost.json?.warnings)}`);
  if (ghost.status === 200) rev = await revision();
  const ghostState = await api.getState();
  const ghostRef = (ghostState.json?.unresolvedToolRefs ?? []).find(ref => ref.ownerId === ghost.json?.id);
  record('item 8', ghostRef && ghostRef.modeId === 'missing-mode-xyz' && ghostRef.toolName === 'ghost-tool' ? 'verified' : 'falsified',
    'unresolved ref is reported and preserved', `ref=${JSON.stringify(ghostRef)} preserved=${JSON.stringify(ghostState.json?.toolPresets?.find(p => p.id === ghost.json?.id)?.rules)}`);

  // ---- mode selection + ref counts ---------------------------------------
  const selectMode = (modeId, selection) => api.post({ action: 'select-tool-policy', revision: rev, scope: 'mode', modeId, selection });
  let selA = await selectMode(modeA, { kind: 'preset', presetId: pA.json?.id });
  if (selA.status === 200) rev = await revision();
  let selB = await selectMode(modeB, { kind: 'preset', presetId: pB.json?.id });
  if (selB.status === 200) rev = await revision();
  const selected = await api.getState();
  record('items 3/6', selected.json?.modeToolSelections?.[modeA]?.presetId === pA.json?.id
    && selected.json?.modeToolSelections?.[modeB]?.presetId === pB.json?.id ? 'verified' : 'falsified',
    'GET reflects mode preset selections',
    `modeToolSelections=${JSON.stringify(selected.json?.modeToolSelections)}`);
  record('item 6', selected.json?.toolPresetRefCounts?.[pA.json?.id]?.modes === 1 ? 'verified' : 'falsified',
    'toolPresetRefCounts counts the referencing mode',
    `refCounts=${JSON.stringify(selected.json?.toolPresetRefCounts?.[pA.json?.id])}`);

  const unknownMode = await selectMode('mode-does-not-exist', { kind: 'preset', presetId: pA.json?.id });
  record('item 14', unknownMode.status === 400 ? 'verified' : 'falsified', 'unknown mode rejected', `status=${unknownMode.status} error=${unknownMode.json?.error}`);
  const unknownSession = await api.post({ action: 'select-tool-policy', revision: rev, scope: 'session', sessionId: 'no-such-session', selection: { kind: 'inherit' } });
  record('items 14/5', unknownSession.status === 400 ? 'verified' : 'falsified', 'unknown session rejected', `status=${unknownSession.status} error=${unknownSession.json?.error}`);
  const badKind = await selectMode(modeA, { kind: 'nonsense' });
  record('item 14', badKind.status === 400 ? 'verified' : 'falsified', 'invalid selection kind rejected', `status=${badKind.status} error=${badKind.json?.error}`);
  const modeInherit = await selectMode(modeA, { kind: 'inherit' });
  record('items 5/14', modeInherit.status === 400 ? 'verified' : 'falsified', 'mode scope rejects inherit', `status=${modeInherit.status} error=${modeInherit.json?.error}`);

  // ---- revision conflict --------------------------------------------------
  const stale = await api.post({ action: 'save-tool-preset', revision: rev - 1, preset: { name: '冲突', defaultEnabled: true, groupIds: [], rules: [] } });
  const afterStale = await api.getState();
  record('item 13', stale.status === 400 && afterStale.json?.revision === rev ? 'verified' : 'falsified',
    'stale revision rejected with 400 and state unchanged',
    `status=${stale.status} error=${stale.json?.error} revisionBefore=${rev} revisionAfter=${afterStale.json?.revision}`);

  // ---- session scope (only when real session ids are available) -----------
  const sessionIds = opts.sessionIds ?? [];
  if (sessionIds.length >= 2) {
    const [sid, other] = sessionIds;
    const selectSession = selection => api.post({ action: 'select-tool-policy', revision: rev, scope: 'session', sessionId: sid, selection });
    let sessionSelect = await selectSession({ kind: 'preset', presetId: pA.json?.id });
    if (sessionSelect.status === 200) rev = await revision();
    const mine = await api.get(`?sessionId=${encodeURIComponent(sid)}`);
    const theirs = await api.get(`?sessionId=${encodeURIComponent(other)}`);
    record('items 3/5', sessionSelect.status === 200 && mine.json?.sessionToolSelection?.presetId === pA.json?.id ? 'verified' : 'falsified',
      'session-scope preset selection is stored and returned for the current session',
      `status=${sessionSelect.status} selection=${JSON.stringify(mine.json?.sessionToolSelection)}`);
    record('items 5/14', theirs.json?.sessionToolSelection?.presetId !== pA.json?.id ? 'verified' : 'falsified',
      'another session never receives this session\'s selection',
      `other=${other} selection=${JSON.stringify(theirs.json?.sessionToolSelection)}`);
    const customSession = await api.post({ action: 'save-session-tools', revision: rev, sessionId: sid, policy: { [toolName]: false } });
    if (customSession.status === 200) rev = await revision();
    const customState = await api.get(`?sessionId=${encodeURIComponent(sid)}`);
    record('items 1/5', customSession.status === 200 && customState.json?.sessionToolSelection?.kind === 'custom'
      && customState.json?.sessionToolPolicy?.[toolName] === false ? 'verified' : 'falsified',
      'save-session-tools writes a custom session policy',
      `status=${customSession.status} selection=${JSON.stringify(customState.json?.sessionToolSelection)} policy=${JSON.stringify(customState.json?.sessionToolPolicy)}`);
    const inherit = await api.post({ action: 'save-session-tools', revision: rev, sessionId: sid, inherit: true });
    if (inherit.status === 200) rev = await revision();
    const inheritedState = await api.get(`?sessionId=${encodeURIComponent(sid)}`);
    record('items 5/9', inherit.status === 200 && inherit.json?.inherited === true
      && inheritedState.json?.sessionToolSelection === null && inheritedState.json?.sessionToolPolicy === null ? 'verified' : 'falsified',
      'save-session-tools inherit:true clears the session selection and policy',
      `status=${inherit.status} selection=${JSON.stringify(inheritedState.json?.sessionToolSelection)} policy=${JSON.stringify(inheritedState.json?.sessionToolPolicy)}`);
  } else {
    record('items 3/5', 'not-verified', 'session-scope HTTP actions not exercised in this run',
      'no real session ids were available to the driver (pass --session <id>); in-process runtime harness covers session switching');
  }

  // ---- editing a referenced preset ---------------------------------------
  const updateA = await api.post({
    action: 'save-tool-preset', revision: rev, id: pA.json?.id,
    preset: { name: '验证预设A2', description: 'edited', defaultEnabled: true, groupIds: ['verify-g1'], rules: [ruleA, { modeId: modeA, toolName: 'another-tool', enabled: false }] },
  });
  if (updateA.status === 200) rev = await revision();
  const afterUpdate = await api.getState();
  const updated = afterUpdate.json?.toolPresets?.find(p => p.id === pA.json?.id);
  record('item 6', updateA.status === 200 && updateA.json?.id === pA.json?.id && updated?.name === '验证预设A2'
    && afterUpdate.json?.modeToolSelections?.[modeA]?.presetId === pA.json?.id ? 'verified' : 'falsified',
    'editing a referenced preset keeps the same id and all references',
    `status=${updateA.status} name=${updated?.name} ref=${JSON.stringify(afterUpdate.json?.modeToolSelections?.[modeA])}`);

  // ---- legacy save-mode-tools then delete preset --------------------------
  const legacy = await api.post({ action: 'save-mode-tools', revision: rev, modeId: modeA, policy: { [toolName]: false } });
  if (legacy.status === 200) rev = await revision();
  const legacyState = await api.getState();
  record('items 1/9', legacy.status === 200 && legacy.json?.selection?.kind === 'custom'
    && legacyState.json?.modeToolSelections?.[modeA]?.kind === 'custom'
    && legacyState.json?.modeToolPolicies?.[modeA]?.[toolName] === false ? 'verified' : 'falsified',
    'save-mode-tools keeps legacy flat policy and writes mode selection custom',
    `status=${legacy.status} selection=${JSON.stringify(legacyState.json?.modeToolSelections?.[modeA])} policy=${JSON.stringify(legacyState.json?.modeToolPolicies?.[modeA])}`);
  const delB = await api.post({ action: 'delete-tool-preset', revision: rev, id: pB.json?.id });
  if (delB.status === 200) rev = await revision();
  const afterDel = await api.getState();
  record('item 9', delB.status === 200 && !afterDel.json?.toolPresets?.some(p => p.id === pB.json?.id) ? 'verified' : 'falsified',
    'delete-tool-preset removes the preset', `status=${delB.status} result=${JSON.stringify(delB.json)}`);
  record('item 9', afterDel.json?.modeToolSelections?.[modeB]?.kind === 'custom' ? 'verified' : 'falsified',
    'deleting a referenced preset falls back the mode to custom, keeps flat policy',
    `selection=${JSON.stringify(afterDel.json?.modeToolSelections?.[modeB])} policy=${JSON.stringify(afterDel.json?.modeToolPolicies?.[modeB])}`);

  // ---- delete group keeps tool rules -------------------------------------
  const policyBefore = JSON.stringify(afterDel.json?.modeToolPolicies?.[modeA] ?? null);
  const dropGroup = await saveGroups([{ id: 'verify-g2', name: '验证组二', description: '', order: 200, members: [{ modeId: modeB, toolName }] }]);
  if (dropGroup.status === 200) rev = await revision();
  const afterDrop = await api.getState();
  record('item 9', dropGroup.status === 200 && JSON.stringify(afterDrop.json?.modeToolPolicies?.[modeA] ?? null) === policyBefore
    && !afterDrop.json?.toolGroups?.some(g => g.id === 'verify-g1') ? 'verified' : 'falsified',
    'deleting a group removes membership only, tool rules unchanged',
    `status=${dropGroup.status} policyBefore=${policyBefore} policyAfter=${JSON.stringify(afterDrop.json?.modeToolPolicies?.[modeA] ?? null)}`);

  // ---- package import / export -------------------------------------------
  const countsBefore = { groups: afterDrop.json?.toolGroups?.length ?? 0, presets: afterDrop.json?.toolPresets?.length ?? 0 };
  const doc = packageDocument({ name: '验证包一', presetId: 'verify-tp1', groupId: 'verify-tg1', rule: { modeId: modeA, toolName, enabled: false }, unknown: true });
  const imported = await api.post({ action: 'import', revision: rev, document: doc, name: '验证包一' });
  if (imported.status === 200) rev = await revision();
  const afterImport = await api.getState();
  record('items 10/11', imported.status === 200
    && (afterImport.json?.toolGroups?.length ?? 0) === countsBefore.groups
    && (afterImport.json?.toolPresets?.length ?? 0) === countsBefore.presets ? 'verified' : 'falsified',
    'importing a share package does NOT auto-apply its tools section',
    `status=${imported.status} countsBefore=${JSON.stringify(countsBefore)} countsAfter=${afterImport.json?.toolGroups?.length}/${afterImport.json?.toolPresets?.length}`);

  if (imported.status === 200) {
    const dry = await api.post({ action: 'import-package-tools', revision: rev, id: imported.json.id, dryRun: true });
    const afterDry = await api.getState();
    record('item 10', dry.status === 200 && dry.json?.applied === false
      && (afterDry.json?.toolPresets?.length ?? 0) === countsBefore.presets ? 'verified' : 'falsified',
      'import-package-tools dryRun reports a plan and writes nothing',
      `status=${dry.status} applied=${dry.json?.applied} stats=${JSON.stringify(dry.json?.stats)}`);
    const apply = await api.post({ action: 'import-package-tools', revision: rev, id: imported.json.id });
    if (apply.status === 200) rev = await revision();
    const afterApply = await api.getState();
    record('item 10', apply.status === 200 && apply.json?.applied === true
      && afterApply.json?.toolPresets?.some(p => p.id === 'verify-tp1')
      && afterApply.json?.toolGroups?.some(g => g.id === 'verify-tg1') ? 'verified' : 'falsified',
      'explicit import-package-tools applies groups and presets',
      `status=${apply.status} stats=${JSON.stringify(apply.json?.stats)}`);

    // id conflict with different content -> remap + reference rewrite
    const doc2 = packageDocument({ name: '验证包二', presetId: 'verify-tp1', groupId: 'verify-tg1', rule: { modeId: modeA, toolName, enabled: true } });
    const imported2 = await api.post({ action: 'import', revision: rev, document: doc2, name: '验证包二' });
    if (imported2.status === 200) rev = await revision();
    const apply2 = await api.post({ action: 'import-package-tools', revision: rev, id: imported2.json?.id });
    if (apply2.status === 200) rev = await revision();
    const afterApply2 = await api.getState();
    const appliedPreset = apply2.json?.presets?.[0];
    const appliedGroup = apply2.json?.groups?.[0];
    record('item 10', apply2.status === 200 && appliedPreset && appliedPreset.id !== 'verify-tp1'
      && appliedGroup && appliedGroup.id !== 'verify-tg1'
      && appliedPreset.groupIds?.includes(appliedGroup.id)
      && afterApply2.json?.toolPresets?.some(p => p.id === appliedPreset.id)
      && afterApply2.json?.toolGroups?.some(g => g.id === appliedGroup.id) ? 'verified' : 'falsified',
      'conflicting package ids are remapped and in-package references rewritten',
      `applyStatus=${apply2.status} stats=${JSON.stringify(apply2.json?.stats)} presetId=${appliedPreset?.id} oldPresetId=verify-tp1 groupIds=${JSON.stringify(appliedPreset?.groupIds)} groupId=${appliedGroup?.id} oldGroupId=verify-tg1 persisted=${afterApply2.json?.toolPresets?.some(p => p.id === appliedPreset?.id)}/${afterApply2.json?.toolGroups?.some(g => g.id === appliedGroup?.id)}`);

    // unknown tools.version must not be applicable
    const doc3 = packageDocument({ name: '验证包三', presetId: 'verify-tp3', groupId: 'verify-tg3', rule: { modeId: modeA, toolName, enabled: false } });
    doc3.tools.version = 99;
    const imported3 = await api.post({ action: 'import', revision: rev, document: doc3, name: '验证包三' });
    if (imported3.status === 200) rev = await revision();
    const unknownApply = await api.post({ action: 'import-package-tools', revision: rev, id: imported3.json?.id });
    if (unknownApply.status === 200) rev = await revision();
    const afterUnknown = await api.getState();
    record('item 11', unknownApply.status === 400 || unknownApply.json?.applied === false ? 'verified' : 'falsified',
      'unknown tools.version is refused for application',
      `import=${imported3.status} apply=${unknownApply.status} body=${JSON.stringify(unknownApply.json)?.slice(0, 200)}`);
    record('item 11', !afterUnknown.json?.toolPresets?.some(p => p.id === 'verify-tp3') ? 'verified' : 'falsified',
      'unknown-version package tools were not applied', `presets=${JSON.stringify(afterUnknown.json?.toolPresets?.map(p => p.id))}`);

    // export round trip (a fresh preset whose group still exists, so the groupIds rule is observable)
    const expPreset = await api.post({
      action: 'save-tool-preset', revision: rev,
      preset: { name: '导出组验证', description: '', defaultEnabled: true, groupIds: ['verify-g2'], rules: [{ modeId: modeA, toolName, enabled: false }] },
    });
    if (expPreset.status === 200) rev = await revision();
    const exported = await api.post({
      action: 'export-package', revision: rev, id: imported.json.id, name: '验证导出',
      preset: sillyTavernPreset('export'), toolPresetId: expPreset.json?.id,
    });
    const tools = exported.json?.tools;
    const forbidden = tools ? Object.keys(tools).filter(key => ['selection', 'sessionId', 'refCounts', 'toolCatalogs'].includes(key)) : [];
    record('item 11', exported.status === 200 && tools?.version === 1
      && tools?.presets?.[0]?.id === expPreset.json?.id
      && tools?.groups?.some(group => group.id === 'verify-g2')
      && forbidden.length === 0
      && exported.json?.verifyUnknown?.keep === true ? 'verified' : 'falsified',
      'export-package emits tools.version 1 with the selected preset and its referenced groups, preserves unknown outer fields, exports no selection/session state',
      `status=${exported.status} toolsVersion=${tools?.version} presetIds=${JSON.stringify(tools?.presets?.map(p => p.id))} expectedPreset=${expPreset.json?.id} groups=${JSON.stringify(tools?.groups?.map(g => g.id))} expectedGroup=verify-g2 forbidden=[${forbidden.join(',')}] unknownOuter=${exported.json?.verifyUnknown?.keep}`);
    const reexport = await api.post({ action: 'export-package', revision: rev, id: imported.json.id, name: '验证导出' });
    record('item 11', reexport.status === 200 && reexport.json?.tools?.presets?.[0]?.id === 'verify-tp1' ? 'verified' : 'falsified',
      'package without an explicit toolPresetId keeps its stored tools section (round trip)',
      `status=${reexport.status} toolPresetId=${reexport.json?.tools?.presets?.[0]?.id}`);
    const ghostExport = await api.post({ action: 'export-package', revision: rev, id: imported.json.id, name: '失配导出', toolPresetId: ghost.json?.id });
    const ghostRules = ghostExport.json?.tools?.presets?.[0]?.rules ?? [];
    record('item 11', ghostExport.status === 200 && ghostRules.some(rule => rule.modeId === 'missing-mode-xyz' && rule.toolName === 'ghost-tool') ? 'verified' : 'falsified',
      'unmatched tool refs are exported as-is',
      `status=${ghostExport.status} presetId=${ghostExport.json?.tools?.presets?.[0]?.id} rules=${JSON.stringify(ghostRules)}`);

    const noTools = await api.post({ action: 'import', revision: rev, document: { format: 'dsh-preset-enhance', version: 1, metadata: { name: '无工具' }, preset: { format: 'sillytavern', data: sillyTavernPreset('no-tools') } }, name: '无工具' });
    if (noTools.status === 200) rev = await revision();
    const noToolsApply = await api.post({ action: 'import-package-tools', revision: rev, id: noTools.json?.id });
    record('item 11', noTools.status === 200 && noToolsApply.status === 400 ? 'verified' : 'falsified',
      'packages without a tools section still import; applying them is refused',
      `import=${noTools.status} apply=${noToolsApply.status} error=${noToolsApply.json?.error}`);
  }

  // ---- server-side state file cross-check ---------------------------------
  if (fs.existsSync(SLOT_STATE)) {
    const raw = fs.readFileSync(SLOT_STATE, 'utf8');
    record('item 14', !raw.includes('"hacked"') && !raw.includes('__proto__') ? 'verified' : 'falsified',
      'server state.json contains no prototype-key residue',
      `file=${SLOT_STATE} bytes=${raw.length} hasProtoKey=${raw.includes('__proto__')}`);
  } else {
    record('item 14', 'not-verified', 'server state.json not readable for cross-check', `path=${SLOT_STATE}`);
  }

  // ---- serve checks -------------------------------------------------------
  for (const [asset, label] of [['/preset-enhance', 'index'], ['/preset-enhance/editor.js', 'editor.js'], ['/preset-enhance/editor.css', 'editor.css']]) {
    const response = await api.request('GET', asset);
    record('items 7/12', response.status === 200 ? 'verified' : 'falsified', `${asset} serves 200`, `status=${response.status} bytes=${response.text.length}`);
    if (response.status === 200) {
      const missing = UI_MARKERS.filter(marker => {
        const target = marker.file === 'index.html' ? (label === 'index' ? response.text : undefined) : (label === 'editor.js' ? response.text : undefined);
        return target !== undefined && !marker.re.test(target);
      });
      if (missing.length > 0) {
        record('items 7/12', 'falsified', `UI markers missing from ${asset}`, `missing=[${missing.map(m => m.id).join(',')}]`);
      } else if (label === 'index' || label === 'editor.js') {
        record('items 7/12', 'verified', `UI markers present in ${asset}`, `checked=${UI_MARKERS.filter(m => m.file === (label === 'index' ? 'index.html' : 'editor.js')).length}`);
      }
    }
  }
  record('items 7/12', 'not-verified', 'interactive UI behaviour (tri-state, keyboard, collapse, mobile select) not exercised',
    'no browser/DOM in this driver; only static markers above are checked');
}

// ---------------------------------------------------------------------------
// in-process runtime harness on real DSH packages
// ---------------------------------------------------------------------------
async function loadDsh(name) {
  const file = path.join(APP_NM, '@deepseek-ai', name, 'lib/index.js');
  return import(pathToFileURL(file).href);
}

async function mcpChecks() {
  const sdkRoot = path.join(APP_NM, '@modelcontextprotocol', 'sdk');
  const fixture = path.join(REPO, 'scripts', 'fixtures', 'mcp-stdio-server.mjs');
  let ctx;
  try {
    const { Context } = await loadDsh('cordis');
    ctx = new Context();
    const packages = [
      ['dsh-llm', {}],
      ['dsh-session', {}],
      ['dsh-session-projection', {}],
      ['dsh-system-prompt', {}],
      ['dsh-tools', {}],
      ['dsh-agent', {}],
      ['dsh-agent-loop', { agents: [] }],
    ];
    for (const [name, config] of packages) {
      await ctx.plugin((await loadDsh(name)).default, config);
    }

    const mcp = await loadDsh('dsh-mcp-client');
    const servers = [
      { serverName: 'fixture_alpha', marker: 'ALPHA' },
      { serverName: 'fixture_beta', marker: 'BETA' },
    ];
    for (const server of servers) {
      await mcp.apply(ctx, {
        transport: 'stdio',
        serverName: server.serverName,
        command: process.execPath,
        args: [fixture, sdkRoot, server.serverName, server.marker],
        env: {},
        cwd: REPO,
        toolCallTimeoutMs: 5_000,
        failOnStartupError: true,
        reconnect: { enabled: false },
      });
    }

    const schemas = ctx.tools.schemas();
    for (let index = 0; index < servers.length; index += 1) {
      const server = servers[index];
      const publicName = `mcp__${server.serverName}__echo`;
      const result = await ctx.tools.execute({
        callId: `mcp-fixture-${index + 1}`,
        name: publicName,
        arguments: { text: `request-${index + 1}` },
        signal: new AbortController().signal,
      });
      const textContent = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
      const expected = `${server.marker}:request-${index + 1}`;
      record(
        `mcp-${index + 1}`,
        schemas.some(tool => tool.name === publicName) && !result.isError && textContent.includes(expected) ? 'verified' : 'falsified',
        `MCP stdio service ${index + 1} is discovered and callable through DSH`,
        `tool=${publicName} expected=${expected} result=${JSON.stringify(result)}`,
      );
    }

    const { mcpToolGroups } = await import(pathToFileURL(path.join(REPO, 'index.mjs')).href);
    const groups = mcpToolGroups({ standard: schemas }).standard ?? [];
    const grouped = servers.every(server => groups.some(group =>
      group.serverName === server.serverName
      && group.tools.includes(`mcp__${server.serverName}__echo`)));
    record(
      'mcp-groups',
      grouped && groups.length === 2 ? 'verified' : 'falsified',
      'live tools from two MCP services become separate workbench groups',
      `groups=${JSON.stringify(groups)}`,
    );
  } catch (error) {
    record('mcp-runtime', 'falsified', 'dual MCP integration test crashed', String(error?.stack ?? error));
  } finally {
    if (ctx) {
      try { await ctx.fiber.dispose(); } catch (error) {
        record('mcp-dispose', 'falsified', 'dual MCP integration context did not dispose cleanly', String(error?.stack ?? error));
      }
    }
  }
}
function writeState(file, mutate) {
  const text = fs.readFileSync(file, 'utf8');
  const state = JSON.parse(text);
  mutate(state);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
function baseState() {
  return {
    version: 1,
    revision: 100,
    presets: [],
    defaultPresetId: null,
    selectedPresetId: null,
    bindings: {},
    sessions: {},
    modeToolPolicies: {},
    sessionToolPolicies: {},
    toolGroups: [],
    toolPresets: [],
    modeToolSelections: {},
    sessionToolSelections: {},
    toolCatalogs: {},
    autoEnableModes: ['st-preset'],
    autoEnableSince: { 'st-preset': 0 },
    deepseekBetaPrefix: false,
    postToolPrefixMode: 'inherit',
    postToolPrefixText: '',
    prefixToolCalls: false,
    prefixNonOfficialRemoveTools: true,
    global: {},
  };
}

async function runtimeChecks() {
  const dir = path.join(MIRROR, 'runtime');
  ensureDir(dir);
  const stateFile = path.join(dir, 'state.json');
  const agents = ['verify_alpha', 'verify_beta'];
  let ctx;
  try {
    const { Context } = await loadDsh('cordis');
    const llm = await loadDsh('dsh-llm');
    ctx = new Context();
    const loaded = [];
    const packages = [['dsh-llm', {}], ['dsh-session', {}], ['dsh-session-projection', {}], ['dsh-system-prompt', {}], ['dsh-tools', {}], ['dsh-agent', {}], ['dsh-agent-loop', { agents: [] }]];
    for (const [name, config] of packages) {
      try {
        const mod = await loadDsh(name);
        await ctx.plugin(mod.default, config);
        loaded.push(name);
      } catch (error) {
        record('runtime-load', 'blocked', `could not load real ${name}`, String(error?.message ?? error));
      }
    }
    record('runtime-load', loaded.length === packages.length ? 'verified' : 'blocked', 'real DSH packages loaded into a real cordis Context', `loaded=[${loaded.join(',')}]`);
    if (!ctx.tools || !ctx.sessions || !ctx.llm) throw new Error('core services missing after load');

    const bodies = [];
    const callIds = [];
    const toolDef = name => ({
      name,
      description: `${name} verification tool`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() { bodies.push(name); return 'ok'; },
    });
    for (const name of agents) ctx.tools.register(toolDef(name));
    const registered = ctx.tools.schemas().map(s => s.name);
    record('item 4', agents.every(name => registered.includes(name)) ? 'verified' : 'falsified',
      'real tool registry exposes the verification tools', `schemas=[${registered.slice(0, 12).join(',')}]`);

    const workDir = ensureDir(path.join(dir, 'work'));
    const sessions = {};
    for (const [id, modeId] of [['verify-standard', 'standard'], ['verify-minimal', 'minimal'], ['verify-switch', 'standard']]) {
      sessions[id] = ctx.sessions.create(id, { meta: { cwd: workDir, agentPreset: modeId } });
    }
    record('runtime-sessions', sessions['verify-standard'].header?.agentPreset === 'standard' ? 'verified' : 'falsified',
      'real sessions created with distinct agent presets',
      Object.entries(sessions).map(([id, s]) => `${id}=${s.header?.agentPreset}`).join(' '));

    fs.writeFileSync(stateFile, JSON.stringify(baseState(), null, 2));
    const { apply, AGENT_PRESET_ID } = await import(pathToFileURL(path.join(REPO, 'index.mjs')).href);
    const facade = {
      on: ctx.on.bind(ctx),
      effect: ctx.effect.bind(ctx),
      llm: ctx.llm,
      sessions: ctx.sessions,
      tools: ctx.tools,
      agents: ctx.agents,
      webServer: { register: () => () => {} },
      commands: { register: () => () => {} },
    };
    await apply(facade, { dataFile: stateFile, agentPresetRoot: path.join(dir, '.agent-presets') });
    record('runtime-apply', 'info', 'plugin apply() attached to the real cordis Context and real tool registry',
      `agentPresetId=${AGENT_PRESET_ID} guardsRegistered=${typeof ctx.tools.guard === 'function'}`);

    const calls = [];
    class Adapter extends llm.LlmAdapter {
      async *stream(options) {
        calls.push(structuredClone({ tools: (options.tools ?? []).map(t => t.name), sessionId: options.sessionId, messages: options.messages?.length ?? 0 }));
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'OK' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['mock'], new Adapter());

    const request = async sessionId => {
      const before = calls.length;
      const schemas = ctx.tools.schemas(sessions[sessionId]);
      const stream = ctx.llm.stream({
        provider: 'mock', model: 'mock', sessionId,
        messages: [llm.createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
        tools: schemas,
      });
      for await (const _chunk of stream) { /* drain */ }
      if (calls.length === before) throw new Error('adapter was never reached for ' + sessionId);
      return calls.at(-1);
    };

    // baseline: no preset selected -> legacy behaviour, every tool visible
    const baseline = await request('verify-standard');
    record('item 1', baseline.tools.includes('verify_alpha') && baseline.tools.includes('verify_beta') ? 'verified' : 'falsified',
      'legacy state (no selection) keeps every tool in the request schema', `tools=[${baseline.tools.join(',')}]`);

    const setState = mutate => writeState(stateFile, mutate);
    setState(state => {
      state.toolGroups = [{ id: 'g1', name: 'g1', description: '', order: 1, members: [{ modeId: 'standard', toolName: 'verify_beta' }] }];
      state.toolPresets = [{ id: 'p-readonly', name: 'p-readonly', description: '', defaultEnabled: true, groupIds: ['g1'], rules: [{ modeId: 'standard', toolName: 'verify_beta', enabled: false }], updatedAt: '2026-01-01T00:00:00.000Z' }];
      state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p-readonly' } };
    });
    const presetRequest = await request('verify-standard');
    record('item 4', !presetRequest.tools.includes('verify_beta') && presetRequest.tools.includes('verify_alpha') ? 'verified' : 'falsified',
      'mode preset removes the disabled tool from the request schema',
      `tools=[${presetRequest.tools.join(',')}]`);
    const otherMode = await request('verify-minimal');
    record('item 2', otherMode.tools.includes('verify_beta') ? 'verified' : 'falsified',
      'a rule keyed {modeId:standard} does not leak into another mode',
      `minimal tools=[${otherMode.tools.join(',')}]`);

    // defaultEnabled=false + explicit enable
    setState(state => {
      state.toolPresets.push({ id: 'p-none', name: 'p-none', description: '', defaultEnabled: false, groupIds: [], rules: [{ modeId: 'minimal', toolName: 'verify_alpha', enabled: true }], updatedAt: '2026-01-01T00:00:00.000Z' });
      state.modeToolSelections = { minimal: { kind: 'preset', presetId: 'p-none' } };
    });
    const noneRequest = await request('verify-minimal');
    record('item 3', noneRequest.tools.includes('verify_alpha') && !noneRequest.tools.includes('verify_beta') ? 'verified' : 'falsified',
      'defaultEnabled=false excludes unlisted tools; an explicit rule re-enables one',
      `tools=[${noneRequest.tools.join(',')}]`);

    // catalog tool added later picks up defaultEnabled
    ctx.tools.register(toolDef('verify_gamma'));
    setState(state => {
      state.toolPresets.push({ id: 'p-late', name: 'p-late', description: '', defaultEnabled: true, groupIds: [], rules: [{ modeId: 'standard', toolName: 'verify_beta', enabled: false }], updatedAt: '2026-01-01T00:00:00.000Z' });
      state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p-late' } };
    });
    const lateRequest = await request('verify-standard');
    record('item 3', lateRequest.tools.includes('verify_gamma') && !lateRequest.tools.includes('verify_beta') ? 'verified' : 'falsified',
      'a catalog tool registered after the preset picks up defaultEnabled',
      `tools=[${lateRequest.tools.join(',')}]`);

    // unmatched rule rematches once the tool actually appears (item 8)
    setState(state => {
      state.toolPresets.push({ id: 'p-rematch', name: 'p-rematch', description: '', defaultEnabled: true, groupIds: [], rules: [{ modeId: 'standard', toolName: 'verify_late', enabled: false }], updatedAt: '2026-01-01T00:00:00.000Z' });
      state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p-rematch' } };
    });
    const beforeLate = await request('verify-standard');
    ctx.tools.register(toolDef('verify_late'));
    const afterLate = await request('verify-standard');
    setState(state => { state.modeToolSelections = { standard: { kind: 'custom' } }; state.modeToolPolicies = { standard: {} }; });
    const controlLate = await request('verify-standard');
    record('item 8', !afterLate.tools.includes('verify_late') && controlLate.tools.includes('verify_late') && afterLate.tools.includes('verify_alpha') ? 'verified' : 'falsified',
      'an unmatched rule saved for a missing tool takes effect once the tool appears (rematch, with control)',
      `rule={standard/verify_late:false} beforeRegistration=[${beforeLate.tools.join(',')}] withRule=[${afterLate.tools.join(',')}] controlNoRule=[${controlLate.tools.join(',')}]`);

    // guard parity
    setState(state => { state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p-readonly' } }; });
    await request('verify-standard'); // refresh the policy snapshot the guard closes over
    let agent;
    let guardTargetLabel = 'session-probe(standard)';
    try {
      agent = await ctx.agentLoop.create('verify-agent', { provider: 'mock', model: 'mock', cwd: workDir }, { agentPreset: 'standard' });
      guardTargetLabel = `agentLoop(${agent.session?.header?.agentPreset})`;
    } catch (error) {
      record('item 4', 'blocked', 'real agentLoop.create failed; falling back to a session-scoped guard probe', String(error?.message ?? error));
    }
    const guardTarget = agent ?? { session: sessions['verify-standard'] };
    bodies.length = 0;
    const denied = await ctx.tools.execute({ callId: 'verify-call-1', name: 'verify_beta', arguments: {}, agent: guardTarget, signal: new AbortController().signal });
    const deniedText = JSON.stringify(denied);
    record('item 4', denied?.isError === true && /关闭/.test(deniedText) && bodies.length === 0 ? 'verified' : 'falsified',
      'execution guard rejects a tool disabled by the active mode preset',
      `target=${guardTargetLabel} isError=${denied?.isError} bodyRan=${bodies.length} result=${deniedText.slice(0, 300)}`);
    bodies.length = 0;
    const allowed = await ctx.tools.execute({ callId: 'verify-call-2', name: 'verify_alpha', arguments: {}, agent: guardTarget, signal: new AbortController().signal });
    record('item 4', allowed?.isError !== true && bodies.length === 1 && bodies[0] === 'verify_alpha' ? 'verified' : 'falsified',
      'an enabled tool still executes through the real registry',
      `target=${guardTargetLabel} isError=${allowed?.isError} bodyRan=[${bodies.join(',')}]`);

    // session switching: inherit -> custom -> presetA -> presetB
    const switchSession = 'verify-switch';
    const observed = [];
    const setSwitch = (mutate) => setState(state => {
      state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p-readonly' } };
      state.sessionToolSelections = {};
      state.sessionToolPolicies = {};
      state.toolPresets = state.toolPresets.filter(p => !['p-switch-a', 'p-switch-b'].includes(p.id));
      state.toolPresets.push(
        { id: 'p-switch-a', name: 'A', description: '', defaultEnabled: true, groupIds: [], rules: [{ modeId: 'standard', toolName: 'verify_alpha', enabled: false }], updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'p-switch-b', name: 'B', description: '', defaultEnabled: false, groupIds: [], rules: [{ modeId: 'standard', toolName: 'verify_gamma', enabled: true }], updatedAt: '2026-01-01T00:00:00.000Z' },
      );
      mutate(state);
    });
    setSwitch(state => { state.sessionToolSelections[switchSession] = { kind: 'inherit' }; });
    observed.push(['inherit', (await request(switchSession)).tools]);
    setSwitch(state => {
      state.sessionToolSelections[switchSession] = { kind: 'custom' };
      state.sessionToolPolicies[switchSession] = { verify_alpha: false };
    });
    observed.push(['custom', (await request(switchSession)).tools]);
    setSwitch(state => { state.sessionToolSelections[switchSession] = { kind: 'preset', presetId: 'p-switch-a' }; });
    observed.push(['presetA', (await request(switchSession)).tools]);
    setSwitch(state => { state.sessionToolSelections[switchSession] = { kind: 'preset', presetId: 'p-switch-b' }; });
    observed.push(['presetB', (await request(switchSession)).tools]);
    const asMap = Object.fromEntries(observed);
    const switching = !asMap.inherit.includes('verify_beta') && asMap.inherit.includes('verify_alpha')
      && !asMap.custom.includes('verify_alpha') && asMap.custom.includes('verify_beta')
      && !asMap.presetA.includes('verify_alpha') && asMap.presetA.includes('verify_beta')
      && !asMap.presetB.includes('verify_alpha') && !asMap.presetB.includes('verify_beta') && asMap.presetB.includes('verify_gamma');
    record('item 5', switching ? 'verified' : 'falsified',
      'session switching inherit -> custom -> presetA -> presetB changes the next request',
      observed.map(([k, v]) => `${k}=[${v.join(',')}]`).join(' | '));

    // multi-reference update
    setState(state => {
      state.toolPresets = [{ id: 'p-shared', name: 'shared', description: '', defaultEnabled: true, groupIds: [], rules: [], updatedAt: '2026-01-01T00:00:00.000Z' }];
      state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p-shared' }, minimal: { kind: 'preset', presetId: 'p-shared' } };
      state.sessionToolSelections = {};
      state.sessionToolPolicies = {};
    });
    const beforeA = await request('verify-standard');
    const beforeB = await request('verify-minimal');
    setState(state => { state.toolPresets[0].rules = [{ modeId: 'standard', toolName: 'verify_gamma', enabled: false }, { modeId: 'minimal', toolName: 'verify_alpha', enabled: false }]; });
    const afterA = await request('verify-standard');
    const afterB = await request('verify-minimal');
    record('item 6', afterA.tools.includes('verify_gamma') === false && beforeA.tools.includes('verify_gamma') === true
      && afterB.tools.includes('verify_alpha') === false && beforeB.tools.includes('verify_alpha') === true ? 'verified' : 'falsified',
      'editing a preset referenced by two modes updates both next requests',
      `A ${beforeA.tools.join(',')} -> ${afterA.tools.join(',')} | B ${beforeB.tools.join(',')} -> ${afterB.tools.join(',')}`);

    // dangling preset selection falls back safely
    setState(state => {
      state.modeToolSelections = { standard: { kind: 'preset', presetId: 'p-gone' } };
      state.modeToolPolicies = { standard: { verify_alpha: false } };
      state.toolPresets = [];
      state.sessionToolSelections = {};
      state.sessionToolPolicies = {};
    });
    const dangling = await request('verify-standard');
    record('item 9/14', dangling.tools.includes('verify_alpha') === false && dangling.tools.includes('verify_beta') ? 'verified' : 'falsified',
      'dangling preset selection falls back to the mode flat policy (no accidental tool widening)',
      `tools=[${dangling.tools.join(',')}] expectedFlatPolicy=alpha:false,beta:undefined,gamma:undefined`);

    if (agent) await agent[Symbol.asyncDispose]?.();
  } catch (error) {
    record('runtime', 'blocked', 'runtime harness aborted', `${error?.stack ?? error}`);
  } finally {
    try { await ctx?.fiber?.dispose?.(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// in-process HTTP harness (driver self-test; real handlers, real HTTP)
// ---------------------------------------------------------------------------
/**
 * Serve the REAL plugin handlers from an in-process cordis Context over real
 * HTTP. This is not the sandbox web profile (no launch token, no web bundle),
 * but it exercises the HTTP driver end-to-end so it is trustworthy the first
 * time it runs against the frozen slot.
 */
async function localHttpChecks() {
  const dir = ensureDir(path.join(MIRROR, 'http'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(baseState(), null, 2));
  let ctx;
  let server;
  try {
    const { Context } = await loadDsh('cordis');
    ctx = new Context();
    for (const [name, config] of [['dsh-llm', {}], ['dsh-session', {}], ['dsh-session-projection', {}], ['dsh-system-prompt', {}], ['dsh-tools', {}], ['dsh-agent', {}], ['dsh-agent-loop', { agents: [] }]]) {
      await ctx.plugin((await loadDsh(name)).default, config);
    }
    for (const name of ['verify_alpha', 'verify_beta']) {
      ctx.tools.register({
        name,
        description: `${name} verification tool`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
        async execute() { return 'ok'; },
      });
    }
    const workDir = ensureDir(path.join(dir, 'work'));
    const sessionIds = ['verify-standard', 'verify-minimal'].map((id, index) =>
      ctx.sessions.create(id, { meta: { cwd: workDir, agentPreset: index === 0 ? 'standard' : 'minimal' } }).id);
    const routes = new Map();
    const webServer = { register(entry) { routes.set(entry.path, entry.handler); return () => routes.delete(entry.path); } };
    const agentPresets = {
      list: async () => [{ id: 'standard', name: 'standard' }, { id: 'minimal', name: 'minimal' }, { id: 'st-preset', name: '预设模式' }],
      standingKeyFor: async () => undefined,
      readDocument: async () => ({ id: 'standard', content: '' }),
    };
    const { apply } = await import(pathToFileURL(path.join(REPO, 'index.mjs')).href);
    await apply({
      on: ctx.on.bind(ctx), effect: ctx.effect.bind(ctx), llm: ctx.llm, sessions: ctx.sessions,
      tools: ctx.tools, agents: ctx.agents, webServer, commands: { register: () => () => {} }, agentPresets,
    }, { dataFile: stateFile, agentPresetRoot: path.join(dir, '.agent-presets') });
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const handler = routes.get(url.pathname);
      if (!handler) { res.writeHead(404); res.end('not found'); return; }
      Promise.resolve(handler(req, res)).catch(error => {
        try { res.writeHead(500); res.end(String(error?.message ?? error)); } catch {}
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    record('selftest-http', 'info', 'in-process server for the REAL plugin handlers is up',
      `port=${port} routes=[${[...routes.keys()].join(',')}]`);
    record('selftest-http', 'info', 'this run is a DRIVER SELF-TEST, not sandbox verification',
      'real handler code, real cordis Context, but stub agentPresets and no web profile/auth layer');
    await apiChecks(new ApiClient(`http://127.0.0.1:${port}`), { sessionIds });
  } catch (error) {
    record('selftest-http', 'blocked', 'in-process HTTP harness failed', `${error?.stack ?? error}`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try { await ctx?.fiber?.dispose?.(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}
async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => reject(new Error(`port ${port} unavailable: ${error.code}`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

async function main() {
  ensureDir(TEMP_ROOT);
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help') {
    console.log('usage: sandbox-verify.mjs <baseline|diff|api|runtime|all> [options]');
    return;
  }
  const baselineFile = path.join(TEMP_ROOT, 'host-baseline-tools.json');
  if (['api', 'runtime', 'all', 'revision'].includes(command)) revisionChecks();
  if (command === 'revision') { finish('revision'); return; }

  if (command === 'baseline') {
    const out = arg('--out', baselineFile);
    const info = captureHostBaseline(out);
    record('host-baseline', 'info', 'host file inventory captured', `file=${info.file} sha256=${info.sha256}`);
    for (const root of info.roots) record('host-baseline', 'info', `root ${root.id}`, JSON.stringify(root));
    finish('baseline');
    return;
  }

  if (command === 'diff') {
    const before = arg('--before', baselineFile);
    const after = arg('--after', path.join(TEMP_ROOT, 'host-after-tools.json'));
    const compareOnly = process.argv.includes('--compare-only');
    if (!compareOnly || !fs.existsSync(after)) {
      const info = captureHostBaseline(after);
      record('host-safety', 'info', 'host inventory captured', `file=${info.file} sha256=${info.sha256}`);
    }
    const diff = diffBaseline(before, after);
    const installCritical = diff.critical.filter(entry => entry.root === 'dsh-install');
    const homeCritical = diff.critical.filter(entry => entry.root !== 'dsh-install');
    record('host-safety', installCritical.length === 0 ? 'verified' : 'falsified',
      'host dsh installation directory identical (path+size+mtime)',
      `files=${diff.after.roots.find(root => root.id === 'dsh-install')?.files} changes=${JSON.stringify(diff.byTopLevel['dsh-install'] ?? {})}`,
      installCritical);
    record('host-safety', homeCritical.length === 0 ? 'verified' : 'falsified',
      'host DSH_HOME plugin/profile/config surfaces untouched',
      `critical=[${homeCritical.map(entry => `${entry.top}:${entry.added}+${entry.removed}~${entry.changed}`).join(',')}]`,
      homeCritical);
    record('host-safety', 'info', 'raw DSH_HOME churn (the live host dsh process writes its own session caches while the verification runs)',
      `added=${diff.added} removed=${diff.removed} changed=${diff.changed} byTop=${JSON.stringify(diff.byTopLevel['dsh-home'] ?? {})}`, diff);
    finish('diff');
    process.exitCode = installCritical.length === 0 && homeCritical.length === 0 ? 0 : 1;
    return;
  }

  if (command === 'api' || command === 'all') {
    const url = arg('--url');
    if (!url) throw new Error('api mode needs --url <token-or-base-url>');
    const sessionIds = process.argv.filter((value, index) => process.argv[index - 1] === '--session');
    const api = await attach(url);
    record('attach', 'info', 'attached to the live sandbox web instance', `base=${api.base} cookie=${api.cookie ? 'yes' : 'no'}`);
    const root = await api.request('GET', '/');
    record('serve', root.status === 200 && /<!doctype html|<html/i.test(root.text) ? 'verified' : 'falsified',
      'sandbox web shell responds 200 HTML', `status=${root.status}`);
    await apiChecks(api, { sessionIds });
  }
  if (command === 'runtime' || command === 'all') {
    await runtimeChecks();
  }
  if (command === 'mcp' || command === 'all') {
    await mcpChecks();
  }
  if (command === 'selftest-http') {
    await localHttpChecks();
  }

  const report = finish(command);
  const failed = results.filter(r => r.verdict === 'falsified');
  const blocked = results.filter(r => r.verdict === 'blocked');
  say(`falsified=${failed.length} blocked=${blocked.length} report=${report}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(`DRIVER ERROR: ${error?.stack ?? error}`);
  try { finish('driver-error'); } catch {}
  process.exitCode = 2;
});
