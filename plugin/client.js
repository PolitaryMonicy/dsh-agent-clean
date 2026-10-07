/**
 * dsh-agent-clean —— DSH 客户端半（只读诊断面板）
 *
 * 手写的 lazy-CJS 构件（与 `dsh-sidebar-qa` 的 `lib/client.js` 同一形态）：
 * 页面加载时调用 `window.__ModuleLoader__.load({id, factory})`，由宿主把模块表里的
 * `react` / `react-dom/client` 交给 factory。**没有构建步骤**——本文件就是产物。
 *
 * 为什么不用 slot：现有子代理界面没有任何「条目级」扩展位（`conversation.session.header.actions`
 * 只有官方那一个 `subagent-catalog` 格子），覆盖它属于 shadows-shipped-ui。这里改用
 * **自挂的浮标 + 自有面板**（right-bottom），对官方 UI 零改动、零 slot API 依赖。
 *
 * 面板只读：真正的清理必须完全退出 DSH 后由 CLI 执行（见 plugin/index.js 顶部说明）。
 */
/**
 * 宿主把 `window.__ModuleLoader__` 定义好的时机不一定早于本文件求值，所以带重试；
 * 并且**任何异常都不许冒泡**——客户端构件求值失败会连累整个 DSH web 客户端启动。
 */
