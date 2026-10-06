// verify_loader.mjs —— 用 DSH 自带的真实加载器读一份会话日志，并折一次 subagentCatalog 投影。
//
// 为什么需要它：本工具改的是会话日志与投影缓存，而「改完能不能加载、条目是否真的消失」
// 只有 DSH 自己的解析/校验代码说了算。用 Electron 当 Node 跑，就能在无界面、不影响正在运行的
// 应用的前提下先验证一遍，通过后再写入真实文件。
//
// 用法（由 clean.mjs 自动调用；也可手工跑）：
//   桌面版（Electron 当 Node）：
//     set ELECTRON_RUN_AS_NODE=1            # macOS/Linux: export ELECTRON_RUN_AS_NODE=1
//     "<DSH 可执行文件>" verify_loader.mjs --asar "<...>/resources/app.asar" --root "<DSH_HOME>/sessions" \
//         --dir "<root>/<项目目录>/<session-id>"
//   纯 Node（CLI 安装，无桌面版）：
//     node verify_loader.mjs --modules "<含 @deepseek-ai 的 node_modules 目录>" --root ... --dir ...
//
// 参数与默认值：
//   --asar <path>       app.asar；不传则依次尝试 process.resourcesPath、DSH_APP_ASAR、
//                       DSH_APP_EXE/DSH_APP_DIR 推导，再按平台扫描常见安装位置
//   --modules <dir>     含 @deepseek-ai/* 的 node_modules 目录（或无桌面版时的唯一途径）
//   --root <dir>        DSH_HOME/sessions（默认 $DSH_HOME/sessions，再默认 ~/.dsh/sessions）
//   --dir <dir|相对路径> 会话目录（或相对 --root 的 项目目录/session-id）
//   --log <name>        日志文件名，默认 session.v4.jsonl.zstd
// 也接受位置参数：verify_loader.mjs <root> <项目目录>/<session-id>
//
// 退出码：0 = 加载成功且投影条目为 0；1 = 加载失败；2 = 加载成功但投影仍有个条目（或参数错误）。
//
// 输出的关键行（clean.mjs 会解析这两行）：
//   RESULT: OK
//   PROJECTION entries=N
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = { root: undefined, dir: undefined, asar: undefined, modules: undefined, logName: 'session.v4.jsonl.zstd' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asar') out.asar = argv[++i];
    else if (a === '--modules') out.modules = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--log') out.logName = argv[++i];
    else if (out.root === undefined) out.root = a;
    else if (out.dir === undefined) out.dir = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const root = path.resolve(args.root ?? path.join(dshHome, 'sessions'));
let dir = args.dir;
if (dir && !path.isAbsolute(dir)) dir = path.join(root, dir);
if (!dir) {
  console.log('RESULT: FAIL 参数错误：需要 --root 与 --dir（或两个位置参数）');
  process.exit(2);
}
dir = path.resolve(dir);
const sessionId = path.basename(dir);
const file = path.join(dir, args.logName);

/** 在候选目录里找 app.asar。 */
function findAsar() {
  if (args.asar) return args.asar;
  if (process.env.DSH_APP_ASAR) return process.env.DSH_APP_ASAR;
  const cands = [];
  const add = (p) => { if (p) cands.push(p); };
  // Electron 以 Node 方式运行时会给出 resourcesPath —— 最可靠的一条。
  if (process.resourcesPath) add(path.join(process.resourcesPath, 'app.asar'));
  if (process.env.DSH_APP_EXE) add(path.join(path.dirname(process.env.DSH_APP_EXE), '..', 'resources', 'app.asar'));
  if (process.env.DSH_APP_DIR) add(path.join(process.env.DSH_APP_DIR, 'resources', 'app.asar'));
  const scan = (base, fn) => { try { for (const e of fs.readdirSync(base, { withFileTypes: true })) fn(e, base); } catch { /* 忽略 */ } };
  if (process.platform === 'win32') {
    for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.APPDATA]) {
      if (!base) continue;
      add(path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'));
      scan(path.join(base, 'Programs'), (e, b) => { if (e.isDirectory()) add(path.join(b, e.name, 'resources', 'app.asar')); });
      scan(base, (e, b) => { if (e.isDirectory() && /deepseek|harness/i.test(e.name)) add(path.join(b, e.name, 'resources', 'app.asar')); });
    }
  } else if (process.platform === 'darwin') {
    add('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar');
    for (const base of ['/Applications', path.join(homedir(), 'Applications')]) {
      scan(base, (e, b) => {
        if (!e.name.endsWith('.app')) return;
        if (/deepseek|harness/i.test(e.name) || e.name === 'DeepSeek Harness.app') add(path.join(b, e.name, 'Contents', 'Resources', 'app.asar'));
      });
    }
  } else {
    add('/opt/DeepSeek Harness/resources/app.asar');
    for (const base of ['/opt', '/usr/lib', '/usr/local/lib', '/usr/share', path.join(homedir(), '.local', 'share'), path.join(homedir(), 'Applications')]) {
      scan(base, (e, b) => { if (/deepseek|harness/i.test(e.name)) add(path.join(b, e.name, 'resources', 'app.asar')); });
    }
  }
  for (const p of cands) if (fs.existsSync(p)) return p;
  return undefined;
}

