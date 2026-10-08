/**
 * dsh-agent-clean —— DSH 宿主半（诊断 + 自动清理的「架设」端）
 *
 * 做三件事：
 *  1. 把 CLI 的**只读**扫描（会话、子代理条目数、孤儿投影缓存）通过一条自带信任
 *     栅栏的 HTTP 路由暴露给面板（`SCAN_ROUTE`）；
 *  2. 读写开关（`SETTINGS_ROUTE`）：开关与上次自动清理的报告都存本包状态目录的
 *     `auto-arm.json` / `auto-report.json`（CLI 与插件共用同一份形状）；
 *  3. 开关打开时，启动期间**架设一个脱离的助手进程**（`clean.mjs autowait --pid <本进程>`）。
 *     助手等本进程消失（＝DSH 已完全退出）之后才动盘，走的仍是 `dismiss --all` 的同一条
 *     管线（逐会话整份备份 → 结构自检 → 真实加载器复核）。
 *
 * 为什么清理必须等到退出：DSH 的契约不允许在运行中改写已提交的事件（`dsh-session-persistence`
 * README：「Committed events are never rewritten」，seq 必须自 0 起稠密、单写者），
 * 投影缓存也没有失效 API（`dsh-session-projection-cache`：「No eviction or retention
 * surface」，且该存储域被缓存自己 already-open）。运行中即便写盘成功，宿主内存里的旧值仍在。
 * ⇒ **本插件在运行中绝不碰会话存储**：它自己只写状态目录里的两个小 JSON，真正的改写
 * 由退出后的助手完成（等同用户手敲 `clean.mjs dismiss --all --apply`）。
 *
 * 复用的是同一个包里的 `../clean.mjs`（已逐字节验证过的实现），不另写一套扫描逻辑。
 * clean.mjs 里有「直接被调用才跑 CLI」的守卫，import 它不会执行任何命令。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARM_FILE,
  AUTO_ARMED,
  AUTO_DEFAULTS,
  CACHE_ROOT,
  DSH_HOME,
  SESS_ROOT,
  VERSION,
  allSessionIds,
  listSessions,
  missedRun,
  pidAlive,
  readArm,
  readArmed,
  readAutoReport,
  readCache,
  readHeartbeat,
  writeArm,
  writeArmed,
} from '../clean.mjs'

/** cordis 插件名（`cordis.patch.yml` 里写的 `name` 是**包名**，两者可以不同）。 */
export const name = 'dsh-agent-clean'

/** 唯一的硬依赖：注册 HTTP 路由。其余服务一律 `ctx.get` 探测（cordis 没有「可选依赖」，
 *  注入一个宿主没有的服务会让 fiber 卡住并使**整个 web 启动失败**）。 */
export const inject = ['webServer']

/** 客户端面板轮询的路径。 */
export const SCAN_ROUTE = '/plugins/dsh-agent-clean/scan'

/** 开关（自动清理）与「上次自动清理报告」的读写路径。 */
export const SETTINGS_ROUTE = '/plugins/dsh-agent-clean/settings'

/** POST 体上限（这里只可能收到 {"enabled":false} 这种小对象）。 */
const BODY_LIMIT = 8192

/** 一次回给面板的会话上限（超出时置 truncated，面板会提示收窄工作区）。 */
const MAX_SESSIONS = 300

/** 本包根目录（= 插件安装目录），用来告诉面板「清理命令」该指向哪个包装脚本。 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 宿主半的失败日志。桌面版的宿主 stdout 是控制台（看不到），而 Loader 的
 * 「did not activate」告警也只写到 stderr，所以加载/注册失败时**额外落一份盘**，
 * 让面板和用户都能找到原因。只在失败时写。
 */
const HOST_LOG = join(tmpdir(), 'dsh-agent-clean-host.log')