function registerWithLoader() {
  const loader = window.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') {
    if (registerWithLoader.tries++ < 200) {
      setTimeout(registerWithLoader, 25)
      return
    }
    console.warn('[dsh-agent-clean] window.__ModuleLoader__ 一直没出现，客户端半没有注册')
    return
  }
  try {
    loader.load({
  id: 'dsh-agent-clean',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom/client')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** 宿主半注册的只读路由。 */
    const SCAN_ROUTE = '/plugins/dsh-agent-clean/scan'
    /** 自挂容器的 id（HMR 重复 apply 时先摘旧的，避免叠影）。 */
    const HOST_ID = 'dsh-agent-clean-host'

    /** 颜色一律用 CSS 系统色，自动跟随 DSH 的亮/暗主题，不依赖宿主的变量名。 */
    const S = {
      pill: {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483000,
        display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 11px',
        borderRadius: '999px', border: '1px solid color-mix(in srgb, CanvasText 25%, Canvas)',
        background: 'Canvas', color: 'CanvasText', boxShadow: '0 6px 18px rgba(0,0,0,.28)',
        font: '12px/1.4 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        cursor: 'pointer', userSelect: 'none',
      },
      badge: {
        minWidth: '17px', height: '17px', padding: '0 5px', borderRadius: '999px',
        background: 'color-mix(in srgb, CanvasText 14%, Canvas)', fontSize: '11px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
      panel: {
        position: 'fixed', right: '16px', bottom: '58px', zIndex: 2147483000,
        width: 'min(620px, calc(100vw - 32px))', maxHeight: '72vh', overflow: 'auto',
        borderRadius: '12px', border: '1px solid color-mix(in srgb, CanvasText 25%, Canvas)',
        background: 'Canvas', color: 'CanvasText', boxShadow: '0 16px 44px rgba(0,0,0,.34)',
        padding: '12px 14px', font: '12.5px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      title: { fontSize: '13px', fontWeight: 600 },
      btn: {
        padding: '3px 9px', borderRadius: '7px', cursor: 'pointer',
        border: '1px solid color-mix(in srgb, CanvasText 25%, Canvas)',
        background: 'color-mix(in srgb, CanvasText 8%, Canvas)', color: 'CanvasText',
        font: '11.5px/1.5 inherit',
      },
      muted: { color: 'GrayText' },
      card: {
        border: '1px solid color-mix(in srgb, CanvasText 18%, Canvas)', borderRadius: '9px',
        padding: '7px 9px', marginTop: '7px',
        background: 'color-mix(in srgb, CanvasText 4%, Canvas)',
      },
      code: { font: '11.5px/1.45 ui-monospace, Consolas, monospace', wordBreak: 'break-all' },
      note: {
        marginTop: '10px', padding: '8px 10px', borderRadius: '8px',
        border: '1px solid color-mix(in srgb, CanvasText 18%, Canvas)',
        background: 'color-mix(in srgb, CanvasText 6%, Canvas)',
      },
      table: { width: '100%', borderCollapse: 'collapse', marginTop: '6px' },
      th: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid color-mix(in srgb, CanvasText 20%, Canvas)', fontWeight: 600 },
      td: { padding: '4px 6px', borderBottom: '1px solid color-mix(in srgb, CanvasText 10%, Canvas)', verticalAlign: 'top' },
    }

    function fmtBytes(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(2) + ' MB'
    }

    function shortId(id) {
      return String(id || '').replace(/^session-/, '').slice(0, 8)
    }

    function copyText(text) {
      const done = () => { try { console.info('[dsh-agent-clean] copied:', text) } catch { /* 忽略 */ } }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => fallback())
          return
        }
      } catch { /* 落到兜底 */ }
      fallback()

      function fallback() {
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.setAttribute('readonly', '')
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
          done()
        } catch (error) {
          console.warn('[dsh-agent-clean] copy failed', error)
        }
      }
    }

    /** 一次扫描结果（只读）。 */
    function useScan() {
      const [state, setState] = useState({ phase: 'idle' })
      const load = useCallback(() => {
        setState((prev) => ({ phase: 'loading', value: prev.value }))
        fetch(SCAN_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then(async (res) => {
            // 不要直接 res.json()：路由不存在时宿主回的是空体/HTML，那样只会得到
            // 「Unexpected end of JSON input」，看不出是 404 还是别的。
            const text = await res.text()
            let payload
            try { payload = text ? JSON.parse(text) : undefined } catch { payload = undefined }
            if (!res.ok || payload === undefined) {
              const snippet = text ? text.slice(0, 160).replace(/\s+/g, ' ') : '(空响应体)'
              throw new Error(`宿主返回 HTTP ${res.status}：${snippet}`)
            }
            if (payload.ok !== true) {
              throw new Error((payload && payload.error && payload.error.message) || '宿主返回了失败结果')
            }
            setState({ phase: 'ready', value: payload.value })
          })
          .catch((error) => {
            setState({ phase: 'error', message: String((error && error.message) || error) })
          })
      }, [])
      return [state, load]
    }

    function CommandLine({ label, command, hint }) {
      return h('div', { style: { marginTop: '5px' } },
        h('div', { style: S.row },
          h('span', { style: S.muted }, label),
          h('button', {
            style: S.btn,
            onClick: () => copyText(command),
            title: '复制到剪贴板',
          }, '复制'),
        ),
        h('div', { style: S.code }, command),
        hint ? h('div', { style: { ...S.muted, fontSize: '11px' } }, hint) : null,
      )
    }

    function SessionCard({ session, cli }) {
      const [open, setOpen] = useState(false)
      const q = (p) => '"' + p + '"'
      const dismiss = `${q(cli)} dismiss --session ${session.sessionId} --apply`
      const purge = `${q(cli)} purge --session ${session.sessionId} --apply`
      return h('div', { style: S.card },
        h('div', { style: S.row },
          h('div', null,
            h('span', { style: { fontWeight: 600 } }, shortId(session.sessionId)),
            h('span', { style: { ...S.muted, marginLeft: '6px' } }, session.workspace || session.dir),
          ),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('span', {
              style: {
                ...S.badge,
                background: (session.catalog ?? 0) > 0
                  ? 'color-mix(in srgb, #d9534f 28%, Canvas)'
                  : 'color-mix(in srgb, CanvasText 12%, Canvas)',
              },
            }, `${session.catalog ?? '?'} 条`),
            h('button', { style: S.btn, onClick: () => setOpen(!open) }, open ? '收起' : '命令'),
          ),
        ),
        h('div', { style: { ...S.muted, marginTop: '3px', fontSize: '11.5px' } },
          `${session.log} · v${session.generation} · ${session.rows ?? '?'} 行 · ${fmtBytes(session.size)} · ${session.mtime}`,
        ),
        h('div', { style: { ...S.muted, marginTop: '2px', fontSize: '11.5px' } },
          `投影标题：${session.cacheTitle || '（无）'} · 缓存检查点条目：${session.cacheCatalogCount ?? '—'} · 继承事件数：${session.inherited}`,
        ),
        session.broken ? h('div', { style: { color: '#d9534f', marginTop: '2px', fontSize: '11.5px' } }, `日志读取失败：${session.broken}`) : null,
        open
          ? h('div', null,
            h(CommandLine, {
              label: '① 去掉这个会话里的子代理条目（非破坏：保留全部行与 seq）',
              command: dismiss,
              hint: '默认试演；去掉 --apply 只看计划。',
            }),
            h(CommandLine, {
              label: '② 彻底删除这个会话（目录 + 全部日志 + 投影缓存）',
              command: purge,
              hint: '危险操作，会先整份备份。',
            }),
          )
          : null,
      )
    }

    function Panel({ onClose }) {
      const [state, load] = useScan()
      useEffect(() => { load() }, [load])
      const value = state.value
      const cli = (value && value.cliPath) || 'clean.cmd'
      const orphanCount = (value && value.orphanCaches && value.orphanCaches.length) || 0

      return h('div', { style: S.panel },
        h('div', { style: S.row },
          h('div', { style: S.title }, 'dsh-agent-clean · 只读诊断'),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', { style: S.btn, onClick: load }, state.phase === 'loading' ? '读取中…' : '刷新'),
            h('button', { style: S.btn, onClick: onClose }, '关闭'),
          ),
        ),

        state.phase === 'error'
          ? h('div', { style: { ...S.card, color: '#d9534f' } },
            `读取失败：${state.message}`,
            h('div', { style: { ...S.muted, fontSize: '11.5px', marginTop: '4px' } },
              '宿主半可能没有加载或加载失败。请在终端里跑 "dsh --profile desktop --dump-config" 看组合树，',
              '并查看失败日志 %TEMP%\\dsh-agent-clean-host.log（主进程控制台里应能看到 [dsh-agent-clean] host half applied）。'),
          )
          : null,

        value
          ? h('div', null,
            h('div', { style: { ...S.muted, marginTop: '6px' } },
              `v${value.version} · DSH_HOME=${value.dshHome} · 扫描于 ${value.scannedAt}`,
            ),
            h('div', { style: { marginTop: '8px' } },
              `会话 ${value.total} 个　·　含子代理条目的 ${value.withEntries} 个　·　孤儿投影缓存 ${orphanCount} 个`,
              value.truncated ? '　（已截断显示 300 个）' : '',
            ),

            h('div', { style: S.note },
              h('div', { style: { fontWeight: 600 } }, '这个面板不会改任何东西。'),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                'DSH 的契约不允许在运行中改写已提交的事件（seq 必须稠密、单写者），投影缓存也没有失效 API。' +
                '所以真正的清理必须**完全退出 DSH** 后执行下面的命令，再启动 DSH。',
              ),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                `命令走本插件自带的 CLI：${value.cliPath}（备份默认落在 ${value.backupRoot}，可用 DSAC_BACKUP_DIR 改）。`,
              ),
              h(CommandLine, { label: '一键清掉所有孤儿投影缓存（低风险）', command: `"${cli}" orphans --apply` }),
              h(CommandLine, { label: '先看总览（不改任何东西）', command: `"${cli}" list` }),
            ),

            h('div', { style: { marginTop: '12px', fontWeight: 600 } }, '按会话'),
            value.sessions.length === 0
              ? h('div', { style: S.muted }, '没有找到会话目录。')
              : h('div', null, value.sessions.map((s) => h(SessionCard, { key: s.sessionId, session: s, cli }))),

            orphanCount > 0
              ? h('div', { style: { marginTop: '12px' } },
                h('div', { style: { fontWeight: 600 } }, `孤儿投影缓存（${orphanCount}）`),
                h('div', { style: { ...S.muted, fontSize: '11.5px' } }, '会话目录已经删了、缓存文件还在 —— 这些是 dsh-chat-manager 明确不处理的部分。'),
                value.orphanCaches.map((o) => h('div', { key: o.sessionId, style: S.card },
                  h('div', { style: S.row },
                    h('span', { style: { fontWeight: 600 } }, shortId(o.sessionId)),
                    h('span', { style: S.muted }, `${fmtBytes(o.size)} · 条目 ${o.catalogCount ?? '—'} · ${o.mtime}`),
                  ),
                  h('div', { style: { ...S.muted, fontSize: '11.5px' } }, o.title || '（无标题）'),
                )),
              )
          : null,
      )
          : null,

        state.phase === 'loading' && !value ? h('div', { style: { ...S.muted, marginTop: '8px' } }, '读取中…') : null,
      )
    }

    function App() {
      const [open, setOpen] = useState(false)
      const [state, load] = useScan()
      useEffect(() => { load() }, [load])
      const value = state.value
      const pending = value ? value.withEntries + ((value.orphanCaches && value.orphanCaches.length) || 0) : 0
      return h(React.Fragment, null,
        h('div', { style: S.pill, onClick: () => setOpen(!open), title: 'dsh-agent-clean：查看该清理什么（只读）' },
          h('span', null, '🧹'),
          h('span', null, '清理诊断'),
          value ? h('span', { style: S.badge }, String(pending)) : null,
        ),
        open ? h(Panel, { onClose: () => setOpen(false) }) : null,
      )
    }

    /** 面板崩溃会被 DSH 的 abdication 机制退掉注册，所以自套错误边界并给出重试。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error, info) {
        console.error('[dsh-agent-clean] panel crashed', error, info)
      }
      render() {
        if (this.state.error) {
          return h('div', { style: { ...S.panel, color: '#d9534f' } },
            '面板出错了：' + String((this.state.error && this.state.error.message) || this.state.error),
            h('div', { style: { marginTop: '8px' } },
              h('button', { style: S.btn, onClick: () => this.setState({ error: null }) }, '重试'),
            ),
          )
        }
        return this.props.children
      }
    }

    /**
     * 客户端插件体：把浮标挂到 `document.body`（不占用任何 slot，故对官方 UI 零影响）。
     * @param ctx - 客户端 cordis 上下文（这里不依赖任何服务）。
     */
    function apply(ctx) {
      console.info('[dsh-agent-clean] client half applied')
      const mount = () => {
        const old = document.getElementById(HOST_ID)
        if (old) old.remove()
        const host = document.createElement('div')
        host.id = HOST_ID
        document.body.appendChild(host)
        const root = ReactDOM.createRoot(host)
        root.render(h(Boundary, null, h(App)))
        return () => {
          try { root.unmount() } catch { /* 忽略 */ }
          host.remove()
        }
      }

      let dispose
      if (document.body) dispose = mount()
      else window.addEventListener('DOMContentLoaded', () => { dispose = mount() }, { once: true })

      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => () => { if (dispose) dispose() }, 'dsh-agent-clean: panel host')
      }
    }

    return { inject: [], apply }
  },
    })
  } catch (error) {
    console.error('[dsh-agent-clean] 客户端半注册失败', error)
  }
}

registerWithLoader.tries = 0
registerWithLoader()