/** 定位 @deepseek-ai 目录：--modules/DSH_MODULES 可给 node_modules 本身，也可直接给 @deepseek-ai。 */
function findMods() {
  const cands = [];
  if (args.modules) cands.push(args.modules);
  if (process.env.DSH_MODULES) cands.push(process.env.DSH_MODULES);
  const asar = findAsar();
  if (asar) cands.push(path.join(asar, 'dsh', 'node_modules', '@deepseek-ai'));
  for (const given of cands) {
    if (fs.existsSync(path.join(given, '@deepseek-ai', 'dsh-session-persistence-jsonl'))) return path.join(given, '@deepseek-ai');
    if (fs.existsSync(path.join(given, 'dsh-session-persistence-jsonl'))) return given;
  }
  return cands.length ? cands[cands.length - 1] : undefined;
}

const asar = findAsar();
const MODS = findMods();
if (!MODS || !fs.existsSync(MODS)) {
  console.log('RESULT: FAIL 找不到 @deepseek-ai 包（可用 --asar 指定 app.asar，或 --modules 指定 node_modules）');
  process.exit(2);
}
if (!fs.existsSync(file)) { console.log(`RESULT: FAIL 日志不存在: ${file}`); process.exit(2); }

const mod = (rel) => pathToFileURL(path.join(MODS, rel)).href;
const lines = [`FILE ${file} (${fs.statSync(file).size} bytes)`, `ASAR ${asar ?? '(未用)'}`, `MODULES ${MODS}`, `SESSION ${sessionId}`];
let code = 0;
try {
  const { default: JsonlSessionPersistence } = await import(mod('dsh-session-persistence-jsonl/lib/index.js'));
  const { subagentCatalogProjectionDefinition: def } = await import(mod('dsh-subagent/lib/types/catalog.js'));
  // 伪实例：该类没有 #private 字段，只需要这几个属性即可调用 readStoredLog。
  const inst = Object.create(JsonlSessionPersistence.prototype);
  inst.root = root;
  inst.compression = 'zstd';
  inst.config = { root, compression: 'zstd' };
  inst.coldLogMemo = new Map();
  const stored = await inst.readStoredLog(file, sessionId, undefined);
  const counts = new Map();
  let state = def.init(stored.meta, stored.inheritedEventCount);
  for (const e of stored.events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    state = def.apply(state, e);
  }
  const entries = def.wire.view(state);
  lines.push('RESULT: OK');
  lines.push(`  header.id=${stored.meta.id} inherited=${stored.inheritedEventCount} events=${stored.events.length} torn=${String(stored.tornTruncateTo)}`);
  lines.push(`  subagent/catalog=${counts.get('subagent/catalog') ?? 0} subagent/catalog-dismissed=${counts.get('subagent/catalog-dismissed') ?? 0} delivery=${counts.get('session-log-deepseek/delivery-accepted') ?? 0}`);
  lines.push(`  PROJECTION entries=${entries.length} ${JSON.stringify(entries.slice(0, 2))}`);
  code = entries.length === 0 ? 0 : 2;
} catch (error) {
  lines.push(`RESULT: FAIL ${error?.constructor?.name}: ${String(error?.message)}`);
  let c = error?.cause, d = 0;
  while (c && d < 4) { lines.push(`  cause[${d}] ${c?.constructor?.name}: ${String(c?.message)}`); c = c?.cause; d++; }
  code = 1;
}
console.log(lines.join('\n'));
process.exit(code);
