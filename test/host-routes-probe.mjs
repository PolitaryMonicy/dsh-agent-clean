/**
 * 宿主半的离线探针（不启动 DSH、不碰会话存储）。
 *
 * 覆盖：
 *  - apply() 按开关「架设」助手（DSAC_ARM_DRYRUN=1 ⇒ 只登记状态，不开真进程）；
 *  - 两条路由都注册在正确的路径上；
 *  - 信任栅栏：同源放行、跨站/非环回 Host 403；
 *  - GET /settings 回开关 + 上次报告；POST 的三种坏体（非 JSON、非对象、无可写字段）回 400；
 *  - POST {enabled:false} / {enabled:true,verify:false} 落盘并回新状态；
 *  - scan 的返回体带 `auto` 段与 cliPath/backupRoot。
 *
 * 写盘只写 auto-arm.json（同目录先备份、跑完还原），绝不调用 clean.mjs 的任何命令。
 * 用法：node test/host-routes-probe.mjs
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const ARM_FILE = join(PKG_ROOT, 'auto-arm.json')
const OUT_FILE = join(process.env.TEMP || process.env.TMP || PKG_ROOT, 'dsh-agent-clean-host-probe.txt')

const lines = []
const say = (s) => { lines.push(s); console.log(s) }

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  return ok
}

/** 备份真实状态文件（探针结束还原），避免把用户的开关设成测试值。 */
const hadArm = existsSync(ARM_FILE)
const armBackup = hadArm ? readFileSync(ARM_FILE) : null
function restore() {
  try {
    if (hadArm) writeFileSync(ARM_FILE, armBackup)
    else if (existsSync(ARM_FILE)) rmSync(ARM_FILE)
  } catch { /* 忽略 */ }
}

/** 极简 res：收 writeHead 的状态码与 end 的 body。 */
function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    ended: false,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; return res },
    end(body) { res.body = String(body ?? ''); res.ended = true; if (res.onEnd) res.onEnd() },
  }
  return res
}

/** 极简 req：EventEmitter + headers/method。 */
function makeReq({ method = 'GET', headers = {}, body = undefined }) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req.destroy = () => { }
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(body, 'utf8'))
      req.emit('end')
    })
  } else if (method === 'POST') {
    process.nextTick(() => req.emit('end'))
  }
  return req
}

async function call(handler, opts) {
  const req = makeReq(opts)
  const res = makeRes()
  const done = new Promise((resolve) => { res.onEnd = resolve })
  await handler(req, res)
  await Promise.race([done, new Promise((r) => setTimeout(r, 200))])
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.statusCode, json, raw: res.body }
}

const LOOPBACK = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
const HOSTILE = { host: 'evil.example', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }

