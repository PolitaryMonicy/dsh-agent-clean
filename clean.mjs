#!/usr/bin/env node
/**
 * dsh-agent-clean —— 清理 DSH 里的子代理条目、会话与孤儿投影缓存（跨平台）
 * Cross-platform cleaner for DSH subagent entries, sessions and orphan projection caches.
 *
 * 需求 / Requirements: Node.js >= 22（内置 zlib 的 zstd）。Windows / macOS / Linux 皆可。
 *   装有 DSH 桌面版时，工具会用**应用自己的加载器**复核结果（最可靠）；
 *   纯 CLI 安装可设 DSH_MODULES 指向含 @deepseek-ai/* 的 node_modules 目录。
 *
 * 环境变量 / Env:
 *   DSH_HOME          DSH 主目录，默认 ~/.dsh
 *   DSH_APP_DIR       桌面应用目录（其下有 resources/app.asar）
 *   DSH_APP_EXE       Electron 可执行文件；DSH_APP_ASAR 直接给 app.asar 路径
 *   DSH_MODULES       含 @deepseek-ai/dsh-session-persistence-jsonl 的 node_modules 目录
 *   DSAC_BACKUP_DIR   备份目录，默认 <工具目录>/backups
 *
 * 命令 / Commands（默认皆为「试演」，加 --apply 才真正写入；日志 5 分钟内被写过需 --force）:
 *   list    [--workspace <名称片段>]                 查看各会话的子代理条目数
 *   dismiss --session <id|前缀> [--apply] [--force] [--no-verify]
 *                                                   去掉条目（非破坏：保留全部行与 seq）
 *   purge   --session <id|前缀> [--apply] [--force]  彻底删除会话目录 + 日志 + 投影缓存（先整份备份）
 *   orphans [--apply]                                列出／删除「没有会话目录」的孤儿投影缓存
 *   restore --backup <备份目录>                       从备份还原
 *   autowait --pid <DSH 的 pid>                      等该进程退出后自动 dismiss --all（供插件在「重启窗口」调用，
 *                                                    开关与状态见 <状态目录>/auto-arm.json、auto-report.json）
 *   help | version
 *
 * ⚠ 核心机制（务必先读 / read this first）
 *   1) `subagent/catalog` 是**只增不减**的父会话事件（每派一个子代理追加一条），DSH 没有删除 API。
 *   2) **不能删行**：DSH 要求事件 seq 自 0 起稠密（+1），删行即报
 *      `released v2 row N has seq gap`，整个会话打不开（2026-10-06 事故，已逐字节回滚）。
 *      故 `strip` 命令已停用。
 *   3) 正解 = 保留行与 seq 不变，只把 type 改成未注册的 `subagent/catalog-dismissed` 并加
 *      `"ignorable": true`（未注册类型 + ignorable 被当不透明元数据保留；catalog 投影的 apply 只认原类型）。
 *   4) **header 一字不动**：改 header.id 会让日志里 `session-log-deepseek/delivery-accepted` 的
 *      data.sessionId 失配 → `current-generation delivery marker names the wrong Session`。
 *   5) 投影缓存 storages/session_projcache/sessions/<id>.json 里的 subagentCatalog 检查点必须同时改成
 *      合法空状态 `{"inheritedEventCount":N}`（**不可**写 head.values=[]，schema 要求至少 1 项）——
 *      因为冷折返会「跳过已检查点的前缀」；只改日志不改缓存，条目照旧显示。
 *   6) 改完必须**完全退出并重启 DSH**（运行中的进程内存里仍是旧值）。
 *
 *   分叉（fork）会话会继承父会话的历史事件：投影只统计 seq >= inheritedEventCount 的「自己的」事件，
 *   故本工具只处理「自己的」catalog 行，继承来的原样保留。
 *
 * 输出同时写入 <状态目录>/out_last.txt（UTF-8），控制台乱码时读它。
 */
import { readFileSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync, openSync, closeSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import zlib from 'node:zlib';

/** Node >= 22 才有 zlib 的 zstd。**不要**在模块顶层 exit：本文件会被 DSH 插件 import，
 *  （顶层 exit 会把宿主进程一起带走）——只在「直接被 CLI 调用」时才退出。 */
const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PROG = IS_WIN ? 'clean.cmd' : './clean.sh';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const SESS_ROOT = join(DSH_HOME, 'sessions');
const CACHE_ROOT = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
/** 首选目录不可写时（例如全局安装到只读位置）退回备用目录。 */
function writableDir(preferred, fallback) {
  for (const d of [preferred, fallback]) {
    if (!d) continue;
    try {
      mkdirSync(d, { recursive: true });
      const probe = join(d, '.write-probe');
      writeFileSync(probe, '');
      rmSync(probe);
      return d;
    } catch { /* 试下一个 */ }
  }
  return preferred;
}
/** 备份／输出／镜像自检的落点（包目录只读时退回 DSH_HOME）。DSAC_STATE_DIR 可显式指定，自测用它隔离。 */
const STATE_DIR = process.env.DSAC_STATE_DIR || writableDir(TOOL_DIR, join(DSH_HOME, 'tools', 'dsh-agent-clean'));
const BACKUP_ROOT = process.env.DSAC_BACKUP_DIR || join(STATE_DIR, 'backups');
const MIRROR_ROOT = join(STATE_DIR, 'verify_root');
const OUT_FILE = join(STATE_DIR, 'out_last.txt');
const VERSION = (() => { try { return JSON.parse(readFileSync(join(TOOL_DIR, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })();
const CATALOG_TYPE = 'subagent/catalog';
const CATALOG_MARK = '"' + CATALOG_TYPE + '"';
const DISMISS_TYPE = 'subagent/catalog-dismissed';
const CHECKSUM_PARAM = zlib.constants.ZSTD_c_checksumFlag;
const COMPRESS_OPTS = typeof CHECKSUM_PARAM === 'number' ? { params: { [CHECKSUM_PARAM]: 1 } } : undefined;

// ---------------------------------------------------------------- zstd frames
function frameLength(buf, pos) {
  if (!(buf[pos] === 0x28 && buf[pos + 1] === 0xb5 && buf[pos + 2] === 0x2f && buf[pos + 3] === 0xfd)) throw new Error('bad zstd magic at ' + pos);
  let p = pos + 4;
  const fhd = buf[p]; p++;
  const fcsFlag = fhd >> 6, singleSegment = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictIdFlag = fhd & 3;
  if (!singleSegment) p += 1;
  p += [0, 1, 2, 4][dictIdFlag];
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [2, 4, 8][fcsFlag - 1];
  for (;;) {
    const hdr = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = hdr & 1, btype = (hdr >> 1) & 3, bsize = hdr >> 3;
    if (btype === 0 || btype === 2) p += bsize; else if (btype === 1) p += 1;
    else throw new Error('reserved zstd block type');
    if (last) break;
  }
  if (checksum) p += 4;
  return p - pos;
}
function frameTexts(buf) {
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    const len = frameLength(buf, pos);
    const text = zlib.zstdDecompressSync(buf.subarray(pos, pos + len)).toString('utf8');
    const parts = text.split('\n');
    if (parts[parts.length - 1] !== '') throw new Error('frame ' + frames.length + ' does not end with a newline');
    parts.pop();
    frames.push({ offset: pos, len, lines: parts });
    pos += len;
  }
  return frames;
}
/** 该行是不是「自己的」catalog 行（继承自 fork 源的不算）。 */
function isOwnCatalog(row, inherited) {
  if (!row.includes(CATALOG_MARK)) return false;
  let seq;
  try { seq = JSON.parse(row).seq; } catch { return true; } // 解析失败则保守当作需要处理
  return !(typeof seq === 'number' && seq < inherited);
}
/** 统计：帧数、行数、自己的 catalog 行数。 */
function inspect(buf, inherited) {
  const frames = frameTexts(buf);
  let rows = 0, catalog = 0;
  for (const f of frames) {
    rows += f.lines.length;
    for (const r of f.lines) if (isOwnCatalog(r, inherited)) catalog++;
  }
  return { frames: frames.length, rows, catalog };
}
/** 摘掉自己的 catalog 行后重建整个文件，并校验保留行与原文逐行一致。 */
function rebuild(buf, inherited) {
  const out = []; const detail = [];
  let removed = 0, rewritten = 0, frameNo = 0;
  for (const f of frameTexts(buf)) {
    frameNo++;
    if (!f.lines.some((r) => isOwnCatalog(r, inherited))) { out.push(buf.subarray(f.offset, f.offset + f.len)); continue; }
    const keep = f.lines.filter((r) => !isOwnCatalog(r, inherited));
    const dropped = f.lines.length - keep.length;
    if (keep.length) {
      const re = zlib.zstdCompressSync(Buffer.from(keep.join('\n') + '\n', 'utf8'), COMPRESS_OPTS);
      out.push(re);
      detail.push(`帧 ${frameNo}: ${f.lines.length} 行 -> ${keep.length} 行（删 ${dropped}），${f.len} B -> ${re.length} B`);
    } else {
      detail.push(`帧 ${frameNo}: ${f.lines.length} 行 -> 整帧删除`);
    }
    removed += dropped;
    rewritten++;
  }
  return { buf: Buffer.concat(out), removed, rewritten, detail };
}

// ---------------------------------------------------------------- 盘上枚举
function parseGeneration(name) {
  const m = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name);
  return m ? { version: Number(m[1]), compressed: Boolean(m[2]) } : undefined;
}
function decodeEscapes(dirName) {
  const body = /\-Documents\-(.+?)\-\-$/.exec(dirName);
  const t = body ? body[1] : dirName;
  return t.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function readCache(cachePath) {
  if (!existsSync(cachePath)) return { exists: false };
  try {
    const j = JSON.parse(readFileSync(cachePath, 'utf8'));
    const rows = j?.record?.rows ?? {};
    const t = rows?.title?.val;
    const cat = rows?.subagentCatalog;
    return {
      exists: true,
      pretty: true,
      json: j,
      title: typeof t === 'string' ? t : (t == null ? '' : JSON.stringify(t).slice(0, 60)),
      inherited: j?.record?.identity?.inheritedEventCount ?? 0,
      catalogSeq: cat?.seq ?? -1,
      catalogCount: Array.isArray(cat?.val?.head?.values) ? cat.val.head.values.length : null,
      hasHead: Boolean(cat?.val?.head),
    };
  } catch (e) {
    return { exists: true, broken: String(e) };
  }
}
function listSessions(workspaceFilter) {
  const out = [];
  if (!existsSync(SESS_ROOT)) return out;
  for (const project of readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    if (workspaceFilter && !project.name.includes(workspaceFilter)) continue;
    const projectDir = join(SESS_ROOT, project.name);
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(projectDir, entry.name);
      const logs = readdirSync(dir).map((n) => ({ name: n, gen: parseGeneration(n) })).filter((x) => x.gen);
      if (!logs.length) continue;
      logs.sort((a, b) => b.gen.version - a.gen.version);
      const logPath = join(dir, logs[0].name);
      const st = statSync(logPath);
      const cachePath = join(CACHE_ROOT, entry.name + '.json');
      const cache = readCache(cachePath);
      let info = { frames: null, rows: null, catalog: null, broken: '' };
      try { info = { ...inspect(readFileSync(logPath), cache.inherited ?? 0), broken: '' }; }
      catch (e) { info = { frames: null, rows: null, catalog: null, broken: String((e && e.message) || e) }; }
      out.push({
        project: project.name, projectLabel: decodeEscapes(project.name), sessionId: entry.name, dir, logPath,
        logName: logs[0].name, generation: logs[0].gen.version, size: st.size, mtime: st.mtime,
        frames: info.frames, rows: info.rows, catalog: info.catalog, broken: info.broken || '',
        cachePath: cache.exists ? cachePath : '', cache, allLogs: logs.map((l) => join(dir, l.name)),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 输出
const BUFFER = [];
function say(line = '') { BUFFER.push(line); }
let OUT_TARGET = OUT_FILE;
function emit() {
  const text = BUFFER.join('\n') + '\n';
  try { writeFileSync(OUT_TARGET, text, 'utf8'); } catch { /* 忽略 */ }
  process.stdout.write(text);
}
function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function shortId(id) { return id.replace(/^session-/, '').slice(0, 8); }

// ---------------------------------------------------------------- 命令
function cmdList(workspaceFilter) {
  const all = listSessions(workspaceFilter);
  const withCat = all.filter((s) => s.catalog > 0 || (s.cache.catalogCount ?? 0) > 0);
  say(`共 ${all.length} 个会话，其中 ${withCat.length} 个含「自己的」子代理条目：`);
  say('');
  for (const s of withCat.sort((a, b) => b.catalog - a.catalog)) {
    const cc = s.cache.catalogCount;
    say(`  会话 ${s.sessionId}`);
    say(`    工作区 : ${s.projectLabel}`);
    say(`    标题   : ${s.cache.title || '(未知)'}`);
    say(`    日志   : ${s.logName}  ${s.size} B  改于 ${fmtTime(s.mtime)}  generation v${s.generation}`);
    say(`    条目   : 日志中 ${s.catalog} 条（自己的）  |  投影缓存 ${s.cachePath ? (cc === null ? '0 条（无 head）' : cc + ' 条') : '(无缓存文件)'}`);
    if (s.cache.inherited) say(`    注     : 分叉会话，继承父会话事件 ${s.cache.inherited} 条（不计入）`);
    say('');
  }
  if (!withCat.length) say('  （没有需要清理的会话）');
  const broken = all.filter((s) => s.broken);
  if (broken.length) {
    say('');
    say(`⚠ 有 ${broken.length} 个会话的最新日志读不出来（可能不是 zstd 或已损坏）：`);
    say('');
    for (const s of broken) say(`    会话 ${s.sessionId}: ${s.broken}`);
    say('  这类会话 purged/dismiss 前请先自己核对；orphans 与 purge 不以解析日志为前提。');
  }
  if (withCat.length) say(`注：strip 已停用（删行会破坏日志 seq 稠密性，导致会话无法加载）；还原用 ${PROG} restore --backup <备份目录>`);
  say('');
  say(`本输出同时写入 ${OUT_FILE}`);
  emit();
  return withCat;
}

function stripOne(s, { apply, force, generations }) {
  say(`会话 ${s.sessionId}`);
  say(`  工作区: ${s.projectLabel}   标题: ${s.cache.title || '(未知)'}`);
  if (s.cache.inherited) say(`  分叉会话：继承父会话事件 ${s.cache.inherited} 条，只摘自己的 catalog 行。`);
  const minutesIdle = (Date.now() - s.mtime.getTime()) / 60000;
  if (minutesIdle < 5 && !force) {
    say(`  ⚠ 该日志 ${minutesIdle.toFixed(1)} 分钟前还被写入（可能正在运行）。加 --force 才继续。`);
    return { ok: false };
  }
  const targets = generations === 'all' ? s.allLogs : [s.logPath];
  const plan = [];
  for (const p of targets) {
    const buf = readFileSync(p);
    const info = inspect(buf, s.cache.inherited ?? 0);
    if (!info.catalog) { say(`  ${p.split('\\').pop()}: 无自己的 catalog 行，跳过`); continue; }
    const { buf: nb, removed, rewritten, detail } = rebuild(buf, s.cache.inherited ?? 0);
    const after = inspect(nb, s.cache.inherited ?? 0);
    const before = frameTexts(buf).flatMap((f) => f.lines).filter((r) => !isOwnCatalog(r, s.cache.inherited ?? 0));
    const got = frameTexts(nb).flatMap((f) => f.lines);
    const identical = before.length === got.length && before.every((r, i) => r === got[i]);
    say(`  ${p.split('\\').pop()}: ${info.rows} 行 -> ${after.rows} 行，删 ${removed} 条，${buf.length} B -> ${nb.length} B，重压 ${rewritten} 帧`);
    for (const d of detail) say(`      ${d}`);
    say(`      保留行逐行一致: ${identical}${identical ? '' : '  ✗ 校验失败，放弃写入'}`);
    if (!identical || after.catalog) { say('      ✗ 校验未通过，放弃写入。'); return { ok: false }; }
    plan.push({ path: p, buf: nb, removed });
  }
  const cachePlan = [];
  if (s.cachePath && (s.cache.catalogCount ?? 0) > 0) {
    const raw = readFileSync(s.cachePath, 'utf8');
    const j = JSON.parse(raw);
    const pretty = /^\{\n {2}"/.test(raw);
    j.record.rows.subagentCatalog.val.head.values = [];
    cachePlan.push({
      path: s.cachePath, before: s.cache.catalogCount,
      out: (pretty ? JSON.stringify(j, null, 2) : JSON.stringify(j)) + (raw.endsWith('\n') ? '\n' : ''),
    });
    say(`  投影缓存 ${s.cachePath.split('\\').pop()}: subagentCatalog.values ${s.cache.catalogCount} -> 0`);
  } else if (s.cachePath) {
    say('  投影缓存: 已是空（无需改动）');
  } else {
    say('  投影缓存: 无该会话的缓存文件（无需改动）');
  }
  if (!plan.length && !cachePlan.length) { say('  无需改动。'); say(''); return { ok: true, changed: 0 }; }
  if (!apply) {
    say('');
    say(`  [试演] 将删除 ${plan.reduce((a, p) => a + p.removed, 0)} 行并改动 ${cachePlan.length} 个缓存文件。加 --apply 真正写入。`);
    say('');
    return { ok: true, changed: 0, dry: true };
  }
  const bak = join(BACKUP_ROOT, new Date().toISOString().replace(/[:.]/g, '-') + '_' + shortId(s.sessionId));
  mkdirSync(bak, { recursive: true });
  const manifest = { sessionId: s.sessionId, createdAt: new Date().toISOString(), files: [] };
  let removedTotal = 0;
  for (const p of plan) {
    const base = p.path.split('\\').pop();
    copyFileSync(p.path, join(bak, base));
    manifest.files.push({ backup: base, original: p.path });
  }
  if (cachePlan.length) {
    copyFileSync(cachePlan[0].path, join(bak, 'projcache.json'));
    manifest.files.push({ backup: 'projcache.json', original: cachePlan[0].path });
  }
  writeFileSync(join(bak, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  for (const p of plan) { writeFileSync(p.path, p.buf); removedTotal += p.removed; }
  for (const c of cachePlan) writeFileSync(c.path, c.out, 'utf8');
  for (const p of plan) {
    const check = inspect(readFileSync(p.path), s.cache.inherited ?? 0);
    say(`  复核 ${p.path.split('\\').pop()}: ${check.rows} 行，自己的 catalog ${check.catalog} 条`);
  }
  say(`  备份目录: ${bak}`);
  say('  ✓ 完成。重启 DSH（或重新打开该会话）后条目即消失。');
  say('');
  return { ok: true, changed: 1, backup: bak };
}

function cmdStrip(opts) {
  /* 2026-10-06 事故：删掉 catalog 行会使日志的 seq 不再稠密，DSH 拒绝加载该会话。
   * 实测报错： invalid committed event at line 4087: released v2 row 4086 has seq gap
   *            (expected 4086, got 4087)
   * 日志校验要求 seq 自 0 起逐行 +1，删任何一行都会毁掉整个会话（已用备份回滚）。
   * 因此本命令停用，只保留只读的 list / restore。 */
  say('✗ strip 已停用。');
  say('  原因：删行会破坏日志 seq 的稠密性，DSH 校验不过，整个会话无法加载。');
  say('  实测报错：released v2 row 4086 has seq gap (expected 4086, got 4087)');
  say('  如需隐藏子代理条目，请改用「保留全部行、只把 catalog 行改成未知类型并加 ignorable:true」的非破坏方案');
  say('  （未验证前不要动真实日志）。');
  say('  可用命令：clean.cmd list ／ clean.cmd restore --backup <备份目录>');
  emit();
  process.exitCode = 1;
  return;
}

function cmdStripDisabled(opts) {
  let targets;
  if (opts.all) targets = listSessions().filter((s) => s.catalog > 0 || (s.cache.catalogCount ?? 0) > 0);
  else if (opts.session) {
    targets = listSessions().filter((s) => s.sessionId === opts.session || s.sessionId.startsWith(opts.session) || shortId(s.sessionId) === opts.session);
    if (!targets.length) { say(`找不到会话: ${opts.session}`); emit(); process.exitCode = 1; return; }
  } else {
    say('需要 --session <id 前缀> 或 --all'); emit(); process.exitCode = 1; return;
  }
  if (!targets.length) { say('没有需要清理的会话。'); emit(); return; }
  let failures = 0;
  for (const s of targets) if (!stripOne(s, opts).ok) failures++;
  say(`目标会话 ${targets.length} 个；失败 ${failures} 个。`);
  emit();
  if (failures) process.exitCode = 1;
}

// ------------------------------------------------- 非破坏方案（dismiss，2026-10-06 实测可用）
/**
 * 保留全部行与 seq，只把「自己的」`subagent/catalog` 行改成未注册类型 `subagent/catalog-dismissed`
 * 并加 `"ignorable": true`。DSH 把「未知类型 + ignorable」当不透明元数据保留（不报错、不改 surface），
 * 而 subagentCatalog 投影的 apply 只认 `subagent/catalog`，故条目不再进入投影。
 * 头部 header 一字不动 —— 这一点很关键：改 header.id 会让日志里所有
 * `session-log-deepseek/delivery-accepted` 的 data.sessionId 失配，加载时报
 * "current-generation delivery marker names the wrong Session"（2026-10-06 副本试验踩过）。
 */
function rebuildDismiss(buf, inherited) {
  const out = []; const detail = [];
  let retyped = 0, rewritten = 0, frameNo = 0;
  for (const f of frameTexts(buf)) {
    frameNo++;
    let touched = false;
    const lines = f.lines.map((line) => {
      if (line.indexOf(CATALOG_MARK) < 0) return line;
      let ev;
      try { ev = JSON.parse(line); } catch { return line; }
      if (ev.type !== CATALOG_TYPE) return line;
      if (typeof ev.seq === 'number' && ev.seq < inherited) return line;
      touched = true; retyped++;
      return JSON.stringify({ ...ev, type: DISMISS_TYPE, ignorable: true });
    });
    if (touched) {
      rewritten++;
      const re = zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), COMPRESS_OPTS);
      out.push(re);
      detail.push(`帧 ${frameNo}: ${f.lines.length} 行中改写 catalog，${f.len} B -> ${re.length} B`);
    } else out.push(buf.subarray(f.offset, f.offset + f.len));
  }
  const nb = Buffer.concat(out);
  const before = frameTexts(buf).flatMap((f) => f.lines);
  const after = frameTexts(nb).flatMap((f) => f.lines);
  let dense = true, untouched = true, catalog = 0, inheritedCatalog = 0, dismissed = 0;
  // 真实 v4 日志第 0 行是 header（没有 seq），事件从第 1 行起、seq 从 0 起；
  // 若首行本身就是 seq 0（例如自测造的日志），则从第 0 行起算。
  let offset = 1;
  try { if (JSON.parse(after[0]).seq === 0) offset = 0; } catch { offset = 1; }
  for (let i = offset; i < after.length; i++) {
    const ev = JSON.parse(after[i]);
    if (ev.seq !== i - offset) dense = false;
    // 分叉会话（fork）的日志里前半段是父会话的**继承区**：seq < inherited 的 catalog 行不归本会话，
    // 清理时必须原样保留，自检也不能把它们算作「剩余 catalog」——1.3.1 就是漏了这道 fence，
    // 只要日志里有继承来的 catalog 行就恒判自检失败、永远放弃写入。
    const isInherited = typeof ev.seq === 'number' && ev.seq < inherited;
    if (ev.type === CATALOG_TYPE) { if (isInherited) inheritedCatalog++; else catalog++; }
    if (ev.type === DISMISS_TYPE) dismissed++;
    if (before[i] !== after[i] && (isInherited || JSON.parse(before[i]).type !== CATALOG_TYPE)) untouched = false;
  }
  return { buf: nb, retyped, rewritten, detail, dense, untouched, rowsSame: before.length === after.length, rows: after.length, catalog, inheritedCatalog, dismissed };
}
/** 空目录在投影 stateSchema 下的合法形状：只有 inheritedEventCount，不能带 head（head.values 要求 >=1 项）。 */
function emptyCatalogState(inherited) { return { inheritedEventCount: inherited ?? 0 }; }

/** 某个应用目录里的可执行文件 + app.asar（Windows / macOS .app / Linux 布局）。 */
function appIn(dir) {
  const asar = [join(dir, 'resources', 'app.asar'), join(dir, 'Contents', 'Resources', 'app.asar')].find((p) => existsSync(p));
  if (!asar) return undefined;
  let exes = [];
  if (IS_WIN) exes = ['DeepSeek Harness.exe', 'dsh.exe', 'DeepSeekHarness.exe'].map((n) => join(dir, n));
  else if (IS_MAC) { try { exes = readdirSync(join(dir, 'Contents', 'MacOS')).map((n) => join(dir, 'Contents', 'MacOS', n)); } catch { exes = []; } }
  else exes = ['deepseek-harness', 'DeepSeek Harness', 'dsh', 'DeepSeekHarness'].map((n) => join(dir, n));
  const exe = exes.find((p) => existsSync(p));
  return exe ? { dir, exe, asar } : undefined;
}
/** 找已安装的 DSH 桌面应用（Electron 可当 node 用，带 asar 支持，能跑真实加载器）。 */
function findApp(o = {}) {
  if (o.noApp || process.env.DSAC_NO_APP === '1') return undefined;
  const exe = o.exe || process.env.DSH_APP_EXE;
  const asar = o.asar || process.env.DSH_APP_ASAR;
  if (exe && existsSync(exe)) {
    const guess = asar && existsSync(asar) ? asar : [join(dirname(exe), 'resources', 'app.asar'), join(dirname(exe), '..', 'Resources', 'app.asar')].find((p) => existsSync(p));
    if (guess) return { dir: dirname(exe), exe, asar: guess, explicit: true };
  }
  if (asar && existsSync(asar)) {
    const dir = dirname(dirname(asar));
    const found = appIn(dir);
    if (found) return { ...found, explicit: true };
  }
  const cands = [];
  const pushAll = (base, names) => { if (!base) return; for (const n of names) cands.push(join(base, n)); };
  if (process.env.DSH_APP_DIR) cands.push(process.env.DSH_APP_DIR);
  if (IS_WIN) {
    for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.APPDATA]) {
      pushAll(base, ['Programs\\DeepSeek Harness', 'DeepSeek Harness']);
      for (const parent of [base && join(base, 'Programs'), base]) {
        try { for (const e of readdirSync(parent, { withFileTypes: true })) if (e.isDirectory() && /deepseek|harness/i.test(e.name)) cands.push(join(parent, e.name)); } catch { /* 忽略 */ }
      }
    }
  } else if (IS_MAC) {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      try { for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory() && e.name.endsWith('.app')) cands.push(join(base, e.name)); } catch { /* 忽略 */ }
    }
  } else {
    for (const base of ['/opt', '/usr/lib', '/usr/local/lib', '/usr/share', join(homedir(), '.local', 'share'), join(homedir(), 'Applications')]) {
      try { for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory() && /deepseek|harness/i.test(e.name)) cands.push(join(base, e.name)); } catch { /* 忽略 */ }
    }
  }
  for (const dir of cands) {
    const found = appIn(dir);
    if (found) return found;
  }
  return undefined;
}
/** 纯 Node 的 DSH 安装：含 @deepseek-ai/* 的 node_modules 目录（CLI 安装的备选复核途径）。 */
function findModules(o = {}) {
  const dir = o.modules || process.env.DSH_MODULES;
  if (dir && existsSync(join(dir, '@deepseek-ai', 'dsh-session-persistence-jsonl'))) return dir;
  return undefined;
}
/** 用 DSH 自己的加载器读一份日志（root/projectDir/sessionId 必须是真实布局），返回原始输出。 */
function verifyWithRealLoader(root, projectDir, sessionId, o = {}) {
  const script = join(TOOL_DIR, 'verify_loader.mjs');
  if (!existsSync(script)) return { skipped: true, why: '缺少 verify_loader.mjs' };
  const app = findApp(o);
  const modules = findModules(o);
  if (!app && !modules) return { skipped: true, why: '未找到 DSH 应用或 @deepseek-ai 包（可用 --app/--asar/--modules，或 DSH_APP_DIR/DSH_MODULES）' };
  const outFile = join(STATE_DIR, 'out_verify.txt');
  // 明确给了 --modules/DSH_MODULES 时，优先用纯 Node（便于在不同安装方式间切换）。
  const useApp = app && !(o.modules || process.env.DSH_MODULES);
  const argv = [script];
  if (useApp) argv.push('--asar', app.asar); else argv.push('--modules', modules);
  argv.push('--root', root, '--dir', join(root, projectDir, sessionId));
  // 注意：不要把整条命令串交给 `cmd /c` —— Node 在 Windows 上会把它包成带反斜杠转义的参数，
  // 而 cmd 不认 `\"`，结果命令根本没执行（out_verify.txt 都不会生成）。直接用 fd 收 stdout/stderr。
  rmSync(outFile, { force: true });
  const fd = openSync(outFile, 'w');
  const r = spawnSync(useApp ? app.exe : process.execPath, argv, {
    env: useApp ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let text = '';
  try { text = readFileSync(outFile, 'utf8'); } catch { /* 忽略 */ }
  const ok = /RESULT: OK/.test(text);
  const entries = /PROJECTION entries=(\d+)/.exec(text);
  return { skipped: false, via: useApp ? 'electron' : 'node', status: r.status, ok, entries: entries ? Number(entries[1]) : undefined, text };
}

function cmdDismiss(opts) {
  const all = listSessions(opts.workspace);
  const targets = opts.all
    ? all.filter((s) => s.catalog > 0 || (s.cache.catalogCount ?? 0) > 0)
    : all.filter((s) => s.sessionId === opts.session || s.sessionId.startsWith(opts.session) || shortId(s.sessionId) === opts.session);
  if (!targets.length) { say(opts.session ? `找不到会话: ${opts.session}` : '没有需要处理的会话。'); emit(); process.exitCode = 1; return; }
  say(`非破坏方案（dismiss）：保留全部行与 seq，只把「自己的」${CATALOG_TYPE} 行改成 ${DISMISS_TYPE} + ignorable:true`);
  const app = findApp(opts); const modules = findModules(opts);
  say(`应用加载器自检：${app ? `可用（Electron asar: ${app.asar}）` : modules ? `可用（node modules: ${modules}）` : '不可用 —— 不加 --no-verify 将拒绝写入'}`);
  say(`DSH_HOME: ${DSH_HOME}`);
  say('');
  let failures = 0;
  for (const s of targets) if (!dismissOne(s, opts).ok) failures++;
  say(`目标会话 ${targets.length} 个；失败 ${failures} 个。`);
  if (failures) say('（失败者未做任何改动）');
  emit();
  if (failures) process.exitCode = 1;
}

function dismissOne(s, opts) {
  say(`会话 ${s.sessionId}`);
  say(`  工作区: ${s.projectLabel}   标题: ${s.cache.title || '(未知)'}`);
  const inherited = s.cache.inherited ?? 0;
  if (inherited) say(`  分叉会话：继承父会话事件 ${inherited} 条（继承来的 catalog 行原样保留，不动）`);
  const minutesIdle = (Date.now() - s.mtime.getTime()) / 60000;
  if (minutesIdle < 5 && !opts.force) { say(`  ⚠ 该日志 ${minutesIdle.toFixed(1)} 分钟前还被写入。加 --force 才继续。`); say(''); return { ok: false, why: `日志 ${minutesIdle.toFixed(1)} 分钟前还被写入（未加 --force）` }; }
  const buf = readFileSync(s.logPath);
  const info = inspect(buf, inherited);
  if (!info.catalog) { say('  该日志没有「自己的」catalog 行，无需处理。'); say(''); return { ok: true, changed: 0 }; }
  const r = rebuildDismiss(buf, inherited);
  say(`  ${s.logName}: ${info.rows} 行 -> ${r.rows} 行（行数不变）  ${buf.length} B -> ${r.buf.length} B  改写 ${r.retyped} 条，重压 ${r.rewritten} 帧`);
  for (const d of r.detail) say(`      ${d}`);
  const ownLeft = `剩余 catalog(自己的)=${r.catalog}${r.inheritedCatalog ? `（另继承而来、按规定不动 ${r.inheritedCatalog} 条）` : ''}`;
  say(`  自检: seq 稠密=${r.dense}  非 catalog 行逐字节不变=${r.untouched}  ${ownLeft}  dismissed=${r.dismissed}`);
  if (!r.dense || !r.untouched || r.catalog || r.rowsSame === false) {
    say('  ✗ 自检未通过，放弃写入。');
    say('');
    return { ok: false, why: `离线自检未通过（seq 稠密=${r.dense} 非 catalog 行未动=${r.untouched} 剩余自己的 catalog=${r.catalog} 行数一致=${r.rowsSame !== false}）` };
  }
  // 用真实加载器在镜像根里先验证
  const projectDir = s.project;
  const mirrorDir = join(MIRROR_ROOT, projectDir, s.sessionId);
  let verified = { skipped: true, why: '未启用' };
  try {
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, s.logName), r.buf);
    verified = verifyWithRealLoader(MIRROR_ROOT, projectDir, s.sessionId, opts);
    rmSync(MIRROR_ROOT, { recursive: true, force: true });
  } catch (e) { verified = { skipped: true, why: '镜像自检出错: ' + String(e).slice(0, 120) }; }
  if (verified.skipped) {
    say(`  真实加载器自检: 跳过（${verified.why}）`);
    if (!opts.noVerify) { say('  ✗ 未做真实加载器自检；确实要写入请显式加 --no-verify。'); say(''); return { ok: false, why: `未做真实加载器自检（${verified.why}）` }; }
    say('  ⚠ --no-verify：本次写入未经真实加载器验证，风险自担。');
  } else {
    say(`  真实加载器自检(${verified.via}): ${verified.ok ? 'OK' : '✗ 失败'}  投影条目=${verified.entries ?? '?'}`);
    for (const line of verified.text.split('\n').filter((l) => /RESULT|PROJECTION|subagent\/catalog|cause/.test(l))) say(`      ${line.trim()}`);
    if (!verified.ok || verified.entries !== 0) { say('  ✗ 真实加载器未通过，放弃写入。'); say(''); return { ok: false, why: `真实加载器自检未通过（投影条目=${verified.entries ?? '?'}）` }; }
  }
  const cachePatch = [];
  if (s.cachePath) {
    if ((s.cache.catalogCount ?? 0) > 0) {
      const raw = readFileSync(s.cachePath, 'utf8');
      const j = JSON.parse(raw);
      j.record.rows.subagentCatalog.val = emptyCatalogState(inherited);
      const pretty = /^\{\n {2}"/.test(raw);
      cachePatch.push({ path: s.cachePath, before: s.cache.catalogCount, out: (pretty ? JSON.stringify(j, null, 2) : JSON.stringify(j)) + (raw.endsWith('\n') ? '\n' : '') });
      say(`  投影缓存: subagentCatalog 检查点 ${s.cache.catalogCount} 条 -> 空状态 ${JSON.stringify(emptyCatalogState(inherited))}`);
    } else say(`  投影缓存: 已是空状态（${s.cache.hasHead ? '无 head' : '无 head'}，无需改动）`);
  } else say('  投影缓存: 该会话没有缓存文件（无需改动）');
  if (!opts.apply) { say(''); say('  [试演] 加 --apply 才真正写入（会先整份备份）。'); say(''); return { ok: true, changed: 0, dry: true }; }
  const bak = join(BACKUP_ROOT, new Date().toISOString().replace(/[:.]/g, '-') + '_dismiss_' + shortId(s.sessionId));
  mkdirSync(bak, { recursive: true });
  const manifest = { sessionId: s.sessionId, createdAt: new Date().toISOString(), command: 'dismiss', files: [] };
  const logBase = s.logName;
  copyFileSync(s.logPath, join(bak, logBase));
  manifest.files.push({ backup: logBase, original: s.logPath });
  if (cachePatch.length) { copyFileSync(cachePatch[0].path, join(bak, 'projcache.json')); manifest.files.push({ backup: 'projcache.json', original: cachePatch[0].path }); }
  writeFileSync(join(bak, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(s.logPath, r.buf);
  for (const c of cachePatch) writeFileSync(c.path, c.out, 'utf8');
  const after = inspect(readFileSync(s.logPath), inherited);
  say(`  复核(盘上): ${after.rows} 行，自己的 catalog ${after.catalog} 条`);
  const live = verifyWithRealLoader(SESS_ROOT, projectDir, s.sessionId, opts);
  if (live.skipped) say(`  复核(真实加载器): 跳过（${live.why}）`);
  else say(`  复核(真实加载器): ${live.ok ? 'OK' : '✗ 失败'}  投影条目=${live.entries ?? '?'}`);
  say(`  备份目录: ${bak}`);
  say('  ✓ 完成。完全退出并重启 DSH 后条目消失（运行中的进程内存里仍有旧值）。');
  say('');
  return { ok: true, changed: 1, backup: bak };
}

/** 列出／清理「没有对应会话目录」的孤儿投影缓存记录（chat-manager 永久删除只删目录，不删缓存）。 */
function allSessionIds() {
  const ids = new Set();
  if (!existsSync(SESS_ROOT)) return ids;
  // 会话目录名有两种：根会话 `session-<uuid>`、子代理会话 `<uuid>`（**没有** session- 前缀）。
  // 只认前一种会把「还活着的子代理会话」的投影缓存误判成孤儿缓存并被 orphans --apply 删掉。
  const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const project of readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const e of readdirSync(join(SESS_ROOT, project.name), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('session-') || BARE_UUID.test(e.name)) ids.add(e.name);
    }
  }
  return ids;
}
function cmdOrphans(opts) {
  const ids = allSessionIds();
  const files = existsSync(CACHE_ROOT) ? readdirSync(CACHE_ROOT).filter((n) => n.endsWith('.json')) : [];
  const orphans = [];
  for (const n of files) {
    const id = n.replace(/\.json$/, '');
    if (ids.has(id)) continue;
    const p = join(CACHE_ROOT, n);
    let title = '', catalog = null, mtime = '';
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const t = j?.record?.rows?.title?.val;
      title = typeof t === 'string' ? t : '';
      catalog = j?.record?.rows?.subagentCatalog?.val?.head?.values?.length ?? 0;
    } catch { /* 损坏的也一并列出 */ }
    try { mtime = fmtTime(statSync(p).mtime); } catch { /* 忽略 */ }
    orphans.push({ id, name: n, path: p, size: statSync(p).size, title, catalog, mtime });
  }
  say(`会话目录 ${ids.size} 个；投影缓存 ${files.length} 个；**孤儿 ${orphans.length} 个**（会话目录已不存在，缓存仍在）：`);
  say('');
  for (const o of orphans.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))) {
    say(`  ${o.id}`);
    say(`    缓存 ${o.size} B  改于 ${o.mtime}  标题 ${JSON.stringify(o.title)}  条目 ${o.catalog ?? '?'}`);
  }
  if (!orphans.length) { say('  （没有孤儿缓存）'); say(''); emit(); return; }
  if (!opts.apply) {
    say('');
    say('  [试演] 加 --apply 会先整份备份到 backups\\<时间>_orphans\\ 再删除这些缓存文件。');
    say('  注意：缓存是派生数据，删掉只是让 DSH 下次重新折返；会话日志不受影响。');
    say('');
    emit();
    return;
  }
  const bak = join(BACKUP_ROOT, new Date().toISOString().replace(/[:.]/g, '-') + '_orphans');
  mkdirSync(bak, { recursive: true });
  const manifest = { sessionId: '(orphan projcache records)', createdAt: new Date().toISOString(), command: 'orphans', files: [] };
  for (const o of orphans) { copyFileSync(o.path, join(bak, o.name)); manifest.files.push({ backup: o.name, original: o.path }); rmSync(o.path); }
  writeFileSync(join(bak, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  say(`  已删除 ${orphans.length} 个孤儿缓存；备份目录 ${bak}（可用 restore --backup 还原）`);
  say('');
  emit();
}

/** 彻底删除一个会话：整份备份后删掉会话目录（含全部 generation 日志）与它的投影缓存。 */
function purgeOne(s, opts) {
  say(`会话 ${s.sessionId}`);
  say(`  工作区: ${s.projectLabel}   标题: ${s.cache.title || '(未知)'}`);
  say(`  日志  : ${s.allLogs.map((p) => `${basename(p)} ${statSync(p).size} B`).join('  ')}`);
  const minutesIdle = (Date.now() - s.mtime.getTime()) / 60000;
  if (minutesIdle < 5 && !opts.force) { say(`  ⚠ 该日志 ${minutesIdle.toFixed(1)} 分钟前还被写入（可能正在使用中）。加 --force 才继续。`); say(''); return { ok: false }; }
  if (!opts.apply) {
    say('  [试演] 加 --apply 会先整份备份，然后删除：');
    say(`      ${s.dir}`);
    if (s.cachePath) say(`      ${s.cachePath}`);
    say('');
    return { ok: true, changed: 0, dry: true };
  }
  const bak = join(BACKUP_ROOT, new Date().toISOString().replace(/[:.]/g, '-') + '_purge_' + shortId(s.sessionId));
  mkdirSync(bak, { recursive: true });
  const manifest = { sessionId: s.sessionId, createdAt: new Date().toISOString(), command: 'purge', files: [] };
  for (const p of s.allLogs) { const b = basename(p); copyFileSync(p, join(bak, b)); manifest.files.push({ backup: b, original: p }); }
  if (s.cachePath) { copyFileSync(s.cachePath, join(bak, 'projcache.json')); manifest.files.push({ backup: 'projcache.json', original: s.cachePath }); }
  writeFileSync(join(bak, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  rmSync(s.dir, { recursive: true, force: true });
  if (s.cachePath) rmSync(s.cachePath, { force: true });
  const dirGone = !existsSync(s.dir), cacheGone = s.cachePath ? !existsSync(s.cachePath) : true;
  say(`  已删除：会话目录=${dirGone ? '是' : '否'}  投影缓存=${s.cachePath ? (cacheGone ? '是' : '否') : '(本来就没有)'}`);
  say(`  备份目录: ${bak}`);
  say('  ✓ 完成。完全退出并重启 DSH 后界面上的该会话消失（restore --backup 可还原）。');
  say('');
  return { ok: dirGone && cacheGone, changed: 1, backup: bak };
}

function cmdPurge(opts) {
  const all = listSessions(opts.workspace);
  const targets = opts.all
    ? all
    : all.filter((s) => s.sessionId === opts.session || s.sessionId.startsWith(opts.session) || shortId(s.sessionId) === opts.session);
  if (!targets.length) { say(opts.session ? `找不到会话: ${opts.session}` : '没有会话。'); emit(); process.exitCode = 1; return; }
  say(`purge：删除会话目录 + 全部 generation 日志 + 投影缓存（${opts.apply ? '正式执行' : '试演'}）`);
  say(`DSH_HOME: ${DSH_HOME}`);
  say(`备份目录: ${BACKUP_ROOT}`);
  say('');
  let failures = 0;
  for (const s of targets) if (!purgeOne(s, opts).ok) failures++;
  say(`目标会话 ${targets.length} 个；失败 ${failures} 个。`);
  emit();
  if (failures) process.exitCode = 1;
}

function cmdRestore(backupDir) {
  if (!backupDir || !existsSync(backupDir)) { say(`备份目录不存在: ${backupDir ?? '(未指定)'}`); emit(); process.exitCode = 1; return; }
  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) { say(`该目录没有 manifest.json（不是本工具产生的备份）: ${backupDir}`); emit(); process.exitCode = 1; return; }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  say(`从备份还原会话 ${manifest.sessionId}（备份于 ${manifest.createdAt}）：`);
  for (const f of manifest.files) {
    const src = join(backupDir, f.backup);
    if (!existsSync(src)) { say(`  ✗ 缺文件 ${f.backup}`); continue; }
    try { mkdirSync(dirname(f.original), { recursive: true }); } catch { /* 目录已存在 */ }
    copyFileSync(src, f.original);
    say(`  -> ${f.original}  (${statSync(f.original).size} B)`);
  }
  say('还原完成，重启 DSH 生效。');
  emit();
}

// ---------------------------------------------------------------- 自动清理（重启窗口）
/**
 * 由插件在 DSH 启动时「架设」：开关写进 <状态目录>/auto-arm.json，再 spawn 一个脱离的助手
 * 进程 `clean.mjs autowait --pid <DSH 的 pid>`。助手等那个 pid 消失（＝DSH 已完全退出）之后
 * 才动盘，走的仍是 dismiss --all 的同一条管线（整份备份 → 结构自检 → 真实加载器复核），
 * 于是下一次启动时界面里已经没有条目了。
 *
 * 为什么必须等退出：DSH 不允许运行中改写已提交事件（seq 自 0 起稠密、单写者），投影缓存也没有
 * 失效接口 —— 运行中写盘即便成功，进程内存里的旧值仍在（见 dismissOne 末尾的提示）。
 */
const ARM_FILE = join(STATE_DIR, 'auto-arm.json');
const AUTO_REPORT = join(STATE_DIR, 'auto-report.json');
const AUTO_LOG = join(STATE_DIR, 'auto.log');
const AUTO_LOCK = join(STATE_DIR, 'auto.lock');
/**
 * 宿主半每次架设助手时写的记录（谁在等哪个 pid、助手进程号）。用途只有一个：
 * 下一次启动时判断「上一轮架设的助手有没有收尾」——助手若被系统或别的工具一起杀掉，
 * 退出窗口里就什么都不会发生，而盘上一点痕迹也没有（实测：手动架设的助手会随宿主工具的
 * 进程树一起消失）。有这份记录，宿主半就能在设置页明说「上一轮没跑完」，而不是静默。
 */
const AUTO_ARMED = join(STATE_DIR, 'auto-armed.json');
const AUTO_DEFAULTS = { enabled: true, maxWaitMs: 12 * 60 * 60 * 1000, verify: true, checkOther: true };

function readArm() {
  try {
    const raw = readFileSync(ARM_FILE, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}
/** 合并写入架设文件（插件与 CLI 共用同一份形状）。 */
function writeArm(patch) {
  const next = { ...AUTO_DEFAULTS, ...(readArm() ?? {}), ...patch, updatedAt: new Date().toISOString() };
  try {
    mkdirSync(dirname(ARM_FILE), { recursive: true });
    writeFileSync(ARM_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch { /* 盘不可写时保持默认行为，不抛 */ }
  return next;
}
function readAutoReport() {
  try {
    const raw = readFileSync(AUTO_REPORT, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}
function writeAutoReport(report) {
  try {
    mkdirSync(dirname(AUTO_REPORT), { recursive: true });
    writeFileSync(AUTO_REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch { /* 忽略 */ }
}
function autoLog(line) {
  try { appendFileSync(AUTO_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8'); } catch { /* 忽略 */ }
}
function readArmed() {
  try {
    const raw = readFileSync(AUTO_ARMED, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}
function writeArmed(rec) {
  try {
    mkdirSync(dirname(AUTO_ARMED), { recursive: true });
    writeFileSync(AUTO_ARMED, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  } catch { /* 忽略 */ }
}
/**
 * 助手心跳：等待期间每 60 秒刷新一次「最后活着的时刻」。
 * 为什么需要它：只写 `auto-armed.json` 时，下一轮启动只知道「架设于几时、现在不见了」，
 * 面板于是写成「在 <架设时间> 之后就消失了」—— 那是个误导（那是架设时间，不是消失时间）。
 * 有了心跳，下一次就能说清是「刚架设就被连带杀掉」还是「守到退出窗口才没的」。
 */
const AUTO_HEARTBEAT = join(STATE_DIR, 'auto-heartbeat.json');
function readHeartbeat() {
  try {
    const raw = readFileSync(AUTO_HEARTBEAT, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}
function writeHeartbeat(waitedPid) {
  try {
    mkdirSync(dirname(AUTO_HEARTBEAT), { recursive: true });
    writeFileSync(
      AUTO_HEARTBEAT,
      JSON.stringify({ pid: process.pid, waitedPid: Number(waitedPid) || null, at: new Date().toISOString() }) + '\n',
      'utf8',
    );
  } catch { /* 忽略 */ }
}
let lastHeartbeatAt = 0;
/** 最多每分钟落一次盘（等待可能长达 12 小时，不必每秒都写）。 */
function heartbeat(waitedPid, force = false) {
  const now = Date.now();
  if (!force && now - lastHeartbeatAt < 60 * 1000) return;
  lastHeartbeatAt = now;
  writeHeartbeat(waitedPid);
}
/**
 * 上一轮架设的助手是不是「没跑完就没了」——宿主半启动时用它给用户一句明确的提示。
 * 三个条件同时成立才算：记录的不是本轮（被等的 pid 与当前进程不同）、那个助手进程已经不在、
 * 而且报告没有比架设时间更新（＝它连 timeout / 跳过 这样的报告都没留下，是真的一声不响消失了）。
 * 正常收尾的助手一定会写一份报告（成功、超时、跳过、开关关闭、抢不到锁都会写），所以这里不会误报。
 */
function missedRun(currentPid) {
  const armed = readArmed();
  if (!armed) return null;
  if (Number(armed.waitedPid) === Number(currentPid)) return null;
  if (pidAlive(armed.helperPid)) return null;
  const rep = readAutoReport();
  const repAt = rep && typeof rep.at === 'string' ? rep.at : '';
  if (repAt && repAt >= String(armed.at ?? '')) return null;
  // 心跳若属于**这个**助手，就带上「最后一次活着的时刻」：面板据此说清它是何时没的。
  const hb = readHeartbeat();
  const lastSeenAt = hb && Number(hb.pid) === Number(armed.helperPid) && typeof hb.at === 'string' ? hb.at : null;
  return { ...armed, lastSeenAt };
}
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
/** 同步小睡（助手进程不需要事件循环）。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* 忙等兜底 */ } }
}
/** 当前所有 DSH 进程的 pid（Windows 按镜像名；含本助手自己 —— 调用方必须自己排除）。 */
function dshProcessIds() {
  if (!IS_WIN) return [];
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const ids = [];
    for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
      const m = /^"[^"]*","(\d+)"/.exec(line);
      if (m) ids.push(Number(m[1]));
    }
    return ids;
  } catch { return []; }
}
/**
 * 一个 DSH 实例**不止一个同名进程**。实测（1.3.4 之前的线上日志）：一次退出窗口里报出
 * `pid 14152,11232,14412,12996,13660` 五个，其实是**同一个**新实例的
 * 主进程 + gpu-process + utility(network) + renderer + host；再加上工具子进程
 * （`dsh-subprocess-local/lib/runner.js`，跑的也是同一个 exe）与我们自己的助手（同一个 exe 跑 clean.mjs）。
 * 只按镜像名数，就会把「一个实例」说成「五个实例」，还会把助手的同伴说成实例。
 *
 * 所以按命令行分角色，**只有主进程与 host 代表「一个实例还在跑」**：
 * host 进程（`dsh-desktop-host/lib/index.js`）才是会话存储的属主，也就是被等的那个 pid。
 */
function classifyProcessCmd(cmd) {
  const c = String(cmd ?? '');
  if (!c) return 'other';
  if (/(clean|verify_loader)\.mjs\b/.test(c)) return 'helper'; // 我们的脚本（同一个 exe 跑的）
  if (/--type=/.test(c)) return 'child'; // Electron 的 gpu / renderer / utility 子进程
  if (/dsh-desktop-host[\\/]/.test(c)) return 'host'; // 会话存储的属主
  if (/dsh-subprocess-local[\\/]/.test(c)) return 'runner'; // 跑工具命令的 runner
  if (/\.(mjs|cjs|js)\b/.test(c)) return 'runner'; // 其它 node 式脚本：不当成实例
  return 'main'; // 不带参数的 Electron 主进程
}
const ROLE_LABEL = { main: '主进程', host: 'host 进程', other: '进程' };

/** 当前所有 DSH 进程（pid／父 pid／命令行／角色）。Windows 优先用 CIM 取命令行，取不到退回 tasklist（角色未知）。 */
function dshProcesses() {
  if (IS_WIN) {
    const rows = win32AppProcesses();
    if (rows) return rows.map((r) => ({ ...r, role: classifyProcessCmd(r.cmd) }));
    return dshProcessIds().map((pid) => ({ pid, ppid: 0, cmd: '', role: 'other' }));
  }
  return unixAppProcesses();
}
/** `powershell -NoProfile Get-CimInstance Win32_Process`（带命令行）。失败返回 null，由调用方回退。 */
function win32AppProcesses() {
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = 'Get-CimInstance Win32_Process -Filter "Name=\'DeepSeek Harness.exe\'" | '
    + 'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
  try {
    const r = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) return null;
    const text = String(r.stdout ?? '').replace(/^\uFEFF/, '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((x) => x && Number.isInteger(Number(x.ProcessId)))
      .map((x) => ({ pid: Number(x.ProcessId), ppid: Number(x.ParentProcessId) || 0, cmd: String(x.CommandLine ?? '') }));
  } catch { return null; }
}
/** macOS／Linux：`ps` 里同样按「命令行含 DeepSeek Harness」筛（与 Windows 的镜像名过滤等价）。 */
function unixAppProcesses() {
  try {
    const r = spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10000 });
    if (r.error || r.status !== 0) return [];
    const out = [];
    for (const line of String(r.stdout ?? '').split('\n')) {
      if (!/DeepSeek Harness/.test(line)) continue;
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
    }
    return out.map((p) => ({ ...p, role: classifyProcessCmd(p.cmd) }));
  } catch { return []; }
}
/**
 * 除本助手与被等的那个 pid 之外，还有哪些**实例级**进程（主进程／host）。
 * **必须排除 process.pid**：助手自己就是用 DSH 的 exe 跑的（ELECTRON_RUN_AS_NODE=1），
 * 镜像名同样是「DeepSeek Harness.exe」—— 不排除自己就会永远判定「另一个实例在跑」，
 * 于是一次也不会执行（1.3.0 的实际故障就是这样：用户关掉 DSH 后助手仍看见自己）。
 * `role:'other'` 是「命令行拿不到」的保守情形（tasklist 回退）：那时把每个同名进程都算上。
 */
function otherInstances(waitedPid, procs = dshProcesses()) {
  const skip = new Set([process.pid]);
  const waited = Number(waitedPid);
  if (Number.isInteger(waited) && waited > 0) skip.add(waited);
  return procs
    .filter((p) => (p.role === 'main' || p.role === 'host' || p.role === 'other') && !skip.has(Number(p.pid)))
    .map((p) => ({ pid: Number(p.pid), role: p.role }));
}
/** 「主进程 12404、host 7944」这样的一句话。 */
function fmtInstances(list) {
  return list.map((p) => `${ROLE_LABEL[p.role] ?? p.role} ${p.pid}`).join('、');
}
/**
 * 只拿到 pid 列表（旧式 tasklist 回退）时的保守判定：把每个 pid 都当成可能的实例。
 * 保留这个函数的形状是为了兼容性（自测 6b 用它锁住「必须排除助手自己」这条）。
 */
function otherDshPids(waitedPid, ids = dshProcessIds()) {
  const skip = new Set([process.pid]);
  const waited = Number(waitedPid);
  if (Number.isInteger(waited) && waited > 0) skip.add(waited);
  return ids.map(Number).filter((id) => Number.isInteger(id) && id > 0 && !skip.has(id));
}
/** 独占认领：同一次启动被重复架设、或多个实例并存时，只有一个助手动手。 */
function claimLock() {
  const now = Date.now();
  try {
    const j = JSON.parse(readFileSync(AUTO_LOCK, 'utf8'));
    if (j && Number.isFinite(j.at) && now - j.at < 10 * 60 * 1000 && pidAlive(j.pid)) return false;
  } catch { /* 无锁或读不出 → 可认领 */ }
  try { writeFileSync(AUTO_LOCK, JSON.stringify({ pid: process.pid, at: now }) + '\n', 'utf8'); return true; } catch { return false; }
}

/**
 * 助手的外壳：任何未预料到的异常都要落成一份报告 + 一行日志，绝不静默消失。
 * 1.3.3 的线上日志里就有「架设了、之后什么都没写、进程不见了」的助手；有了这层，
 * 下一轮启动至少能分辨「它崩了（有 helper-crash 报告 + 错误原文）」还是「它被杀（只有心跳停在某刻）」。
 */
function cmdAutoWait(opts) {
  const fatal = (error) => {
    // 连「报丧」本身都不许再炸：这里每一项都各自 try，兜底只保证退出码非 0。
    try {
      const first = String((error && error.message) || error).split('\n')[0];
      const detail = String((error && error.stack) || error).split('\n').slice(0, 4).join(' | ');
      autoLog(`自动清理：助手异常退出 —— ${first}`);
      writeAutoReport({ at: new Date().toISOString(), ran: false, why: 'helper-crash', error: detail, waitedPid: Number(opts?.pid) || null });
      say(`自动清理：助手异常退出（${first}）。`);
      emit();
    } catch { /* 忽略 */ }
    process.exitCode = 1;
  };
  process.once('uncaughtException', fatal);
  process.once('unhandledRejection', fatal);
  try {
    cmdAutoWaitInner(opts);
  } catch (error) {
    fatal(error);
  }
}

function cmdAutoWaitInner(opts) {
  const pid = Number(opts.pid);
  const arm = readArm();
  if (arm === null || arm.enabled !== true) {
    autoLog(`自动清理：开关关闭（arm=${arm === null ? '缺失' : JSON.stringify({ enabled: arm.enabled })}），未做任何改动`);
    // 也留一份报告：否则面板会一直显示上一轮的结果，看不出「这轮是因为开关关着才没动」。
    writeAutoReport({ at: new Date().toISOString(), ran: false, why: 'disabled' });
    say('自动清理：开关关闭，未做任何改动。');
    emit();
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    autoLog('自动清理：缺少有效的 --pid');
    say('自动清理：需要有效的 --pid <DSH 进程号>。');
    emit();
    process.exitCode = 1;
    return;
  }
  const maxWaitMs = Number.isFinite(Number(arm.maxWaitMs)) && Number(arm.maxWaitMs) > 0 ? Number(arm.maxWaitMs) : AUTO_DEFAULTS.maxWaitMs;
  const t0 = Date.now();
  heartbeat(pid, true);
  autoLog(`自动清理：等 DSH pid=${pid} 退出（上限 ${Math.round(maxWaitMs / 60000)} 分钟）`);
  while (pidAlive(pid)) {
    heartbeat(pid);
    if (Date.now() - t0 > maxWaitMs) {
      autoLog('自动清理：等待超时（DSH 似乎仍在运行），退出');
      writeAutoReport({ at: new Date().toISOString(), ran: false, why: 'timeout', waitedPid: pid, waitedMs: Date.now() - t0 });
      say('自动清理：等待 DSH 退出超时，未做任何改动。');
      emit();
      return;
    }
    sleepSync(2000);
  }
  // 抢锁要有耐心：若上一次退出时留下的助手还占着锁（例如它跑得慢、或它用的是旧版代码），
  // 一见锁就退出等于白白浪费一整轮退出窗口。这里最多等 3 分钟，并每轮重读开关。
  let locked = claimLock();
  for (let i = 0; !locked && i < 90; i++) {
    if (readArm().enabled !== true) {
      autoLog('自动清理：等锁期间开关被关掉，退出');
      writeAutoReport({ at: new Date().toISOString(), ran: false, why: 'disabled' });
      say('自动清理：开关已关闭，退出。');
      emit();
      return;
    }
    heartbeat(pid);
    if (i % 5 === 0) autoLog(`自动清理：已有另一个助手在跑，等它退出（${i + 1}/90）`);
    sleepSync(2000);
    locked = claimLock();
  }
  if (!locked) {
    autoLog('自动清理：另一个助手迟迟不退出，本次放弃');
    writeAutoReport({ at: new Date().toISOString(), ran: false, why: 'lock-busy', waitedPid: pid });
    say('自动清理：已有另一个助手在执行，退出。');
    emit();
    return;
  }
  if (arm.checkOther !== false) {
    // 主进程刚退出时，它的 GPU/渲染子进程可能还残留一两秒 —— 宽限重判，别把这种残留当成「另一个实例」。
    // 注意其它角色（子进程、runner、助手）**不参与判定**：一个实例有五六个同名进程，
    // 全算上就会在「用户已经重新打开 DSH」之外的任何残留里误报（见 otherInstances 的注释）。
    let others = otherInstances(pid);
    for (let i = 0; i < 10 && others.length; i++) {
      autoLog(`自动清理：另见 DSH 实例进程 ${fmtInstances(others)}，1 秒后重判（${i + 1}/10）`);
      heartbeat(pid);
      sleepSync(1000);
      others = otherInstances(pid);
    }
    if (others.length) {
      const pids = others.map((o) => o.pid);
      autoLog(`自动清理：检测到另一个 DSH 实例仍在运行（${fmtInstances(others)}），跳过（下次退出时再来）`);
      writeAutoReport({
        at: new Date().toISOString(), ran: false, why: 'other-dsh-running',
        waitedPid: pid, otherPids: pids, otherRoles: others,
      });
      say(`自动清理：检测到另一个 DSH 实例仍在运行（${fmtInstances(others)}），本次跳过。`);
      emit();
      return;
    }
  }
  const startedAt = new Date();
  const useOpts = {
    workspace: undefined, all: true, apply: true, force: true,
    noVerify: arm.verify === false,
    app: opts.app, asar: opts.asar, modules: opts.modules, noApp: opts.noApp,
  };
  let all = [];
  try {
    all = listSessions();
  } catch (error) {
    // 列会话这一步就炸了也要留痕：否则「助手一声不响地没了」永远查不出原因。
    const first = String((error && error.message) || error).split('\n')[0];
    autoLog(`自动清理：列会话失败 —— ${first}`);
    writeAutoReport({ at: new Date().toISOString(), ran: false, why: 'list-failed', error: first, waitedPid: pid });
    say(`自动清理：列会话失败（${first}），未做任何改动。`);
    emit();
    process.exitCode = 1;
    return;
  }
  const targets = all.filter((s) => s.catalog > 0 || (s.cache.catalogCount ?? 0) > 0);
  say(`自动清理：DSH (pid ${pid}) 已退出，开始处理 ${targets.length} 个会话（${fmtTime(startedAt)}）`);
  if (!targets.length) {
    say('自动清理：没有需要处理的会话。');
    writeAutoReport({ at: startedAt.toISOString(), ran: true, pid, sessions: 0, cleaned: 0, failures: 0, results: [], durationMs: Date.now() - t0 });
    autoLog('自动清理：没有需要处理的会话');
    emit();
    return;
  }
  const app = findApp(useOpts);
  const modules = findModules(useOpts);
  say(`自动清理：真实加载器复核途径 ${app ? `可用（${app.asar}）` : modules ? `可用（${modules}）` : '不可用（未加 --no-verify 将拒绝写入）'}`);
  const results = [];
  for (const s of targets) {
    heartbeat(pid);
    // 单个会话炸掉不该把整轮带走：记成「这一个失败」，其它会话继续。
    let r;
    try {
      r = dismissOne(s, useOpts);
    } catch (error) {
      r = { ok: false, changed: 0, backup: null, why: `抛出异常：${String((error && error.message) || error).split('\n')[0]}` };
    }
    if (r.ok !== true) autoLog(`自动清理：${s.sessionId} 未处理 —— ${r.why ?? '未知原因'}`);
    results.push({ sessionId: s.sessionId, ok: r.ok === true, changed: r.changed ?? 0, backup: r.backup ?? null, why: r.why ?? null });
  }
  const cleaned = results.filter((r) => r.changed > 0).length;
  const failures = results.filter((r) => !r.ok).length;
  writeAutoReport({
    at: startedAt.toISOString(), ran: true, pid, verify: arm.verify !== false,
    sessions: targets.length, cleaned, failures,
    backups: results.map((r) => r.backup).filter(Boolean), results, durationMs: Date.now() - t0,
  });
  autoLog(`自动清理：完成，处理 ${targets.length}，改写 ${cleaned}，失败 ${failures}`);
  say(`自动清理：处理 ${targets.length} 个；改写 ${cleaned} 个；失败 ${failures} 个。备份在 ${BACKUP_ROOT}`);
  emit();
  if (failures) process.exitCode = 1;
}

// ---------------------------------------------------------------- 入口
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const command = (flag('--help') || flag('-h')) ? 'help'
  : (flag('--version') || flag('-V')) ? 'version'
    : (args.find((a) => !a.startsWith('-')) ?? 'list');
function usage() {
  say(`dsh-agent-clean ${VERSION} —— DSH 子代理条目／会话／孤儿缓存清理（node ${process.version}，${process.platform}）`);
  say('');
  say('用法:');
  say(`  ${PROG} list [--workspace <片段>]                   查看各会话的子代理条目数`);
  say(`  ${PROG} dismiss --session <id|前缀> [--apply] [--force] [--no-verify]`);
  say('                                                   去掉子代理条目（非破坏：保留全部行与 seq）');
  say(`  ${PROG} dismiss --all [--workspace <片段>] [--apply]`);
  say(`  ${PROG} purge --session <id|前缀> [--apply] [--force]`);
  say('                                                   彻底删除会话目录 + 全部日志 + 投影缓存（先整份备份）');
  say(`  ${PROG} orphans [--apply]                           列出／删除「没有会话目录」的孤儿投影缓存`);
  say(`  ${PROG} restore --backup <备份目录>                  从备份还原（dismiss／purge／orphans 的备份皆可）`);
  say(`  ${PROG} autowait --pid <DSH 的 pid>                  等该进程退出后自动执行 dismiss --all（供插件调用）`);
  say(`  ${PROG} version | help`);
  say('');
  say('默认皆为「试演」，加 --apply 才真正写入；日志 5 分钟内被写过需 --force。');
  say('复核途径：默认自动找已安装的 DSH 桌面版（Electron 当 node 跑 verify_loader.mjs）；');
  say('  --app/--asar 指定应用，--modules 指定含 @deepseek-ai 的 node_modules，--no-app 不用桌面版；');
  say('  --no-verify 跳过「找不到复核途径」这一关（真实加载器一旦报失败，仍会拒绝写入）。');
  say('改完必须完全退出并重启 DSH。机制与原理见 README.md / README.zh.md。');
  say('');
  say(`DSH_HOME=${DSH_HOME}`);
  say(`备份目录=${BACKUP_ROOT}`);
}
// ---------------------------------------------------------------- 供 GUI 插件（plugin/index.js）复用
// 插件只读地用 listSessions / allSessionIds / readCache / inspect 做「诊断清单」，
// 真正的写操作仍只走本文件的 CLI（必须完全退出 DSH）。
export { DSH_HOME, SESS_ROOT, CACHE_ROOT, STATE_DIR, BACKUP_ROOT, VERSION, CATALOG_TYPE, DISMISS_TYPE };
export { frameLength, frameTexts, inspect, readCache, listSessions, allSessionIds, emptyCatalogState, rebuildDismiss };
export { ARM_FILE, AUTO_REPORT, AUTO_LOG, AUTO_ARMED, AUTO_DEFAULTS, readArm, writeArm, readAutoReport, readArmed, writeArmed, missedRun, pidAlive, cmdAutoWait };
export { dshProcessIds, otherDshPids, dshProcesses, classifyProcessCmd, otherInstances, fmtInstances };
export { AUTO_HEARTBEAT, readHeartbeat, writeHeartbeat };

/** 只有被 `node clean.mjs …`（或包装脚本）直接调用时才跑 CLI；被插件 import 时只导出、不执行。 */
const INVOKED_DIRECTLY = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (INVOKED_DIRECTLY) {
if (!HAS_ZSTD) {
  process.stderr.write(`✗ 需要 Node.js >= 22（内置 zlib 的 zstd）；当前 ${process.version}\n`);
  process.exit(1);
}
try {
  const common = { workspace: opt('--workspace'), app: opt('--app'), asar: opt('--asar'), modules: opt('--modules'), noVerify: flag('--no-verify'), noApp: flag('--no-app') };
  if (command === 'list') cmdList(opt('--workspace'));
  else if (command === 'dismiss') cmdDismiss({ ...common, all: flag('--all'), session: opt('--session'), apply: flag('--apply'), force: flag('--force') });
  else if (command === 'purge') cmdPurge({ ...common, all: flag('--all'), session: opt('--session'), apply: flag('--apply'), force: flag('--force') });
  else if (command === 'orphans') cmdOrphans({ apply: flag('--apply') });
  else if (command === 'strip') cmdStrip({ all: flag('--all'), session: opt('--session'), apply: flag('--apply'), force: flag('--force'), generations: opt('--generations') ?? 'newest' });
  else if (command === 'restore') cmdRestore(opt('--backup'));
  else if (command === 'autowait') cmdAutoWait({ pid: opt('--pid'), app: opt('--app'), asar: opt('--asar'), modules: opt('--modules'), noApp: flag('--no-app') });
  else if (command === 'version' || flag('--version') || flag('-V')) { say(`dsh-agent-clean ${VERSION}  (node ${process.version}, ${process.platform})`); emit(); }
  else {
    usage();
    emit();
    process.exitCode = (command === 'help' || flag('--help') || flag('-h')) ? 0 : 1;
  }
} catch (e) {
  say('✗ 出错: ' + (e && e.stack ? e.stack : String(e)));
  emit();
  process.exitCode = 1;
}
}  // if (INVOKED_DIRECTLY)
