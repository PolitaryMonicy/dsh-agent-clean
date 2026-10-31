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
    const ROLE_ZH = { main: '主进程', host: 'host 进程', other: '进程' }
    /** 把时间戳说成人话（「3 天前」）—— 报告可能是好几天前的，只给 ISO 时间根本看不出来。 */
    function ageText(iso) {
      const t = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(t)) return ''
      const mins = Math.round((Date.now() - t) / 60000)
      if (mins < 1) return '刚刚'
      if (mins < 60) return `${mins} 分钟前`
      const hours = Math.round(mins / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.round(hours / 24)
      return days < 30 ? `${days} 天前` : `${Math.round(days / 30)} 个月前`
    }
    function describeAuto(report) {
      if (!report) return '还没有自动清理的记录（助手只在你完全退出 DSH 之后动手）。'
      const age = ageText(report.at)
      const stamp = report.at ? `${report.at}${age ? `，${age}` : ''}` : '时间未知'
      const why = {
        timeout: '等待 DSH 退出超时，未做任何改动',
        disabled: '开关是关闭的，未做任何改动',
        'lock-busy': '已有另一个助手在跑（等了 3 分钟），本次放弃',
        'helper-crash': `助手自己异常退出了${report.error ? `（${String(report.error).split('|')[0].trim()}）` : ''}`,
        'list-failed': `列会话失败${report.error ? `（${report.error}）` : ''}`,
        'other-dsh-running': (() => {
          const parts = Array.isArray(report.otherRoles) && report.otherRoles.length
            ? report.otherRoles.map((o) => `${ROLE_ZH[o.role] ?? o.role} ${o.pid}`).join('、')
            : (Array.isArray(report.otherPids) && report.otherPids.length ? `pid ${report.otherPids.join('、')}` : '')
          const what = report.sameInstance === true ? '同一个 DSH 实例还没退完' : '检测到另一个 DSH 实例仍在运行'
          const waited = Number(report.waitedMs) > 0 ? `（一直等到 ${Math.round(Number(report.waitedMs) / 60000)} 分钟上限）` : ''
          return `${what}${parts ? `（${parts}）` : ''}${waited}，本次跳过`
        })(),
      }[report.why] || report.why || '未执行'
      if (report.ran !== true) return `上次未执行：${why}（${stamp}）`
      // 「做了一半」：清理期间新的 DSH 实例起来了，助手当场停手（安全优先，剩下的留给下一次）。
      if (report.aborted === 'new-instance') {
        const processed = Number(report.processed ?? 0)
        const total = Number(report.sessions ?? 0)
        const parts = Array.isArray(report.otherRoles) && report.otherRoles.length
          ? report.otherRoles.map((o) => `${ROLE_ZH[o.role] ?? o.role} ${o.pid}`).join('、')
          : (Array.isArray(report.otherPids) && report.otherPids.length ? `pid ${report.otherPids.join('、')}` : '')
        return `上次自动清理只做了一半：处理到 ${processed}／${total} 个会话时，新的 DSH 实例`
          + `${parts ? `（${parts}）` : ''}已经起来了，助手当场停手`
          + `${processed > 0 ? `（已改写 ${report.cleaned ?? 0} 个）` : '（一个都没改）'}（${stamp}）`
      }
      const backups = Array.isArray(report.backups) ? report.backups.length : 0
      return `上次自动清理：${stamp}，处理 ${report.sessions ?? '?'} 个会话，改写 ${report.cleaned ?? '?'} 个，`
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

    function Panel({ embedded, onClose }) {
      const [state, load] = useScan()
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      useEffect(() => { load() }, [load])
      const value = state.value
      const cli = (value && value.cliPath) || 'clean.cmd'
      // 唯一的「工作区哈希目录」示例：从任意一个会话目录往上取一层（没有会话时留空）。
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
              `v${value.version} · DSH_HOME=${value.dshHome} · 读取于 ${ageText(value.scannedAt) || value.scannedAt}`,
            ),
            h('div', { style: { marginTop: '8px' } },
              `会话目录 ${value.total} 个　·　本页只读目录名，不解压会话日志`
              + '（要逐会话列则需在终端中输入页末的命令）',
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
                '启用后，DSH 每次启动都会架设一个游离的助手进程，在你「完全退出」DSH 之后，'
                + '自动执行任务「一键清掉所有会话的子代理条目」　·　（逐会话整份备份 → 结构自检 → 真实加载器复核）',
              ),
              h('div', { style: { ...S.muted, marginTop: '3px', fontSize: '11.5px' } },
                '若退出时还有别的 DSH 实例在跑，助手不会动手，而是等到设备上没有 DSH 了再清理；直到 72 小时上限仍没等到，才会记一条「本次跳过」。'
                + '注意 DSH 应用菜单里的「重启」是 app.relaunch() —— 新 DSH 先起来、旧 DSH 后退出，两者重叠一两秒。'
                + '一个 DSH 本身有五六个同名进程（主进程、GPU、网络、渲染、host），工具命令的 runner 与我们自己的助手也是同一个 exe —— '
                + '所以判定「另一个 DSH」时只认主进程与 host 进程。',
              ),
              h('div', { style: { marginTop: '3px', fontSize: '11.5px', color: '#b8860b' } },
                '想让自动清理完整跑一次？把 DSH「完全退出」（关窗口不算），'
                + '等一两分钟让助手做完（清理结果同时也会刷新），再打开。'
                + '原因是清理一个会话要几十秒，而「关掉就马上重开」两次启动之间只有一两秒空档：'
                + '助手要连续确认几轮才敢动手。'
                + '也可以完全退出 DSH 之后，到终端跑一次下面那条 dismiss 命令。',
              ),
              h('div', { style: { marginTop: '4px', fontSize: '11.5px' } }, describeAuto(auto && auto.lastAuto)),
              auto && auto.lastMissed
                ? (() => {
                  const m = auto.lastMissed
                  const seen = m.lastSeenAt ? `最后一次心跳 ${m.lastSeenAt}，` : ''
                  return h('div', { style: { marginTop: '2px', fontSize: '11.5px', color: '#b8860b' } },
                    `⚠ 上一轮退出窗口里的助手没留下任何报告：为 pid ${m.waitedPid} 架设的助手`
                    + `${m.helperPid ? `（pid ${m.helperPid}）` : ''}架设于 ${m.at || '未知时间'}，${seen}现已不在`
                    + '（纯 JS 异常一定会留下 helper-crash 报告，所以没有报告多半是它被外力结束：关机、任务管理器，'
                    + '或被连带杀掉）。下一次「完全退出」DSH 时助手会自动重试；本页不解压日志，判断不了还有没有'
                    + '待清理条目 —— 想确认就跑一次下面的 list。')
                })()
                : null,
              auto && auto.armed
                ? h('div', { style: { ...S.muted, marginTop: '2px', fontSize: '11px' } },
                  `本轮记录：助手${auto.armed.helperPid ? ` pid ${auto.armed.helperPid}` : ''} 等 pid ${auto.armed.waitedPid} 退出`
                  + `${auto.armed.mainPid ? `（本实例主进程 pid ${auto.armed.mainPid}）` : ''}`
                  + `（架设于 ${auto.armed.at || '未知'}`
                  + `${auto.heartbeat && Number(auto.heartbeat.pid) === Number(auto.armed.helperPid) ? `，最后心跳 ${auto.heartbeat.at}（${ageText(auto.heartbeat.at)}）` : ''}）`)
                : null,
              auto && Array.isArray(auto.logTail) && auto.logTail.length
                ? h('details', { style: { marginTop: '4px', fontSize: '11px' } },
                  h('summary', { style: { ...S.muted, cursor: 'pointer' } }, '助手日志最后几行（出问题时看这里：它停在哪一步）'),
                  h('div', { style: { ...S.code, marginTop: '3px', whiteSpace: 'pre-wrap', fontSize: '10.5px' } },
                    auto.logTail.join('\n')))
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
              h('div', { style: { fontWeight: 600 } }, '如何锁定或删改本地会话日志？'),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                '这个助手只会把 DSH 界面上的子代理条目去掉（改的是父会话日志里那几行 catalog），'
                + '不会改动任何本地目录。若想删改本地会话日志，建议先退出 DSH，再到下面两处手动处理：'),
              h('div', { style: { marginTop: '3px' } },
                `1. 会话日志：${value.sessionsRoot}`),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                `该目录下的每个文件夹对应于 DSH 的一个工作区（如 `
                + `${value.sessionsRoot}\\<工作区哈希>\\），存有该工作区内的所有会话目录 —— `
                + '目录名以 session 开头的是父会话，不以 session 开头的一串裸 uuid 是子代理（例如 '
                + `<工作区哈希>\\dddd5555-5555-5555-5555-555555555555 就是子代理）。`),
              h('div', { style: { marginTop: '3px' } },
                `2. 投影缓存：${value.cacheRoot}`),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                `每个父会话、子代理各占一份 <会话id>.json，`
                + '删掉不会改到会话内容，重启会自动重建。'),
              h('div', { style: { marginTop: '3px', color: '#1188ee' } },
                '只想「清掉子代理、保留父会话」？删掉这两个目录下所有不以 session 开头的文件即可。'),
            ),

            h('div', { style: { ...S.note, marginTop: '12px' } },
              h('div', { style: { fontWeight: 600 } }, '这个面板不会在 DSH 运行中改动会话存储。'),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                'DSH 的契约不允许在运行中改写已提交的事件（seq 必须稠密、单写者），投影缓存也没有失效 API。' +
                '所以真正的清理必须「完全退出 DSH」后执行下面的命令，再启动 DSH。',
              ),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                '（上面那个开关只写插件自己的 auto-arm.json，也走同一条「退出后才动手」的路。）',
              ),
              h('div', { style: { ...S.muted, marginTop: '3px' } },
                `命令走本插件自带的 CLI：${value.cliPath}（备份默认落在 ${value.backupRoot}，可用 DSAC_BACKUP_DIR 改）。`,
              ),
              h(CommandLine, {
                label: '一键清掉所有会话的子代理条目',
                command: `"${cli}" dismiss --all --apply`,
                hint: '非破坏：保留全部行与 seq，只把「自己的」catalog 行改成被忽略的类型；每个会话都会先整份备份、'
                  + '并用真实加载器在镜像里自检（会话多时会慢一些）。默认试演 —— 去掉 --apply 只看计划。'
                  + '必须在完全退出 DSH 后执行，执行完再启动 DSH。'}),
              h(CommandLine, { label: '先看总览：每个会话有几条、日志多大、缓存标题（会解压日志，带增量缓存）', command: `"${cli}" list` }),
            ),
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