async function main() {
  // 先落一个明确的开关状态（探针自己负责还原）。
  mkdirSync(dirname(ARM_FILE), { recursive: true })
  writeFileSync(ARM_FILE, JSON.stringify({ enabled: true, verify: true }, null, 2) + '\n', 'utf8')
  process.env.DSAC_ARM_DRYRUN = '1'

  const routes = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => { fn(); return () => { } },
    webServer: { register: (r) => routes.push(r) },
  }

  const mod = await import(pathToFileURL(join(PKG_ROOT, 'plugin', 'index.js')).href)
  mod.apply(ctx)

  const scan = routes.find((r) => r.path === mod.SCAN_ROUTE)
  const settings = routes.find((r) => r.path === mod.SETTINGS_ROUTE)
  check('注册了 scan 路由', scan !== undefined && typeof scan.handler === 'function', mod.SCAN_ROUTE)
  check('注册了 settings 路由', settings !== undefined && typeof settings.handler === 'function', mod.SETTINGS_ROUTE)
  check('路由 kind=exact', scan?.kind === 'exact' && settings?.kind === 'exact')
  check('两条路由都是新注册（无重复）', routes.length === 2, `routes=${routes.length}`)

  // 栅栏
  const blocked = await call(scan.handler, { method: 'GET', headers: HOSTILE })
  check('跨站/非环回 Host 被拒（403）', blocked.status === 403 && blocked.json?.ok === false, `status=${blocked.status}`)
  const methodBad = await call(scan.handler, { method: 'DELETE', headers: LOOPBACK })
  check('非法方法被拒（405）', methodBad.status === 405, `status=${methodBad.status}`)

  // scan
  const s = await call(scan.handler, { method: 'GET', headers: LOOPBACK })
  check('scan 返回 200/ok', s.status === 200 && s.json?.ok === true, `status=${s.status}`)
  const v = s.json?.value ?? {}
  check('scan 带 auto 段（开关默认启用）', v.auto?.settings?.enabled === true, JSON.stringify(v.auto?.settings ?? null))
  check('scan 带 cliPath / backupRoot', typeof v.cliPath === 'string' && typeof v.backupRoot === 'string', v.cliPath)
  check('scan 能列出会话', Number.isInteger(v.total) && Array.isArray(v.sessions), `total=${v.total}`)
  check('auto.lastAuto 允许为 null', v.auto?.lastAuto === null || typeof v.auto?.lastAuto === 'object')
  check('auto 带「上一轮有没有跑完」的判定位', 'lastMissed' in (v.auto ?? {}), JSON.stringify(v.auto?.lastMissed ?? null))
  check('auto 带助手记录文件路径', typeof v.auto?.armedFile === 'string' && v.auto.armedFile.endsWith('auto-armed.json'), v.auto?.armedFile)
  // 1.3.4：面板要说清「本轮是谁在等谁」以及那个助手最后一次活着是什么时候 ——
  // 只凭 auto-armed.json，用户看到「架设于 X，现已不在」会读成「架设完就死了」。
  check('auto 带本轮助手记录与心跳',
    ('armed' in (v.auto ?? {})) && ('heartbeat' in (v.auto ?? {})),
    JSON.stringify({ armed: v.auto?.armed ?? null, heartbeat: v.auto?.heartbeat ?? null }))

  // settings: GET
  const g = await call(settings.handler, { method: 'GET', headers: LOOPBACK })
  check('GET /settings 200/ok', g.status === 200 && g.json?.ok === true, `status=${g.status}`)
  check('GET /settings 回 explicit=true（文件已存在）', g.json?.value?.explicit === true)

  // settings: 坏体
  const bad1 = await call(settings.handler, { method: 'POST', headers: LOOPBACK, body: 'not json' })
  check('POST 非 JSON → 400 bad-body', bad1.status === 400 && bad1.json?.error?.code === 'bad-body', `status=${bad1.status}`)
  const bad2 = await call(settings.handler, { method: 'POST', headers: LOOPBACK, body: '[1,2]' })
  check('POST 数组 → 400 bad-body', bad2.status === 400 && bad2.json?.error?.code === 'bad-body', `status=${bad2.status}`)
  const bad3 = await call(settings.handler, { method: 'POST', headers: LOOPBACK, body: '{"foo":1}' })
  check('POST 无可写字段 → 400 no-known-field', bad3.status === 400 && bad3.json?.error?.code === 'no-known-field', `status=${bad3.status}`)
  const hostile = await call(settings.handler, { method: 'POST', headers: HOSTILE, body: '{"enabled":false}' })
  check('POST 跨站 → 403（且不写盘）', hostile.status === 403, `status=${hostile.status}`)

  // settings: 关掉
  const off = await call(settings.handler, { method: 'POST', headers: LOOPBACK, body: '{"enabled":false}' })
  check('POST {enabled:false} → 200 且落盘', off.status === 200 && off.json?.value?.settings?.enabled === false, `status=${off.status}`)
  const onDisk = JSON.parse(readFileSync(ARM_FILE, 'utf8').replace(/^\uFEFF/, ''))
  check('auto-arm.json 内容已更新', onDisk.enabled === false && typeof onDisk.updatedAt === 'string', JSON.stringify(onDisk))

  // settings: 打开（助手已在 apply 时登记过 ⇒ justArmed=false；verify:false 生效）
  const on = await call(settings.handler, { method: 'POST', headers: LOOPBACK, body: '{"enabled":true,"verify":false,"maxWaitMs":60000}' })
  check('POST {enabled:true,verify:false,maxWaitMs} → 200', on.status === 200 && on.json?.value?.settings?.enabled === true, `status=${on.status}`)
  check('verify 与 maxWaitMs 落盘', on.json?.value?.settings?.verify === false && on.json?.value?.settings?.maxWaitMs === 60000, JSON.stringify(on.json?.value?.settings))
  check('apply 时已登记助手（DRYRUN）', on.json?.value?.armed === true)
  check('重复架设不叠进程（justArmed=false）', on.json?.value?.justArmed === false)

  const scan2 = await call(scan.handler, { method: 'GET', headers: LOOPBACK })
  check('再次 scan 反映新开关', scan2.json?.value?.auto?.settings?.verify === false)
  return failures
}

let code = 1
try {
  const fails = await main()
  say(`VERDICT ${fails === 0 ? 'PASS' : 'FAIL'}  (${fails} 项失败)`)
  code = fails === 0 ? 0 : 1
} catch (error) {
  say('探针自身出错：' + String((error && error.stack) || error))
  code = 1
} finally {
  restore()
  try { writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8') } catch { /* 忽略 */ }
  say(`输出已写入 ${OUT_FILE}`)
}
process.exit(code)