function trace(message) {
  try {
    appendFileSync(HOST_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 只读环境：忽略 */
  }
}

/**
 * 取宿主自己的 `connection` 服务。**绝不要写 `ctx.get?.('connection') ?? ctx.connection`**：
 * cordis 的 Context 代理对「已注册但本 fiber 未注入」的服务属性会抛
 * `cannot get property "connection" without inject`（本插件 v1.1.0 就是死在
 * `plugin/index.js:181` 这一句上，apply 中断 ⇒ 路由 404，而客户端半照常显示）。
 * 反射式的 `ctx.get()` 在服务缺失时安静地返回 undefined，所以只用它。
 */
function readConnection(ctx) {
  try {
    const viaGet = ctx.get?.('connection')
    if (viaGet !== undefined) return viaGet
  } catch {
    /* 老内核或代理差异：忽略，退回同源栅栏 */
  }
  return undefined
}

/** 统一的 JSON 信封：{ok:true,value} / {ok:false,error}（与 chat-manager 等插件一致）。 */
function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = JSON.stringify({ ok: false, error: { code: 'encode-failed', message: String(error) } })
    status = 500
  }
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    /* 客户端已断开，忽略 */
  }
}

/**
 * 信任栅栏。优先用宿主自己的（`connection.requestRejection`）——桌面版会把
 * `dsh-app://` 请求转发过来且**不带 Origin**，纯同源检查会把它们全部拒掉；
 * 老内核没有这个服务时退回「Host 必须是环回地址 + 非跨站 + Origin 同源」。
 * 这是防 DNS-rebinding／跨站的护栏，不是身份认证。
 */
function makeFence(connection) {
  if (typeof connection?.requestRejection === 'function') {
    return (req) => {
      try {
        return connection.requestRejection(req) === undefined
      } catch {
        return false
      }
    }
  }
  return (req) => {
    const headers = req?.headers ?? {}
    const host = headers.host
    if (typeof host !== 'string' || host.length === 0) return false
    if (headers['sec-fetch-site'] === 'cross-site') return false
    let hostUrl
    try {
      hostUrl = new URL(`http://${host}`)
    } catch {
      return false
    }
    const hostname = hostUrl.hostname
    const loopback = hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    if (!loopback) return false
    const origin = headers.origin
    if (origin === undefined || origin === 'null') return true
    try {
      return new URL(origin).host === hostUrl.host
    } catch {
      return false
    }
  }
}

/**
 * 读一个小的 JSON 请求体。解析不了（或超限）就回 undefined —— 调用方会回 400，
 * 不做任何写操作。
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        finish(undefined)
        try { req.destroy() } catch { /* 忽略 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return finish({})
      try { finish(JSON.parse(text)) } catch { finish(undefined) }
    })
    req.on('error', () => finish(undefined))
  })
}

/**
 * 启动瞬间先看一眼上一轮：上次架设的助手有没有收尾（被系统/工具一起杀掉的话，
 * 退出窗口里什么都不会发生，盘上也没有报告 —— 那就是静默失败，必须在设置页说明）。
 * **必须在架设本轮助手之前算**：架设会覆盖 auto-armed.json，把记录换成本轮。
 */
const startMissed = missedRun(process.pid)

/**
 * 开关现状 + 上次自动清理报告。开关默认**启用**（用户要求：人工清理反正也要重启，
 * 自动更省事），所以 arm 文件还没生成时按默认值显示。
 */
function autoState() {
  const stored = readArm()
  return {
    settings: stored ?? AUTO_DEFAULTS,
    explicit: stored !== null,
    armFile: ARM_FILE,
    armedFile: AUTO_ARMED,
    lastAuto: readAutoReport(),
    lastMissed: startMissed,
    // 本轮是谁在等谁 + 它最后一次心跳：设置页据此说明「助手还活着」还是「已经没了」。
    armed: readArmed(),
    heartbeat: readHeartbeat(),
  }
}

/** 同一个宿主进程只架设一个助手（面板反复开关也不会叠出第二个）。 */
let helperArmed = false

/**
 * 架设脱离的助手：`clean.mjs autowait --pid <本进程>`。
 *
 * - `detached` + `stdio:'ignore'` + `unref()` ⇒ 助手不随 DSH 退出而消失，也不占管道；
 * - `ELECTRON_RUN_AS_NODE=1` **必须设**：宿主里 `process.execPath` 是 Electron 可执行文件，
 *   不设这个变量就会另开一个 GUI 实例（而不是跑 Node 脚本）；
 * - 助手只在 `auto-arm.json` 的 `enabled === true` 时才真正动手，所以「关掉开关」不需要
 *   去杀任何进程：已在等待的助手醒来后会自己读到关闭状态并原样退出。
 */
