/**
 * dsh-agent-clean —— 客户端半的离线回归探针（不需要 DSH、不需要浏览器）
 *
 * 为什么需要它：客户端半跑在 DSH 的渲染器里，改一次就得完全重启应用、手点设置页才能看见结果，
 * 而它的**注册时机**恰恰是最容易写错的地方（座位声明得晚、`ctx.get('slots')` 探测、
 * 绝不能写进 `inject` —— 见 plugin/client.js 顶部注释）。这里用假的 `window.__ModuleLoader__`、
 * 极简假 React 与假 slot 登记表，把三种时序都跑一遍：
 *
 *   A 注册时 slots 已就位        → 应当立刻注册一次，label/order/id 正确，组件树 embedded
 *   B 注册时 slots 还没来        → 先不注册；`internal/service` 一到就注册，且只注册一次
 *   C 完全没有 slots（也不支持 ctx.on）→ 不抛异常（绝不许连累宿主启动）
 *
 * 用法：node test/client-slot-probe.mjs
 *       （中文输出写进 UTF-8 文件，因为 Windows 控制台默认 GBK 会把中文显示成乱码）
 * 输出：%TEMP%\dsh-agent-clean-client-probe.txt
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = process.env.DSAC_REPO || dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = process.env.DSAC_PROBE_OUT || join(tmpdir(), 'dsh-agent-clean-client-probe.txt')
const lines = []
const log = (s) => lines.push(s)

// ---- 假的宿主环境 -------------------------------------------------------
let captured
const listeners = new Map()
globalThis.window = {
  __ModuleLoader__: { load(def) { captured = def } },
  addEventListener() {},
  location: { href: 'dsh-app://app/index.html' },
}
// Node 24 的 globalThis.navigator 只有 getter，必须 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', clipboard: undefined },
  configurable: true,
  writable: true,
})
globalThis.document = {
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }),
  execCommand: () => true,
}

class Component {
  constructor(props) { this.props = props ?? {}; this.state = {} }
  setState(patch) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch) }
}
const fakeReact = {
  Component,
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useState: (v) => [v, () => {}],
  Fragment: 'Fragment',
}

const injectCalls = []
const registerCalls = []
const fakeSlots = {
  inject(name, cb) { injectCalls.push(name); return cb() },
  register(opts, component) { registerCalls.push({ opts, component }); return () => {} },
}

await import(pathToFileURL(join(REPO, 'plugin', 'client.js')).href)
log('loader captured = ' + (captured !== undefined))
log('module id = ' + captured.id)

const mod = captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
log('exports = ' + Object.keys(mod).join(','))
log('inject = ' + JSON.stringify(mod.inject))

// ---- 场景 A：slots 已就位 -------------------------------------------------
const effectLabels = []
const eventsRegistered = []
const ctxA = {
  get: (n) => (n === 'slots' ? fakeSlots : undefined),
  on: (ev, cb) => { eventsRegistered.push(ev); listeners.set(ev, cb); return () => {} },
  effect(fn, label) { effectLabels.push(label); return fn() },
}
mod.apply(ctxA)
log('--- A ---')
log('effects = ' + JSON.stringify(effectLabels))
log('events = ' + JSON.stringify(eventsRegistered))
log('injectCalls = ' + JSON.stringify(injectCalls))
log('register count = ' + registerCalls.length)
const a = registerCalls[0]
if (a) {
  log('opts = ' + JSON.stringify({ name: a.opts.name, id: a.opts.id, order: a.opts.order, label: a.opts.label() }))
  const el = a.component()
  const kids = Array.isArray(el.props.children) ? el.props.children : [el.props.children]
  log('component() → type=' + (el && el.type && el.type.name) + ' childTypes=' + kids.map((k) => (k && k.type && k.type.name) || typeof k).join(','))
  const panel = kids[0]
  log('panel props = ' + JSON.stringify(panel && panel.props && Object.keys(panel.props)))
  log('panel embedded = ' + JSON.stringify(panel && panel.props && panel.props.embedded))
}

// ---- 场景 B：slots 迟到，靠 internal/service 唤醒 --------------------------
const inject2 = []
let slots2
const register2 = []
const ctxB = {
  get: () => slots2,
  on: (ev, cb) => { listeners.set('B:' + ev, cb); return () => {} },
  effect(fn) { return fn() },
}
const mod2 = captured.factory((name) => (name === 'react' ? fakeReact : null))
mod2.apply(ctxB)
log('--- B ---')
log('before arrival: registers = ' + register2.length + ' (expect 0)')
slots2 = {
  inject(name, cb) { inject2.push(name); return cb() },
  register(opts) { register2.push(opts.id); return () => {} },
}
listeners.get('B:internal/service')?.()
log('after arrival: inject = ' + JSON.stringify(inject2) + ' registerId = ' + JSON.stringify(register2))
listeners.get('B:internal/service')?.()
log('second notify: registers = ' + JSON.stringify(register2) + ' (expect exactly 1)')

// ---- 场景 C：没有 slots 服务，且没有 ctx.on -------------------------------
let threw = null
try {
  const mod3 = captured.factory((name) => (name === 'react' ? fakeReact : null))
  mod3.apply({ get: () => undefined, effect(fn) { return fn() } })
} catch (error) { threw = String(error && error.message) }
log('--- C ---')
log('apply without slots threw = ' + threw + ' (expect null)')

// ---- 判定 ---------------------------------------------------------------
const okA = registerCalls.length === 1 && a && a.opts.id === 'agent-clean' && a.opts.name === 'settings.section'
const okB = register2.length === 1 && inject2.length === 1
const okC = threw === null
log('')
log('VERDICT A=' + (okA ? 'PASS' : 'FAIL') + ' B=' + (okB ? 'PASS' : 'FAIL') + ' C=' + (okC ? 'PASS' : 'FAIL'))
writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log('probe written: ' + OUT)
console.log('VERDICT A=' + (okA ? 'PASS' : 'FAIL') + ' B=' + (okB ? 'PASS' : 'FAIL') + ' C=' + (okC ? 'PASS' : 'FAIL'))
process.exitCode = okA && okB && okC ? 0 : 1
