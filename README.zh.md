# dsh-agent-clean

[![Release](https://img.shields.io/github/v/release/PolitaryMonicy/dsh-agent-clean?sort=semver&label=release)](https://github.com/PolitaryMonicy/dsh-agent-clean/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

**DSH（DeepSeek Harness）的子代理条目／会话／孤儿投影缓存清理工具。**

零依赖：只用 Node.js 内置模块（`node:zlib` 的 zstd、`node:fs`、`node:child_process`）。

> 这个工具产生于一次真实事故：一个会话的子代理（subagent）入口卡住／损坏，删不掉。经反查
> DSH 的会话日志格式与加载器源码，找到了**不破坏日志**的正确改法，做成命令行工具并附完整回归测试。

> **两半，任选其一。** **命令行**是独立的：它只对 DSH 的磁盘文件动手，由你在 DSH 之外用终端运行，
> 什么都不用安装 —— `git clone`（第二节）或网页上的 **Code → Download ZIP** 即可。同一个包还带一个
> **可选的 DSH 插件半**：一条宿主路由 ＋ 「**设置 → 会话清理诊断**」里的页面，告诉你该清什么、把命令复制给你，
> 还带一个**默认启用**的开关：**下次退出 DSH 时自动把无用子代理条目清掉**（见第 2.2 小节）。装不装都行，
> 不影响命令行。插件市场收录的是**声明了 `dsh` 字段的 npm 包**，所以本包一旦发到 npm 就可能出现在那里。

- 不删任何日志行、不改 seq（v4 格式要求 seq 稠密，删行会让整个会话报 `format v4 event N is not dense`）
- 只把「自己的」子代理目录行改成 `subagent/catalog-dismissed` + `ignorable: true`
- 顺手把投影缓存里的 `subagentCatalog` 改成合法空状态（DSH 的 `dsh-chat-manager` 删会话目录时**不会**清这个缓存，会留下孤儿）
- 每次写入前**整份备份**，可用 `restore` 逐字节还原

---

## 一、运行需求

| 项目 | 要求 |
|---|---|
| Node.js | **≥ 22**（需要内置 zlib 的 zstd；脚本会在启动时检查并给出明确提示） |
| 系统 | Windows / macOS / Linux |
| DSH | 桌面版（可选但强烈建议，用于「真实加载器自检」）；也可用 `--modules` 指向含 `@deepseek-ai` 的 node_modules |

**DSH 根目录**默认 `~/.dsh`（Windows 为 `C:\Users\<你>\.dsh`），可用环境变量 `DSH_HOME` 覆盖。
里面的相关路径：

```
$DSH_HOME/sessions/<转义工作区名>/<session-id>/session.v4.jsonl.zstd   ← 会话日志
$DSH_HOME/storages/session_projcache/sessions/<session-id>.json        ← 投影缓存（子代理条目就在这里）
```

## 二、获取、安装与启动

```bash
git clone https://github.com/PolitaryMonicy/dsh-agent-clean.git
cd dsh-agent-clean
```

（也可在 GitHub 页面点 **Code → Download ZIP** 下载解压。）无需 `npm install`（没有任何第三方依赖）。三种启动方式，任选：

```bat
:: Windows：把整个目录放到任意位置，双击或在终端里用
clean.cmd list
```

```bash
# macOS / Linux
chmod +x clean.sh
./clean.sh list
```

```bash
# 任何平台：直接调 node
node clean.mjs list
```

包装脚本会自己找 Node：`%DSH_NODE%` / `$DSH_NODE` → PATH 上的 `node` → 常见安装路径。

### 2.1 可选：DSH 插件半

同一个包也是一个 DSH 插件（声明了 `dsh.bundle.patch` 与 `dsh.client`），所以桌面版的插件管理器能装它：

```bash
dsh plugin --profile desktop add dsh-agent-clean                          # 从 npm
dsh plugin --profile desktop add github:PolitaryMonicy/dsh-agent-clean    # 直接从 GitHub
dsh plugin --profile desktop add /本仓库/路径                             # 本地检出
```

装完**完全退出 DSH 再启动**。**设置 → 会话清理诊断**里会多出一个页面（旧版本右下角那个 🧹 浮标已删除）。

这个页面**只读目录名、不解压任何会话日志**：它数一下 `$DSH_HOME/sessions/` 下有几个会话目录，把 `dismiss` /
`purge` 命令复制给你 —— 其中包括**一条命令清掉所有会话的子代理条目** —— 并在原先「按会话」那一块放一段
「如何锁定或删改本地会话日志？」的说明：每个工作区对应 `$DSH_HOME/sessions/` 下的一个哈希目录，目录名以
`session` 开头的是父会话、不以 `session` 开头的一串裸 uuid 是子代理；投影缓存则在
`$DSH_HOME/storages/session_projcache/sessions/` 下各占一份 `<会话id>.json`。想连子代理的会话本身一起清掉，
DSH 关闭时删掉那些裸 uuid 目录、以及缓存里与它们同名的 `.json` 就行（按「修改时间」排序最容易定位）。

**逐会话明细交给 CLI**：要看每个会话有几条、日志多大、缓存标题，跑 `clean.cmd list`（或页面里那条命令）——
它才会解压日志，而且带**增量缓存**（`<状态目录>/scan-cache.json`）：第一次解析之后，只有日志新追加的尾部才会
被解压，所以第二次几乎是瞬时的 —— 几十 MB、上万帧的会话也一样（本机实测 4.7 秒 → 25 毫秒）。

**它也不再加载「孤儿投影缓存」**：这类残骸（会话目录已删、缓存文件还在）逐条读一遍只为了列一张没什么用的清单，
条目多时（几十个）会明显拖慢打开设置；它们只占缓存体积、不影响你在界面里看到的东西，需要时手动跑
`clean.cmd orphans --apply`（CLI 照样支持）。

若页面报 `宿主返回 HTTP 404`，说明宿主半没加载：用 `dsh --profile desktop --dump-config`
看组合树里有没有这个条目，再看 `%TEMP%\dsh-agent-clean-host.log` 里的原因。

页面还带一个开关（见 2.2）。**无论是页面还是开关，都不在 DSH 运行中碰会话存储**：DSH 的契约不允许运行中
改写已提交事件（seq 必须稠密、单写者），投影缓存也没有失效 API，所以运行中即便写盘成功，进程内存里仍是旧值。
**真正改动会话的动作一律发生在 DSH 退出之后**，走的就是你手敲 `clean.mjs` 的同一条管线（逐会话整份备份 →
结构自检 → 真实加载器复核）。

卸载：`dsh plugin --profile desktop remove dsh-agent-clean`。

### 2.2 退出时自动清理（默认启用）

既然清完也**必须重启 DSH** 才看得见效果，那干脆让插件在这个重启窗口里替你做掉。开关打开（默认）时，DSH 每次启动会：

1. 把开关写进本包状态目录的 `auto-arm.json`；
2. 启动一个**脱离的助手进程**（`clean.mjs autowait --pid <本次 DSH 进程>`）——它不随 DSH 退出而消失，只等那个 pid 消失。

等 DSH 真的退出后，助手就跑与 `dismiss --all --apply` 完全相同的管线（每个会话先整份备份 → 结构自检 →
真实加载器复核），处理所有还有子代理条目的会话，并把结果写进 `auto-report.json`（`auto.log` 留一小段历史）。
下次启动 DSH 时你就能在页面上看到结果。关掉开关**不需要重启**：还在等的助手会重新读一遍开关，看到
`enabled: false` 就原样退出；若那一刻还有第二个 DSH 实例在跑，助手**不会跳过**，而是继续等到真的没有任何 DSH
在跑为止（只有等到 72 小时上限才记一条「本次跳过」）。

**想让它真的跑一次**：把 DSH **完全退出**（关窗口不算 —— 它可能会问你是否退到后台），等一两分钟让助手做完
（页面上「上次自动清理」会刷新成这一次的结果），再打开。原因是清理一个会话要几十秒，而「关掉就马上重开」两次
启动之间只有一两秒空档：助手要连续确认几轮才敢动手，一旦发现新实例已经起来就当场停手，把剩下的留给下一次。
别的方式也行：完全退出 DSH 之后，直接照第三节的命令手动跑一次。

开关为什么不放进 DSH 的 settings 服务：脱离的助手读不到另一个进程内存里的设置；而且本插件必须保持
**零依赖**（不 import `@deepseek-ai/schemastery`）才能在本地 `link:` 安装下继续工作。

想自己动手？把开关关掉，用页面里那几条命令 —— 它们做的事完全一样。

## 三、命令

| 命令 | 作用 |
|---|---|
| `list [--workspace <片段>]` | 列出各会话、标题、日志大小、**自己的子代理条目数** |
| `dismiss --session <id\|前缀> [--apply]` | **去掉子代理条目**（非破坏：保留全部行与 seq） |
| `dismiss --all [--workspace <片段>] [--apply]` | 对多个会话执行 |
| `purge --session <id\|前缀> [--apply]` | **彻底删除**会话目录 + 全部 generation 日志 + 投影缓存（先整份备份） |
| `orphans [--apply]` | 列出／删除「会话目录已经不在、缓存还在」的孤儿缓存 |
| `restore --backup <备份目录>` | 从备份还原（dismiss／purge／orphans 的备份都认） |
| `autowait --pid <DSH 进程号>` | 等这个 DSH 进程退出，然后清掉所有还有子代理条目的会话（插件开关在启动时架设的就是它；它看 `auto-arm.json` 的脸色） |
| `version` / `help` | 版本／帮助 |

**公共开关**

| 开关 | 说明 |
|---|---|
| `--apply` | 不加＝只试演（默认）。加＝真正写入 |
| `--force` | 日志在最近 5 分钟内被写过时，必须显式加这个（防呆，避免削弱正在运行的会话） |
| `--workspace <片段>` | 只处理工作区名里含该片段的会话 |
| `--no-verify` | 跳过「找不到复核途径」这一关；**真实加载器一旦报失败，仍会拒绝写入** |
| `--no-app` | 不使用桌面版，改用纯 Node + `--modules` |
| `--app <exe>` / `--asar <app.asar>` | 手动指定 DSH 应用 |
| `--modules <node_modules>` | 手动指定含 `@deepseek-ai/*` 的目录 |

**退出码**：`0` 成功（dismiss 后投影条目应为 0）；`1` 出错（含真实加载器自检失败、参数错误）；`2` 自检通过但条目数不为 0。

**流程建议**：先 `list` 看现状 → `dismiss --session <前8位>`（试演）看它要改什么 → 加 `--apply` → **完全退出并重启 DSH**。

## 四、为什么必须这样做（机制）

v4 会话日志是 zstd 多帧拼接的 JSONL：第 0 行是 header（无 `seq`），其后每行一个事件，`seq` 必须 0,1,2,… **稠密**。

DSH 客户端只读**投影缓存**里的 `projectionsBySession[].values.subagentCatalog` 来画子代理入口，没有「摘要回退」——所以只改日志不改缓存，界面上条目会照旧出现。

要让一个子代理条目消失，四个条件**同时**成立才行（都是实测出来的）：

1. **改名**：把该条目的 `subagent/catalog` 事件改成 `subagent/catalog-dismissed`，并加 `ignorable: true`（未知类型必须可忽略，否则加载器报错）。
2. **header 一字不动**：日志里 `session-log-deepseek/delivery-accepted` 的 `data.sessionId` 必须**等于** header 的 `id`。只改 header 的 id 会得到：
   `SessionFormatError: current-generation delivery marker names the wrong Session`
3. **缓存改合法空状态**：投影里 `subagentCatalog` 的值改成 `{"inheritedEventCount": <继承数>}`（**不能**写成 `head.values: []`，schema 会报 `too_small`）。
4. **必须完全重启 DSH**：运行中的进程内存里还留着旧值。

另外两条实测约束（工具已处理）：

- **不能删行**：删行会让后面的 `seq` 不稠密 → `format v4 event N is not dense`（这是当初「删行方案」失败的原因）。
- 加载器还会校验 **header.id 与日志路径推出的身份一致**，所以「镜像上先跑一次真实加载器」时，镜像必须放在**同名的转义工作区目录**下；否则即使变换正确也会报
  `header id "…" and cwd identify "…"`。

## 五、安全设计

- **默认试演**，`--apply` 才写入；每次写入前把原文件**整份复制**到 `backups/<ISO时间>_<命令>_<短id>/`，并写 `manifest.json`（含原始路径），供 `restore` 使用。
- 写入前先在**镜像**上跑一次**真实加载器**（桌面版 Electron 当 node 跑 `verify_loader.mjs`），通过才动真文件；写入后再复核一次（盘上 + 真实加载器）。
- 重压日志帧时固定 `ZSTD_c_checksumFlag = 1`，与原格式一致。
- **写盘是原子的**：改会话日志与写缓存都先写成同目录的 `dsac-write.tmp`，再 `rename` 覆盖目标。助手若在写盘中途被杀（关机、菜单「重启」的连带清理、任务管理器结束进程），盘上只会是「改前的完整版」或「改后的完整版」，不会留下半截日志；临时文件名刻意不含 `session.v`，免得被会话扫描（只认 `session.v<数字>.jsonl(.zstd)`）当成一份代际日志。
- `orphans` 只动 `storages/session_projcache/sessions/` 下的缓存文件，不碰会话目录。
- `purge` 会备份**全部 generation 日志**（`session.v3/v4…`）与缓存，然后删除会话目录；`restore` 会重建目录。
- 自动清理助手（2.2）**只被架设、绝不在本进程里动手**：它等 DSH 的 pid 消失，用「pid ＋ 时间戳」的锁保证同时只有一个
  助手在跑（若那会儿确有另一个助手在收尾，本次助手最多等 3 分钟再决定，不会一见锁就白跑一轮）。若那一刻还有别的
  DSH 实例在运行，它**不放弃、继续等** —— 等到机器上真的没有任何 DSH 了再动手，只有等到 72 小时上限仍没等到才记一条
  「本次跳过」。**判定「另一个实例」必须按命令行分角色**：一个 DSH 实例同时有五六个同名进程（Electron 主进程、GPU、
  网络、渲染、host），工具 runner 与助手自己也是同一个 exe，只按镜像名数会把**一个**实例报成五个；所以只有**主进程与
  host 进程**（会话存储的属主，也是被等的那个 pid）算实例，助手自己、被等的 pid、Electron 子进程与 runner 一律不算。
  「零实例」还要连续确认 3 轮（≈4.5 秒）才动手：清理一次要几十秒，若中途新实例的 host 打开了会话存储，就正好撞上我们
  写盘。然后走与 `dismiss --all --apply` 一模一样的备份 → 镜像自检 → 真实加载器复核流程。开关在会话中途关掉也不需要
  杀进程：还在等的助手会重读 `auto-arm.json` 后原样退出；宿主进程重启过、而上一轮那个助手还在等同一个 pid 时不会再架
  第二个。若这一轮已经被**更新的一轮**接手（`auto-armed.json` 指向另一个被等的 pid、且它的助手还活着），旧助手会让位
  退出 —— 新一轮助手会在真正的退出窗口动手，清理的是同一批会话，不会漏活。
  （实测教训：DSH 应用菜单里的「重启」是 `app.relaunch(); quitWithoutConfirmation()` —— 新实例先起来、旧实例后退出，
  两者重叠一两秒；旧版助手宽限 10 秒后看见新实例就跳过，于是**每一次重启都跳过**，一整轮退出窗口白丢。
  这种重启链里根本不存在「没有实例」的空档，所以真正的清理只会发生在你**完全关掉** DSH 的那一刻。）
- **动手之后每一步都留痕**：`say()` 的输出对脱离进程是丢弃的（stdio=`ignore`），1.3.6 及以前「开始动手」与「完成」之间
  一行日志都没有 —— 助手若在这中间被杀，事后完全看不出它走到哪一步。1.3.7 起清理过程逐步写进 `auto.log`（开始动手＋
  待处理会话数、每个会话的 id 与大小、每个会话的结果、完成汇总），设置页也把最后 8 行直接摆出来（「助手日志最后几行」）。
  同一个版本还修了两处：①每处理一个会话前重判一次实例，一旦发现新实例已经起来就**当场停手**（已改的保留，报告标
  `aborted: "new-instance"`，剩下的留给下一次）—— 宁可不做，也不在别人可能已经打开的会话上继续写；②所有退出路径
  （让位、开关关掉、跳过、完成）都**交还锁**，不再把死锁留在盘上让下一个助手空等 3 分钟。
- **静默失败必须能被看见**：宿主半每次架设助手都会把「谁在等谁」写进 `auto-armed.json`，助手等待期间每 60 秒把
  「最后活着的时刻」写进 `auto-heartbeat.json`；下次启动时如果发现那个助手已经不在了、却没有比架设时间更新的报告，
  设置页就会写明「上一轮退出窗口里的助手没留下任何报告」，并**只在真的还有待清理条目时才标红**（没有活可干时跳过
  这轮没有实际影响）。文案不再声称「在 X 之后就消失了」——那是架设时间，不是消失时间；有心跳时会写「最后一次心跳
  …，现已不在」。每个终局都会留一份报告：成功、超时、另一个实例在跑、开关关闭、抢不到锁，外加 1.3.4 新增的
  助手自身崩溃（`helper-crash`）与列会话失败（`list-failed`）——助手外壳挂了 `uncaughtException` /
  `unhandledRejection`，所以下一轮永远能分辨「它崩了（附错误原文）」和「它被连带杀了（心跳停在某刻）」。
  （实测教训：手动架设的助手会随宿主工具的进程树一起被杀 —— 退出窗口里什么都没发生，盘上也没有痕迹。）
- **CLI 的会话扫描是增量的**（1.3.8）：一个会话日志动辄几十 MB、上万帧，而 zstd 只能**逐帧**解压（把多帧拼在一起的
  buffer 丢给一次 `zstdDecompressSync` 只会解出第一帧），全量解析要好几秒 —— 当初设置页每打开一次都全量解析，
  面板就明显卡住。现在把每个日志的「帧数／行数／自己的条目数」连同「已解析到第几个字节」和那一段的 sha256 记进
  `<状态目录>/scan-cache.json`：大小与 mtime 都没变就直接复用；变大了且前缀 sha256 仍一致就只解压新追加的尾部；
  其余情况（被重写、变小、继承条数变了、解析出错）一律整份重解 —— 缓存只负责加速，任何情况下算出来的数字
  都与全量解析一致；状态目录不可写时自动退化成全量解析。（本机实测 49.8 MB / 5 个会话：4.7 秒 → 25 毫秒。）
  1.3.9 起面板自己不再调用它，只有 `list`／`dismiss` 与退出时的助手在跑。
- **面板不再加载孤儿投影缓存，也不再逐个解压会话**（1.3.8／1.3.9）：逐条读那些残骸只为了列一张没人看的清单，
  几十个就会拖慢打开设置，而它们只占缓存体积、不影响界面。需要清时手动跑 `orphans --apply`；面板现在只读目录名
  （打开即完成），并在「按会话」原来那一块用几段说明讲清「如何锁定或删改本地会话日志？」
  （`$DSH_HOME/sessions/<工作区哈希>/`，`session` 开头＝父会话、裸 uuid＝子代理；缓存路径；
  只删「不以 session 开头的那两份」的做法）。
- **分叉会话（fork）**：这类日志前半段是父会话的**继承区**（`identity.inheritedEventCount`），里面可能也有父会话的
  `subagent/catalog` 行。它们不归本会话，清理时**逐字节保留**，自检也**不能**把它们算作「剩余 catalog」——
  否则只要日志里有继承来的 catalog 行就会恒判自检失败、一个分叉会话也清不掉。清理后投影缓存写成
  `{"inheritedEventCount":N}`（不继承父会话的目录，父会话自己那份照旧）。

## 六、怎么证明它是对的

- **自带回归测试**（不碰真实数据）：`node test/selftest.mjs` → **65/65 通过**（假 `DSH_HOME`，覆盖 list／orphans／purge+restore／dismiss 安全闸／离线变换／restore 回滚，自动清理的「是不是还有另一个 DSH 实例」判定——它**不能**把助手自己算进去、**也不能**把 GPU／渲染子进程与工具 runner 算成实例，也不能把「本实例主进程还没退完」说成「另一个实例」，**分叉会话**：继承区里的 catalog 行必须逐字节保留、自己那几条必须改掉、缓存写成带 fence 的空状态，「上一轮助手没跑完就不能静默」的判定，助手心跳只在属于那个助手时才被采信，重启链里的让位规则：**只有**更新的一轮的助手还活着时旧助手才让位，新助手已经不在了就留下来当备胎，写盘原子性：字节原样落盘、不留临时文件、`dismiss` 之后会话目录里也没有残留，退出前交还锁：自己的锁删掉、别人的锁一律不动，以及扫描缓存的三条路径：追加一帧只解压尾部、文件被整份重写（哪怕变大）必须整份重解、变小后不残留旧计数）；带真实日志 fixture 时 **68/68 通过**（见下条）。
- **两半插件各自的离线探针**（不启动 DSH、不碰会话存储）：
  - `npm run probe:client` → `VERDICT A=PASS B=PASS C=PASS`：伪造 `window.__ModuleLoader__` 与极简 React，证明设置页座位只注册一次、`slots` 服务迟到时靠 `internal/service` 补挂且幂等、宿主没有 `slots` 时也不抛。
  - `npm run probe:host` → `VERDICT PASS`：用假请求驱动宿主半的两条路由 —— 栅栏 403／405、`scan` 返回体形状、`POST /settings` 的全部分支（坏体、无可写字段、关、开、不重复架设）。它会先备份再还原 `auto-arm.json`，并以 `DSAC_ARM_DRYRUN=1` 干跑，**不开真进程、不跑任何清理**。
- **自动清理助手实跑**：开关关闭时 `clean.mjs autowait` 打印「开关关闭，未做任何改动。」（exit 0）；被等的 pid 一直不消失时写出 `{"ran":false,"why":"timeout",…}` 到 `auto-report.json` —— 两次都没碰任何会话日志。**1.3.7 的端到端实跑**（假 `DSH_HOME` ＋ 假状态目录，拿真实日志当素材、`--no-app` 跳过真实加载器）：助手把 11443 行 / 12,622,844 B 的会话里 **22 条** catalog 全部改写（`catalog 0 / dismissed 22`，**行数不变**），`auto.log` 留下「开始动手，待处理 1 个会话 → 处理第 1／1 个会话 …（12327 KB）→ 改写 22 条 → 完成，处理 1，改写 1，失败 0」，报告 `processed:1, cleaned:1`，退出码 0，`auto.lock` 不残留。
- **真实日志逐字节一致**：用一份真实会话日志（11443 行 / 12,622,844 B）跑
  `node test/selftest.mjs --fixture <日志> --expect-sha256 B51E6D96F3B4CF922282ECA1BBD11BE175EB9D64EAC676F37F746DAB619C3EBA`
  → 产物 sha256 与人工验证过的修复结果**完全相同**。
- **完整端到端**（真实桌面版 + 假 home）：dismiss 后 12,622,844 → 12,624,094 B（sha `B51E6D96…`），镜像与实时两处真实加载器均 `OK 投影条目=0`，缓存 117,693 → 111,544 B；`restore` 后回到 12,622,844 B（sha `2140EFC1…`）与原始缓存，**逐字节相同**。
- 语法检查：`node --check clean.mjs`。

## 七、注意

- 改完**必须完全退出并重启 DSH**，否则界面上看不到效果。
- 不要把备份目录放进 `$DSH_HOME/sessions/` 里（会被当成会话目录）。
- 想少踩这个坑：少派长命的 continuable 子代理，批量任务优先用 workflow。
- DSH 升级后会话格式可能变化，届时请重新核对本文的「机制」一节。

## 八、许可

MIT，见 [LICENSE](LICENSE)。
