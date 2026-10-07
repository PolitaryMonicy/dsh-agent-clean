/**
 * dsh-agent-clean —— DSH 宿主半（只读诊断）
 *
 * 这个半只做一件事：把 CLI 的**只读**扫描（会话、子代理条目数、孤儿投影缓存）
 * 通过一条自带信任栅栏的 HTTP 路由暴露给客户端面板。
 *
 * 为什么只读：DSH 的契约不允许在运行中改写已提交的事件（`dsh-session-persistence`
 * README：「Committed events are never rewritten」，seq 必须自 0 起稠密、单写者），
 * 投影缓存也没有失效 API（`dsh-session-projection-cache`：「No eviction or retention
 * surface」，且该存储域被缓存自己 already-open）。所以真正的清理**始终**由
 * `clean.mjs` 在 DSH 完全退出后执行 —— 本插件只负责「让你看清该清什么」。
 *
 * 复用的是同一个包里的 `../clean.mjs`（已逐字节验证过的实现），不另写一套扫描逻辑。
 * clean.mjs 里有「直接被调用才跑 CLI」的守卫，import 它不会执行任何命令。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CACHE_ROOT,
  DSH_HOME,
  SESS_ROOT,
  VERSION,
  allSessionIds,
  listSessions,
  readCache,
} from '../clean.mjs'

/** cordis 插件名（`cordis.patch.yml` 里写的 `name` 是**包名**，两者可以不同）。 */
export const name = 'dsh-agent-clean'

/** 唯一的硬依赖：注册 HTTP 路由。其余服务一律 `ctx.get` 探测（cordis 没有「可选依赖」，
 *  注入一个宿主没有的服务会让 fiber 卡住并使**整个 web 启动失败**）。 */
export const inject = ['webServer']

/** 客户端面板轮询的路径。 */
export const SCAN_ROUTE = '/plugins/dsh-agent-clean/scan'

/** 一次回给面板的会话上限（超出时置 truncated，面板会提示收窄工作区）。 */
const MAX_SESSIONS = 300

/** 本包根目录（= 插件安装目录），用来告诉面板「清理命令」该指向哪个包装脚本。 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
  }
}

/**
 * 插件体。`apply` 只注册路由，不做任何写操作。
 * @param ctx - cordis 上下文（至少含 `webServer`）。
 */
export function apply(ctx) {
  // 与 sidebar-qa 同样的理由：fiber 卡住时不会打任何日志，所以这一行是「插件到底有没有跑起来」的唯一信号。
  console.info(`[dsh-agent-clean] host half applied (v${VERSION})`)

  const connection = ctx.get?.('connection') ?? ctx.connection
  const isTrustedRequest = makeFence(connection)

  const handler = (req, res) => {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求未通过同源校验。' } })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只允许 GET／HEAD。' } })
      return
    }
    try {
      sendJson(res, 200, { ok: true, value: scan() })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'scan-failed', message: String((error && error.message) || error) },
      })
    }
  }

  ctx.webServer.register({ kind: 'exact', path: SCAN_ROUTE, handler })
  console.info(`[dsh-agent-clean] route ready: ${SCAN_ROUTE}`)
}
