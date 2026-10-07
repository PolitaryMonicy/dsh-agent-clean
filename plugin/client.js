/**
 * dsh-agent-clean —— DSH 客户端半（只读诊断页）
 *
 * 手写的 lazy-CJS 构件（与 `dsh-sidebar-qa` 的 `lib/client.js` 同一形态）：
 * 页面加载时调用 `window.__ModuleLoader__.load({id, factory})`，由宿主把模块表里的
 * `react` 交给 factory。**没有构建步骤**——本文件就是产物。
 *
 * 入口：官方设置页座位 `settings.section`（「设置 → 会话清理诊断」）。以前自挂过一个
 * 右下角浮标，但那会压住发送按钮、语义也不清（用户 m04458 提出），已删除。
 *
 * 两条等待是真的、且互相独立：`slots` 服务由 DSH 渲染层发布，座位 `settings.section`
 * 由设置页声明。座位这一层交给 `slots.inject`（座位声明后回调才跑）；而 `slots` 本身
 * **只能 `ctx.get` 探测**——写进 `inject` 会让本插件的 fiber 在没有渲染层的组合里被
 * park，而 parked fiber 会让**整个 web boot 失败**（`boot-client.ts`），不是跳过本插件。
 * 故此处照抄 `dsh-sidebar-qa/src/client/settings-slot.ts:50-77` 的做法：监听
 * `internal/service`（`ReflectService.notify` 每次 `provide` 都会发）＋先探测一次。
 *
 * 面板做两件事：①只读地列出会话/子代理条目/孤儿投影缓存，并给出可复制的 CLI 命令；
 * ②一个开关（默认启用）——打开后宿主半会在每次启动时架设一个**脱离的助手进程**，
 * 等 DSH 完全退出后自动跑 `dismiss --all --apply` 的同一条管线（见 plugin/index.js）。
 * 开关本身写在插件自己的 `auto-arm.json` 里，**运行中绝不动会话存储**：真正的清理必须
 * 完全退出 DSH 后由 CLI 执行（理由见 plugin/index.js 顶部说明）。
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
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** 宿主半注册的只读路由。 */
    const SCAN_ROUTE = '/plugins/dsh-agent-clean/scan'
    /** 宿主半注册的开关路由（GET 读、POST 写）。 */
    const SETTINGS_ROUTE = '/plugins/dsh-agent-clean/settings'
    /** 设置页座位的 id（DSH 也用它挑导航图标；不认识的 id 回落到齿轮，正合设置页）。 */
    const SETTINGS_ID = 'agent-clean'
    /** 排在 DSH 官方各节之后：general 0 / models 10 / plugins 15 / agent-presets 20 / archived-sessions 25 / sidebar-qa 30。 */
    const SETTINGS_ORDER = 31
    /** 导航标签（每次投影都会重读）。 */
    const LABEL = (() => {
      try {
        return /^zh/i.test(String(navigator.language || '')) ? '会话清理诊断' : 'Session cleanup'
      } catch {
        return '会话清理诊断'
      }
    })()

    /** 颜色一律用 CSS 系统色，自动跟随 DSH 的亮/暗主题，不依赖宿主的变量名。 */
    const S = {
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
      /** 放进设置页时不再自绘外框——容器已经给了标题与滚动。 */
      panelEmbedded: {
        position: 'static', right: 'auto', bottom: 'auto', width: '100%', maxWidth: '820px',
        maxHeight: 'none', overflow: 'visible', border: 'none', boxShadow: 'none',
        background: 'transparent', padding: '0',
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

    /** 写开关：POST 一个很小的 JSON，拿回新状态（失败时**必须**看出是 404 还是别的）。 */
    function postSettings(patch) {
      return fetch(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(patch),
      }).then(async (res) => {
        const text = await res.text()
        let payload
        try { payload = text ? JSON.parse(text) : undefined } catch { payload = undefined }
        if (!res.ok || payload === undefined || payload.ok !== true) {
          const snippet = text ? text.slice(0, 160).replace(/\s+/g, ' ') : '(空响应体)'
          throw new Error(`宿主返回 HTTP ${res.status}：${snippet}`)
        }
        return payload.value
      })
    }

    /** 「上次自动清理」的一句话说明。 */
    function describeAuto(report) {
      if (!report) return '还没有自动清理的记录（助手只在你完全退出 DSH 之后动手）。'
      const why = {
        timeout: '等待 DSH 退出超时，未做任何改动',
        disabled: '开关是关闭的，未做任何改动',
        'lock-busy': '已有另一个助手在跑（等了 3 分钟），本次放弃',
        'other-dsh-running': (Array.isArray(report.otherPids) && report.otherPids.length
          ? `检测到另一个 DSH 实例仍在运行（pid ${report.otherPids.join('、')}），本次跳过`
          : '检测到另一个 DSH 实例仍在运行，本次跳过'),
      }[report.why] || report.why || '未执行'
      if (report.ran !== true) return `上次未执行：${why}（${report.at || '时间未知'}）`
      const backups = Array.isArray(report.backups) ? report.backups.length : 0
      return `上次自动清理：${report.at}，处理 ${report.sessions ?? '?'} 个会话，改写 ${report.cleaned ?? '?'} 个，`
        + `失败 ${report.failures ?? '?'} 个${backups ? `，备份 ${backups} 份` : ''}`
    }

    /** 上次自动清理里没处理成功的会话与原因 —— 面板是唯一能看见原因的地方。 */
    function autoFailures(report) {
      if (!report || !Array.isArray(report.results)) return []
      return report.results
        .filter((r) => r && r.ok !== true)
        .map((r) => ({ sessionId: r.sessionId, why: r.why }))
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

    function Panel({ embedded, onClose }) {
      const [state, load] = useScan()
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      useEffect(() => { load() }, [load])
      const value = state.value
      const cli = (value && value.cliPath) || 'clean.cmd'
      const orphanCount = (value && value.orphanCaches && value.orphanCaches.length) || 0
      const box = embedded ? { ...S.panel, ...S.panelEmbedded } : S.panel
      const auto = (value && value.auto) || null
      const autoOn = auto ? auto.settings?.enabled !== false : true
      const autoSaved = Boolean(auto && auto.explicit)

      const toggleAuto = (next) => {
        setBusy(true)
        setNote('')
        postSettings({ enabled: next })
          .then(() => {
            setBusy(false)
            setNote(next
              ? '已启用：本次启动的助手已经架设好，完全退出 DSH 后自动清理，下次启动时生效。'
              : '已关闭：正在等待的助手会自己读到关闭状态并原样退出。')
            load()
          })
          .catch((error) => {
            setBusy(false)
            setNote('写入失败：' + String((error && error.message) || error))
          })
      }

      return h('div', { style: box },
        h('div', { style: S.row },
          h('div', { style: S.title }, 'dsh-agent-clean · 会话清理诊断'),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', { style: S.btn, onClick: load }, state.phase === 'loading' ? '读取中…' : '刷新'),
            embedded ? null : h('button', { style: S.btn, onClick: onClose }, '关闭'),
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

            h('div', { style: S.card },
              h('div', { style: S.row },
                h('label', {
                  style: { display: 'flex', alignItems: 'center', gap: '7px', cursor: busy ? 'default' : 'pointer' },
                },
                  h('input', {
                    type: 'checkbox',
                    checked: autoOn,
                    disabled: busy,
                    onChange: (e) => toggleAuto(e.target.checked),
                  }),
                  h('span', { style: { fontWeight: 600 } }, '每次退出 DSH 时自动移除无用子代理条目'),
                ),
                h('span', { style: S.muted }, busy ? '写入中…' : autoSaved ? '已保存' : '默认启用'),
              ),
              h('div', { style: { ...S.muted, marginTop: '4px', fontSize: '11.5px' } },
                '打开后，DSH 每次启动都会架设一个脱离的助手进程：它等你**完全退出** DSH 之后，'
                + '自动执行与下面那条「一键清掉所有会话的子代理条目」完全相同的管线（逐会话整份备份 → 结构自检 → 真实加载器复核）。'
                + '所以你什么都不用敲，下次启动时界面里就已经没有条目了。',
              ),
              h('div', { style: { ...S.muted, marginTop: '3px', fontSize: '11.5px' } },
                '若退出时还有第二个 DSH 实例在跑，助手会跳过本次（下一个退出窗口再来）；'
                + '助手只在看到 DSH 进程真的消失后才动盘，动作等价于你自己敲那条命令。',
              ),
              h('div', { style: { marginTop: '4px', fontSize: '11.5px' } }, describeAuto(auto && auto.lastAuto)),
              auto && auto.lastMissed
                ? h('div', { style: { marginTop: '2px', fontSize: '11.5px', color: '#d9534f' } },
                  `⚠ 上一次退出时自动清理没跑完：为 pid ${auto.lastMissed.waitedPid} 架设的助手`
                  + `${auto.lastMissed.helperPid ? `（pid ${auto.lastMissed.helperPid}）` : ''}在 `
                  + `${auto.lastMissed.at || '架设之后'} 之后就消失了，没留下任何报告 —— `
                  + '它多半是被系统或别的工具一起结束了。再完全退出一次 DSH 就会重试。')
                : null,
              autoFailures(auto && auto.lastAuto).length
                ? h('div', { style: { ...S.muted, marginTop: '2px', fontSize: '11px' } },
                  autoFailures(auto && auto.lastAuto).map((f, i) =>
                    h('div', { key: i }, `· 没处理成：${shortId(f.sessionId)} —— ${f.why || '原因未记录（旧版助手的报告）'}`)))
                : null,
              note ? h('div', { style: { marginTop: '3px', fontSize: '11.5px', color: note.indexOf('失败') === 0 ? '#d9534f' : 'GrayText' } }, note) : null,
              auto && auto.armFile
                ? h('div', { style: { ...S.muted, marginTop: '2px', fontSize: '11px' } }, `开关文件：${auto.armFile}`)
                : null,
            ),

            h('div', { style: S.note },
              h('div', { style: { fontWeight: 600 } }, '这个面板不会在 DSH 运行中改动会话存储。'),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                'DSH 的契约不允许在运行中改写已提交的事件（seq 必须稠密、单写者），投影缓存也没有失效 API。' +
                '所以真正的清理必须**完全退出 DSH** 后执行下面的命令，再启动 DSH。',
              ),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                '（上面那个开关只写插件自己的 auto-arm.json，也走同一条「退出后才动手」的路。）',
              ),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                `命令走本插件自带的 CLI：${value.cliPath}（备份默认落在 ${value.backupRoot}，可用 DSAC_BACKUP_DIR 改）。`,
              ),
              h(CommandLine, {
                label: `一键清掉所有会话的子代理条目（当前 ${value.withEntries} 个会话有条目）`,
                command: `"${cli}" dismiss --all --apply`,
                hint: '非破坏：保留全部行与 seq，只把「自己的」catalog 行改成被忽略的类型；每个会话都会先整份备份、'
                  + '并用真实加载器在镜像里自检（会话多时会慢一些）。默认试演 —— 去掉 --apply 只看计划。'
                  + '必须在完全退出 DSH 后执行，执行完再启动 DSH。',
              }),
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

    /** 页面崩溃会被 DSH 的 abdication 机制退掉注册，所以自套错误边界并给出重试。 */
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
          const box = this.props.embedded ? { ...S.panel, ...S.panelEmbedded } : S.panel
          return h('div', { style: { ...box, color: '#d9534f' } },
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
     * slot 注册表：只探测，不注入（见文件头注释）。
     * @param ctx - 客户端 cordis 上下文。
     * @returns 服务面，或 undefined（渲染层还没组合进来）。
     */
    function slotsServiceOf(ctx) {
      let slots
      try { slots = ctx.get ? ctx.get('slots') : undefined } catch { return undefined }
      if (slots === undefined || slots === null) return undefined
      // inject 与 register 都会用到；只有其一＝组合有问题，宁可当「没有注册表」。
      if (typeof slots.register !== 'function' || typeof slots.inject !== 'function') return undefined
      return slots
    }

    /**
     * 把只读诊断页挂进「设置 → 会话清理诊断」，一旦可能就挂（座位稍后声明也等得到）。
     * @param ctx - 客户端 cordis 上下文。
     */
    function installSettingsSection(ctx) {
      let installed = false

      const installIfPossible = () => {
        if (installed) return
        const slots = slotsServiceOf(ctx)
        if (slots === undefined) return
        installed = true
        const register = () => slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: SETTINGS_ID,
          order: SETTINGS_ORDER,
          label: () => LABEL,
        }, () => h(Boundary, { embedded: true }, h(Panel, { embedded: true }))))
        if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-agent-clean: settings section')
        else register()
        console.info('[dsh-agent-clean] settings section registered:', SETTINGS_ID)
      }

      const watch = () => {
        // 任何服务发布都可能是我们等的渲染层（`internal/service` 由 ReflectService.notify 在每次 provide 时发出）。
        let off
        try { if (typeof ctx.on === 'function') off = ctx.on('internal/service', () => { installIfPossible() }) } catch { /* 忽略 */ }
        // 常见情况是它已经组合好了，所以先探一次。
        installIfPossible()
        return off
      }

      if (typeof ctx.effect === 'function') ctx.effect(watch, 'dsh-agent-clean: settings slot watch')
      else watch()
    }

    /**
     * 客户端插件体：只占用官方设置页座位 `settings.section`，对官方 UI 其他部分零改动。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      console.info('[dsh-agent-clean] client half applied')
      installSettingsSection(ctx)
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
