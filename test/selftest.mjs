#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dsh-agent-clean 端到端自测（不碰你的真实 DSH_HOME）
//
// 做法：在一个临时目录里造一个假的 DSH_HOME，写几份「像真的」的会话日志（zstd 帧 + JSON 行）
// 与投影缓存，然后真的去跑 clean.mjs 的 list / orphans / purge / restore / dismiss，
// 断言：孤儿缓存被正确认出并备份后删除、purge 后能整份还原、dismiss 只动自己的 catalog 行
// 且其余行逐字节不变、缓存被改成合法空状态。
//
// 用法:
//   node test/selftest.mjs
//   node test/selftest.mjs --fixture <某份真实 session.v4.jsonl.zstd> [--expect-sha256 <hex>]
//       ↑ 额外用真实日志跑一遍 dismiss，并（若给了 --expect-sha256）核对产物 sha256
// 退出码：0 = 全部通过；1 = 有断言失败。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(HERE, '..', 'clean.mjs');
const argv = process.argv.slice(2);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const FIXTURE = argVal('--fixture');
const EXPECT_SHA = argVal('--expect-sha256');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail && !ok ? `  —— ${detail}` : ''}`);
}
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
// 注意：zlib.zstdDecompressSync 只解第一帧，而真实日志是多帧拼起来的 —— 这里逐帧解出再合并。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const linesOf = (p) => {
  const buf = fs.readFileSync(p);
  const offsets = [];
  for (let i = buf.indexOf(ZSTD_MAGIC); i >= 0; i = buf.indexOf(ZSTD_MAGIC, i + 4)) offsets.push(i);
  if (!offsets.length) throw new Error(`不是 zstd 文件: ${p}`);
  let text = '';
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    text += zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8');
  }
  return text.split('\n').filter((l) => l !== '');
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsac-selftest-'));
const HOME = path.join(tmp, 'home');
const SESS = path.join(HOME, 'sessions');
const CACHE = path.join(HOME, 'storages', 'session_projcache', 'sessions');
const BACKUPS = path.join(tmp, 'backups');
const PROJ = '-C-Users-Test-selftest--';
const A = 'session-aaaa1111-1111-1111-1111-111111111111'; // dismiss 目标
const B = 'session-bbbb2222-2222-2222-2222-222222222222'; // 只留孤儿缓存
const C = 'session-cccc3333-3333-3333-3333-333333333333'; // purge 目标
// 子代理会话的目录名是**裸 uuid**（没有 `session-` 前缀）——曾经被孤儿判定漏掉，
// 导致 orphans --apply 会删掉还活着的子代理会话的投影缓存（本用例是那次的回归测试）。
const CHILD = 'dddd5555-5555-5555-5555-555555555555';

fs.mkdirSync(CACHE, { recursive: true });
const catRow = JSON.stringify({ seq: 2, type: 'subagent/catalog', ignorable: false, data: { childId: 'x1', label: 'demo child' } });
const catRow2 = JSON.stringify({ seq: 4, type: 'subagent/catalog', ignorable: false, data: { childId: 'x2', label: 'demo child 2' } });
const metaRow = JSON.stringify({ seq: 0, type: 'session/created', data: { cwd: 'C:\\Users\\Test' } });
const msgRow = JSON.stringify({ seq: 1, type: 'message/user', data: { text: 'hello' } });
const tailRow = JSON.stringify({ seq: 3, type: 'session-log-deepseek/delivery-accepted', data: { sessionId: A, sessionFormatVersion: 4, throughSeq: 1 } });
// 第 0 行按真实格式是 header（没有 seq），事件从第 1 行起、seq 从 0 起。
const headerRow = (id) => JSON.stringify({ sessionFormatVersion: 4, id, createdAt: '2026-01-01T00:00:00.000Z' });

function mkProject(name) { fs.mkdirSync(path.join(SESS, PROJ, name), { recursive: true }); return path.join(SESS, PROJ, name); }
function mkCache(id, title, catalogValues) {
  const j = {
    version: 7,
    record: {
      identity: { sessionId: id, inheritedEventCount: 0 },
      rows: {
        title: { seq: 0, val: title },
        subagentCatalog: { seq: 2, val: catalogValues ? { head: { values: catalogValues, lastSeq: 2 } } : {} },
      },
    },
  };
  const p = path.join(CACHE, id + '.json');
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
  return p;
}

const dirA = mkProject(A);
const logA = path.join(dirA, 'session.v4.jsonl.zstd');
fs.writeFileSync(logA, Buffer.concat([frame([headerRow(A), metaRow, msgRow, catRow]), frame([tailRow, catRow2])]));
const cacheA = mkCache(A, '自测会话 A', [{ label: 'demo child', childId: 'x1' }, { label: 'demo child 2', childId: 'x2' }]);
const dirC = mkProject(C);
const logC = path.join(dirC, 'session.v3.jsonl.zstd');
fs.writeFileSync(logC, frame([metaRow]));
const logC4 = path.join(dirC, 'session.v4.jsonl.zstd');
fs.writeFileSync(logC4, frame([metaRow, msgRow]));
const cacheC = mkCache(C, '自测会话 C', null);
const orphanPath = mkCache(B, '无目录的孤儿会话 B', [{ label: 'orphan child', childId: 'o1' }]);
const dirChild = mkProject(CHILD);
const logChild = path.join(dirChild, 'session.v4.jsonl.zstd');
fs.writeFileSync(logChild, Buffer.concat([frame([headerRow(CHILD), metaRow, msgRow])]));
const cacheChild = mkCache(CHILD, '子代理会话（目录名无 session- 前缀）', null);

console.log(`临时 DSH_HOME: ${HOME}`);
console.log(`（真实 DSH_HOME 与真实备份目录都不会被碰）\n`);

function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLEAN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: HOME, DSAC_BACKUP_DIR: BACKUPS, ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---- 1. list ---------------------------------------------------------------
console.log('1) list');
let r = run(['list']);
check('list 退出码 0', r.code === 0, `code=${r.code}`);
check('list 认出 1 个含条目的会话', /共 3 个会话，其中 1 个含/.test(r.out), r.out.split('\n')[0]);
check('list 显示日志中 2 条', /日志中 2 条/.test(r.out), r.out.match(/条目.*$/m)?.[0]);

// ---- 2. orphans ------------------------------------------------------------
console.log('\n2) orphans');
r = run(['orphans']);
check('试演认出 1 个孤儿', /孤儿 1 个/.test(r.out) && r.out.includes(B), r.out.split('\n')[0]);
check('试演不动文件', fs.existsSync(orphanPath));
r = run(['orphans', '--apply']);
check('orphans --apply 退出码 0', r.code === 0, `code=${r.code}`);
check('孤儿缓存已删除', !fs.existsSync(orphanPath));
const orphanBak = fs.readdirSync(BACKUPS).map((n) => path.join(BACKUPS, n)).filter((p) => p.endsWith('_orphans'))[0];
check('孤儿缓存有备份 + manifest', Boolean(orphanBak) && fs.existsSync(path.join(orphanBak, 'manifest.json')) && fs.existsSync(path.join(orphanBak, B + '.json')), String(orphanBak));
check('有目录的缓存未被误删', fs.existsSync(cacheA) && fs.existsSync(cacheC));
check('子代理会话（裸 uuid 目录）的缓存不算孤儿', fs.existsSync(cacheChild));

// ---- 3. purge / restore ----------------------------------------------------
console.log('\n3) purge / restore');
r = run(['purge', '--session', 'cccc3333']);
check('purge 试演不删', fs.existsSync(dirC) && fs.existsSync(cacheC) && /试演/.test(r.out));
const logC4Sha = sha256(logC4);
r = run(['purge', '--session', 'cccc3333', '--apply', '--force']);
check('purge --apply 退出码 0', r.code === 0, `code=${r.code}`);
check('会话目录已删除', !fs.existsSync(dirC));
check('投影缓存已删除', !fs.existsSync(cacheC));
const purgeBak = fs.readdirSync(BACKUPS).map((n) => path.join(BACKUPS, n)).find((p) => p.endsWith('_purge_' + 'cccc3333'));
check('purge 备份含全部 generation 日志', Boolean(purgeBak) && fs.existsSync(path.join(purgeBak, 'session.v3.jsonl.zstd')) && fs.existsSync(path.join(purgeBak, 'session.v4.jsonl.zstd')));
r = run(['restore', '--backup', purgeBak]);
check('restore 退出码 0', r.code === 0, `code=${r.code}`);
check('restore 还原目录与两个日志', fs.existsSync(logC) && fs.existsSync(logC4));
check('restore 后 v4 日志逐字节相同', sha256(logC4) === logC4Sha);
check('restore 还原投影缓存', fs.existsSync(cacheC));

// ---- 4. dismiss：安全闸（没有真实加载器时应拒绝写入） ----------------------
console.log('\n4) dismiss 安全闸');
const logAShaBefore = sha256(logA);
r = run(['dismiss', '--session', 'aaaa1111', '--apply', '--force']);
const wroteWithoutVerify = sha256(logA) !== logAShaBefore;
check('无真实加载器时拒绝写入（或确实通过真实加载器校验）',
  r.code !== 0 ? !wroteWithoutVerify : /真实加载器自检\([^)]*\): OK/.test(r.out),
  `code=${r.code} wrote=${wroteWithoutVerify}\n${r.out}`);
check('拒绝时给出可操作的提示', r.code !== 0 ? /--no-verify|未通过|未找到|分钟前/.test(r.out) : true);

// ---- 5. dismiss --no-verify：离线变换正确性 --------------------------------
console.log('\n5) dismiss --no-verify');
const beforeLines = linesOf(logA);
// --no-app：不用已安装的桌面版做复核（否则它会去加载这份「自造的」日志并报失败）。
r = run(['dismiss', '--session', 'aaaa1111', '--apply', '--force', '--no-app', '--no-verify']);
const afterLines = linesOf(logA);
check('dismiss --no-verify 有输出且未抛错', !/✗ 出错/.test(r.out), r.out.slice(0, 200));
check('行数不变（不删行）', afterLines.length === beforeLines.length, `${beforeLines.length} -> ${afterLines.length}`);
check('seq 保持稠密且不变', JSON.stringify(afterLines.map((l) => JSON.parse(l).seq)) === JSON.stringify(beforeLines.map((l) => JSON.parse(l).seq)));
const changedIdx = afterLines.map((l, i) => (l === beforeLines[i] ? -1 : i)).filter((i) => i >= 0);
check('只有 catalog 行发生变化', changedIdx.length === 2, `changed=${JSON.stringify(changedIdx)}`);
const retyped = changedIdx.length ? JSON.parse(afterLines[changedIdx[0]]) : {};
check('改动是「改成 dismissed + ignorable:true」', retyped.type === 'subagent/catalog-dismissed' && retyped.ignorable === true, JSON.stringify(retyped));
check('原 catalog 内容仍留在行里', changedIdx.length ? afterLines[changedIdx[0]].includes('demo child') : false);
const cacheAfter = JSON.parse(fs.readFileSync(cacheA, 'utf8'));
check('投影缓存被改成合法空状态', JSON.stringify(cacheAfter.record.rows.subagentCatalog.val) === '{"inheritedEventCount":0}', JSON.stringify(cacheAfter.record.rows.subagentCatalog.val));
const dismissBak = fs.readdirSync(BACKUPS).map((n) => path.join(BACKUPS, n)).find((p) => p.includes('_dismiss_'));
check('dismiss 有整份备份 + manifest', Boolean(dismissBak) && fs.existsSync(path.join(dismissBak, 'manifest.json')) && fs.existsSync(path.join(dismissBak, 'session.v4.jsonl.zstd')));

// ---- 6. restore 掉 dismiss 的结果 ------------------------------------------
console.log('\n6) restore（回到 dismiss 之前）');
r = run(['restore', '--backup', dismissBak]);
check('restore 退出码 0', r.code === 0, `code=${r.code}`);
check('日志回到逐字节相同', sha256(logA) === logAShaBefore, `${sha256(logA)} != ${logAShaBefore}`);
check('缓存也回到原样（含 2 条）', JSON.parse(fs.readFileSync(cacheA, 'utf8')).record.rows.subagentCatalog.val.head.values.length === 2);

// ---- 7. 可选：真实日志的 dismiss 回归 --------------------------------------
if (FIXTURE) {
  console.log('\n7) 真实日志 fixture 回归');
  // 会话目录名尽量沿用 fixture 所在目录名：真实会话目录名与日志 header.id 相同，
  // 这样连「真实加载器」复核也能一起做（manifest 的 delivery sessionId 校验依赖这个相等关系）。
  const parentName = path.basename(path.dirname(path.resolve(FIXTURE)));
  const fxId = /^session-[0-9a-f-]{36}$/.test(parentName) ? parentName : 'session-dddd4444-4444-4444-4444-444444444444';
  const dirD = mkProject(fxId);
  const logD = path.join(dirD, 'session.v4.jsonl.zstd');
  fs.copyFileSync(FIXTURE, logD);
  const short = fxId.replace(/^session-/, '').slice(0, 8);
  // --no-app --no-verify：fixture 来自别的机器/别的路径，真实加载器会校验「header.id 与路径推出的
  // 身份一致」，在假 home 里必然对不上，所以这一步只测「离线变换」本身（见 README 的机制说明）。
  r = run(['dismiss', '--session', short, '--apply', '--force', '--no-app', '--no-verify']);
  check('fixture dismiss 跑完', !/✗ 出错/.test(r.out), r.out.slice(0, 800));
  check('fixture 的自己的 catalog 已清零', /复核\(盘上\): \d+ 行，自己的 catalog 0 条/.test(r.out), r.out.slice(-900));
  if (EXPECT_SHA) check(`产物 sha256 == ${EXPECT_SHA}`, sha256(logD) === EXPECT_SHA.toUpperCase(), sha256(logD));
}

// ---- 收尾 ------------------------------------------------------------------
const failed = results.filter((x) => !x.ok);
console.log(`\n===== 自测结果: ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { for (const f of failed) console.log(`  ✗ ${f.name}`); process.exitCode = 1; }
try { fs.rmSync(tmp, { recursive: true, force: true }); console.log(`已清理临时目录 ${tmp}`); } catch { /* 忽略 */ }