function armHelper(reason) {
  if (helperArmed) return false
  const arm = readArm() ?? writeArm({})
  if (arm.enabled !== true) return false
  // 宿主进程重启过、而上一轮那个助手还在等同一个 pid 时，不要再架一个：
  // 1.3.3 的实测日志里同一个 pid 被架设了两次（09:18 与 09:29），两个助手都在等同一个退出窗口。
  const prev = readArmed()
  if (prev && Number(prev.waitedPid) === Number(process.pid) && pidAlive(prev.helperPid)) {
    helperArmed = true
    trace(`auto-clean helper already waiting for pid ${process.pid} (pid ${prev.helperPid})`)
    return false
  }
  // 离线探针用的开关：只登记状态、不真的开进程（否则测试跑完会留下一个真在等 pid 的助手）。
  if (process.env.DSAC_ARM_DRYRUN === '1') {
    helperArmed = true
    return true
  }
  try {
    const child = spawn(process.execPath, [join(PKG_ROOT, 'clean.mjs'), 'autowait', '--pid', String(process.pid)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    // 没有这个监听器，ENOENT（clean.mjs 不在）会变成**未捕获异常**，把宿主进程带下去。
    child.on('error', (error) => {
      helperArmed = false
      trace(`auto-clean helper spawn error: ${String(error)}`)
    })
    child.unref()
    // 记下「本轮是谁在等谁」：助手若在退出窗口里被杀，下次启动就能据此提示「上一轮没跑完」。
    writeArmed({ waitedPid: process.pid, helperPid: child.pid ?? null, at: new Date().toISOString(), version: VERSION })
    helperArmed = true
    console.info(`[dsh-agent-clean] auto-clean helper armed for pid ${process.pid} (${reason})`)
    trace(`auto-clean helper armed for pid ${process.pid} (${reason})`)
    return true
  } catch (error) {
    trace(`auto-clean helper failed to arm (${reason}): ${String(error)}`)
    return false
  }
}

/** 「目录已被删、投影缓存还在」的残骸：`session_projcache/sessions/*.json` 里没有会话目录的那些。 */
function orphanCaches() {
  const known = new Set(allSessionIds())
  if (!existsSync(CACHE_ROOT)) return []
  const out = []
  for (const name of readdirSync(CACHE_ROOT)) {
    if (!name.endsWith('.json')) continue
    const sessionId = name.slice(0, -'.json'.length)
    if (known.has(sessionId)) continue
    const path = join(CACHE_ROOT, name)
    let size = 0
    let mtime = ''
    try {
      const st = statSync(path)
      size = st.size
      mtime = st.mtime.toISOString()
    } catch {
      /* 竞态：刚好被删 */
    }
    const cache = readCache(path)
    out.push({
      sessionId,
      path,
      size,
      mtime,
      title: typeof cache?.title === 'string' ? cache.title : '',
      catalogCount: cache?.catalogCount ?? null,
      broken: cache?.broken ?? '',
    })
  }
  return out.sort((a, b) => b.size - a.size)
}

/** 只读扫描（绝不写盘）。 */
export function scan() {
  const sessions = listSessions(undefined).map((s) => ({
    sessionId: s.sessionId,
    workspace: s.projectLabel,
    dir: s.dir,
    log: s.logName,
    generation: s.generation,
    size: s.size,
    mtime: s.mtime instanceof Date ? s.mtime.toISOString() : String(s.mtime),
    frames: s.frames,
    rows: s.rows,
    catalog: s.catalog,
    broken: s.broken || '',
    cacheTitle: typeof s.cache?.title === 'string' ? s.cache.title : '',
    cacheCatalogCount: s.cache?.catalogCount ?? null,
    inherited: s.cache?.inherited ?? 0,
    cachePath: s.cachePath || '',
  }))
  sessions.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  return {
    version: VERSION,
    dshHome: DSH_HOME,
    sessionsRoot: SESS_ROOT,
    cacheRoot: CACHE_ROOT,
    platform: process.platform,
    cliPath: join(PKG_ROOT, process.platform === 'win32' ? 'clean.cmd' : 'clean.sh'),
    scriptPath: join(PKG_ROOT, 'clean.mjs'),
    backupRoot: join(PKG_ROOT, 'backups'),
    scannedAt: new Date().toISOString(),
    total: sessions.length,
    withEntries: sessions.filter((s) => (s.catalog ?? 0) > 0).length,
    truncated: sessions.length > MAX_SESSIONS,
    sessions: sessions.slice(0, MAX_SESSIONS),
    orphanCaches: orphanCaches(),
    auto: autoState(),
  }
}

/**
 * 插件体。`apply` 注册两条路由，并按开关架设退出后的自动清理助手；**不碰会话存储**。
 * @param ctx - cordis 上下文（至少含 `webServer`）。
 */
export function apply(ctx) {
  // 与 sidebar-qa 同样的理由：fiber 卡住时不会打任何日志，所以这一行是「插件到底有没有跑起来」的唯一信号。
  console.info(`[dsh-agent-clean] host half applied (v${VERSION})`)

  try {
    const connection = readConnection(ctx)
    const isTrustedRequest = makeFence(connection)

    const guard = (req, res) => {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求未通过同源校验。' } })
        return false
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只允许 GET／HEAD／POST。' } })
        return false
      }
      return true
    }

    const scanHandler = (req, res) => {
      if (!guard(req, res)) return
      try {
        sendJson(res, 200, { ok: true, value: scan() })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: { code: 'scan-failed', message: String((error && error.message) || error) },
        })
      }
    }

    const settingsHandler = async (req, res) => {
      if (!guard(req, res)) return
      try {
        if (req.method !== 'POST') {
          sendJson(res, 200, { ok: true, value: autoState() })
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: { code: 'bad-body', message: '请求体必须是 JSON 对象。' } })
          return
        }
        const patch = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (typeof body.verify === 'boolean') patch.verify = body.verify
        if (Number.isFinite(Number(body.maxWaitMs)) && Number(body.maxWaitMs) > 0) patch.maxWaitMs = Number(body.maxWaitMs)
        if (Object.keys(patch).length === 0) {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'no-known-field', message: '没有可写的字段（只接受 enabled / verify / maxWaitMs）。' },
          })
          return
        }
        const next = writeArm(patch)
        // 打开时立刻为**本次**启动架设助手；关掉时什么都不用做（已在等待的助手会自己读到关闭状态）。
        const armed = next.enabled === true ? armHelper('settings update') : false
        sendJson(res, 200, { ok: true, value: { ...autoState(), armed: helperArmed, justArmed: armed } })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: { code: 'settings-failed', message: String((error && error.message) || error) },
        })
      }
    }

    const register = () => {
      ctx.webServer.register({ kind: 'exact', path: SCAN_ROUTE, handler: scanHandler })
      ctx.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: settingsHandler })
    }
    // 照 dsh-chat-manager 的做法：用 ctx.effect 注册（延迟、带标签、随 fiber 释放）。
    if (typeof ctx.effect === 'function') {
      ctx.effect(register, 'dsh-agent-clean: diagnostic + settings routes')
    } else {
      register()
    }
    // 开关默认启用 ⇒ 每次启动都架设一次「退出后自动清理」。
    const armed = armHelper('apply')
    console.info(`[dsh-agent-clean] routes ready: ${SCAN_ROUTE} + ${SETTINGS_ROUTE} (fence: ${connection === undefined ? 'same-origin fallback' : 'connection.requestRejection'}, auto-clean helper: ${armed ? 'armed' : helperArmed ? 'already armed' : 'off'})`)
  } catch (error) {
    // 绝不把异常抛回 Loader：那样整个宿主都可能被算作「entry did not activate」而且悄无声息。
    const detail = String((error && error.stack) || error)
    console.error(`[dsh-agent-clean] apply failed: ${detail}`)
    trace(`apply failed: ${detail}`)
  }
}
