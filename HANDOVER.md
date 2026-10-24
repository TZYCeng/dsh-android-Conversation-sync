# 交接文档 — dsh-mobile-sync v0.4

> 更新于 2026-10-25 01:40。读完这份就能接着干，不需要回看聊天记录。
> 操作手册见 [docs/USAGE.md](docs/USAGE.md)；v0.3 的现状见文末第 12 节（保留作为历史）；v0.2 在第 12 节末。

## 0. 一句话现状

v0.4 在 v0.3 的基础上修掉真机上「同步了模型却没有 key」的问题，并通过 **8 套单元测试 + 一次真 curl/tar/pair 往返**。

v0.3 已落地的六条要求（仍然有效）：

1. 插件**默认全不勾**；
2. 技能**默认全不勾**；
3. 已归档会话**默认不同步**；
4. 模型**按组**列出（`llm-pi-ai` 里每个 `config.providers.<名字>` 算一组，插件声明的 provider 也算），**每组一个同步开关**；
5. 面板显示**手机端与电脑端的工作区**，默认**同名对齐**，也可以把某个电脑工作区**改投到手机上任意一个工作区**（双向生效）；
6. 面板新增**「开始同步」按钮**：手机脚本下载后**只配对+等待**，点按钮后双方才开始同步。

v0.4 新增：

7. **密钥跟着模型组走**：勾一组 = 这组的配置 + 这组引用的 `refs:` 一起写到手机 `.credentials.yaml`；
   每组还有独立的「密钥」开关（默认随组开）、「全带密钥 / 全不带」批量按钮、缺密钥的行会标红。
   根因与实现见第 2.3、2.4 节。
8. 仓库建立（`.gitattributes` / `.gitignore`），推送到 `https://github.com/TZYCeng/dsh-android-Conversation-sync`。

代码是 junction 挂载，**不需要重装，但要重启 DSH 才会加载新的宿主端代码**；手机端脚本每次从 `/join.sh` 现取，改了立即生效。

## 1. 项目与环境

| 项 | 值 |
| --- | --- |
| 仓库/工作区 | `D:\code\dsh-android-Conversation sync` |
| 包名 | `dsh-mobile-sync` **v0.3.0**（`type: module`） |
| 桌面 DSH 运行时 | `C:\Users\wangc\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（0.2.1-rc.2） |
| 桌面 node（有 zstd） | `C:\Users\wangc\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0） |
| DSH_HOME | `C:\Users\wangc\.dsh`（profile = `desktop`） |
| 桌面会话 | `C:\Users\wangc\.dsh\sessions\<项目键>\<会话 id>\session.v4.jsonl.zstd` |
| 桌面索引 | `C:\Users\wangc\.dsh\storages\workspace.json` |
| 插件安装方式 | profile `package.json` 的 `dependencies: "dsh-mobile-sync": "link:D:/code/dsh-android-Conversation sync"` + `dsh.profile.bundles`；`profiles/desktop/node_modules/dsh-mobile-sync` 是指向工作区的目录联接 |
| 运行状态 | `~/.dsh/dsh-mobile-sync/state.json`，监听 `8733`（占用则顺延到 8740） |
| 手机端 | APK `com.dsharnessmobile.shell`（DeepCode），`$DSH_HOME=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh`，引擎 `@deepseek-ai/dsh` 0.2.0-rc.2 |
| 探针工具 | `node tools/catalog-probe.mjs [DSH_HOME]` 只读打印面板看到的一切（通道、逐项开关、模型分组、技能摘要） |

## 2. v0.3 交付了什么

### 2.1 用户这次的六条要求，分别落在哪儿

| 要求 | 实现 | 验证 |
| --- | --- | --- |
| 插件默认全不勾 | `lib/channels.js` 的 `ITEM_DEFAULTS.plugins=false`；`selected(..., false)` 贯穿 controller/transfer | `test/transfer.mjs`（`itemSelected` 三条、默认即 off）、`test/client.mjs`（默认勾选数） |
| 技能默认全不勾 | 同上 `ITEM_DEFAULTS.skills=false` | 同上 |
| 已归档会话默认不同步 | `includeArchived` 默认 false；**状态文件升级只做一次重播种**（`defaultsRev`，见 4.2） | `test/transfer.mjs`「archived sessions stay home by default」 |
| 模型不管插件加载与否都按组分、每组一个开关 | `lib/models.js::listModels` 产出 **group**：`kind:'row'`（整行自带 endpoint）或 `kind:'provider'`（`config.providers.<名字>`）；扫描 profile patch **和**每个已装插件的 bundle patch；`key = rowId` / `rowId/provider` | `test/models.mjs`（嵌套 provider、插件组）、`test/transfer.mjs`（模型下发）、`tools/catalog-probe.mjs`（本机 6 组） |
| 对话同步显示双方工作区、默认同名、可改投 | `lib/index-sync.js::mapWorkspace` 支持 `workspaceMap[desktopId]=phoneId`；新增 `mapDesktopWorkspace` 做反向映射；`lib/controller.js::workspaceCatalog` 输出两边清单；`client.js` 每个电脑工作区一个下拉 | `test/transfer.mjs`「workspace pairing」三条（桌面→手机、手机→桌面、清空恢复同名） |
| 新增同步按钮，脚本下载后不自动同步 | 状态 `request`；路由 `GET /api/await`（长轮询 25s）、`POST /api/done`；面板「开始同步」→ action `request-sync`；手机 `pair` 模式只安装+等待 | `test/entry.mjs`（request/cancel/配对 action）、`test/client.mjs`（按钮发 request-sync）、`test/phone.sh` 第 7 节（真等待→取指令→上传下载→done，且上传在取指令之后） |

### 2.2 模型通道：从「0 行」到「6 组」

旧实现只认顶层行自带 `baseURL`，本机所有 endpoint 都在 `llm-pi-ai` 的
`config.providers.<名字>.baseURL` 下，所以永远是 0 个。现在：

```
llm-pi-ai/opencode-go     30 个模型   （无 baseURL，插件/默认端点提供）
llm-pi-ai/grok             3 个模型   https://wecodex.lol/v1
llm-pi-ai/chatgpt          3 个模型   https://wecodex.lol/v1
llm-pi-ai/openaimage       3 个模型   https://wecodex.lol/v1
llm-pi-ai/opencode-free    9 个模型   http://127.0.0.1:19395/v1
llm-pi-ai/yujianwudi      50 个模型   https://yujianwudi.net/v1
```

下发时**不是**再追加一个 `- id: llm-pi-ai`（patch 同 id 会整块替换 config，那样会把手机自己的
provider 全冲掉），而是把 provider 子树**缩进后并入手机已有的那一行**的 `config.providers`；
手机没有这一行才新建。`test/models.mjs` 覆盖了「手机已有自己的 provider」「手机没有该行」
「重复合并 byte 相同」三种情况。

### 2.3 顺手修的三个真 bug（都会导致「同步过去但看不见」）

1. **`lib/slug.js` 与内核算法不一致**（v0.2 已修，勿回退）。`test/host.mjs` 逐个反查真实目录（当前 5/5）。
2. **改写 `cwd` 后文件没搬家**（v0.2 已修）。`mergeOne` 在所有结局下都会把日志挪到 `projectKey(新 cwd)`。
3. **`isScratchWorkspace` 范围过宽**（v0.2 已修，只认最后一段）；v0.3 把手机侧的 `incoming` 也从工作区配对里过滤掉。

### 2.4 为什么同步了模型却「没有 key」（v0.4 的根因与修法）

真机反馈：只有 `opencode-go` 能用，其它组报「未检测到环境变量，请填写 API 密钥，或设置环境变量 GROK_API_KEY」。

读内核源码（`app.asar` 里的 `@deepseek-ai/dsh-llm-pi-ai`）可以确定三件事：

1. `resolveApiKey()` 只在 profile 有 `apiKeyEnv`（或 `apiKeyRef`）时解析密钥，来源只有两处：
   `ctx.credentials`（`<DSH_HOME>/.credentials.yaml` 的 `refs:`）或**启动时**的环境快照。
2. 解析不到就抛 `MISSING_CREDENTIAL`，**不会**回落到 pi-ai 自己的环境发现。
3. 手机原来的 `llm-pi-ai` 行只有 `opencode-go: { apiKeyEnv: OPENCODE_GO_API_KEY }`，而手机上的
   `.credentials.yaml` 里恰好有 `OPENCODE_GO_API_KEY` —— 所以只有它能跑。

本机 credentials 里 `GROK_API_KEY` / `CHATGPT_API_KEY` / `OPENAIMAGE_API_KEY` / `YUJIANWUDI_API_KEY` 都有，
但它们从来没被发到手机：模型组的合并只搬 `cordis.patch.yml`。而且 v0.3 把 provider 子树整段复制过去时，
连 `apiKeyEnv: GROK_API_KEY` 这一行也会到手机，于是手机开始报一个它根本没有的名字。

修法（v0.4）：模型通道里**密钥跟着组走**。勾一组 = 同时准备「这一组的配置」和「这一组引用的 refs」。

| 组件 | 改动 |
| --- | --- |
| `lib/channels.js` | 新增 `modelKeys`（每组密钥开关，默认随组）、`secrets` 默认改为 **true**；`SELECTION_KINDS` 允许 `modelKeys` 走 `setSelected`/`setSelectedAll` |
| `lib/models.js` | `KEY_REFS` 补上 `apiKeyEnv`（此前只认 `apiKeyRef`/`apiKey`/`keyRef`），provider 组能把密钥名解析出来 |
| `lib/transfer.js` | `planPull` 模型段：按 `keyWanted()` 汇总 refs；手机没上报 credentials 时用 `version: 1` 骨架生成**完整文档**（只写 `refs:` 会被 dsh 拒绝）；缺 ref 会写进日志警告 |
| `lib/controller.js` | action `set-key` / `set-keys-all`；status 里每组带 `keySelected` / `missingKeys` / `secrets` |
| `client.js` | 每组行上一个「密钥 ✓/✕」子开关 + 缺密钥红标；模型卡片上加「全带密钥 / 全不带」；总开关关着时红字提示 |
| 测试 | `test/transfer.mjs`（带密钥、关组钥匙、关总开关、手机无 credentials 生成骨架）、`test/entry.mjs`（set-key / set-keys-all 落盘）、`test/client.mjs`（8 个开关、密钥子开关） |

仍然存在的边界：**总开关默认开**意味着第一次同步会把电脑的 `refs:` 合并进手机的密钥文件；
不想要就把「同步 API 密钥」关掉，或者逐组关掉密钥。面板上写得明明白白。

### 2.5 仓库与发布

- `git init` 建立本地仓库，`main` 分支，`origin = https://github.com/TZYCeng/dsh-android-Conversation-sync`。
- `.gitattributes` 统一 LF（`*.cmd` 例外），`.gitignore` 忽略测试遗留与系统垃圾。
- 本仓库不含任何密钥：`~/.dsh/.credentials.yaml` 在 DSH home，**不在**仓库目录里。
- 推送用 Windows 凭据管理器（`credential.helper=helper-selector`）；第一次推可能弹登录框，选 GitHub 授权即可。

## 3. 协议（手机端只看这一个东西）
一切都是「桌面算好、手机照做」。手机只认文件布局，**不解析 JSON**：

**push（手机 → 桌面）**
```
--<项目键>--/<会话 id>/session.v4.jsonl.zstd      会话日志（顶层，不带 sessions/ 前缀）
_meta/phone.env             key=value：device / home / sessions / profile / profileName
_meta/plugins.txt           "<包名> <版本>" 每行一个
_meta/skills.txt            每行一个已装技能名
_meta/sessions.txt          "<会话 id> <字节数>" 每行一个（重复同步靠它跳过）
_meta/index.json            手机的 workspace.json（工作区配对靠它）
_meta/profile/package.json  手机 profile 的 package.json（manifest profile=1 时）
_meta/patch/cordis.patch.yml  手机 patch 层（manifest models=1 时）
_meta/patch/credentials.yaml  手机 .credentials.yaml（manifest secrets=1 时）
```

**pull（桌面 → 手机）**
```
sessions/<手机项目键>/<会话 id>/session.v4.jsonl.zstd   头部 cwd 已改写成手机目录
_meta/index.json            合并好的索引，原样覆盖（先备份）
_meta/profile/package.json  已把新 bundle 写进 dsh.profile.bundles
_meta/plugins/<包名>/…      整个目录替换 node_modules/<包名>
_meta/skills/<名字>/… 或 <名字>.md   落到 $DSH_HOME/skills/
_meta/patch/cordis.patch.yml 已合并的模型组（provider 并进对应行）
_meta/patch/credentials.yaml 已合并的 refs（默认不发）
_meta/readme.txt            这次做了什么、要不要重启
```

**HTTP**
| 路由 | 用途 |
| --- | --- |
| `GET /api/ping` | 存活 + 会话数 |
| `GET /api/manifest` | 纯 key=value：sessions/models/plugins/skills/secrets/profile/desktop/**manual=1**/**request=** |
| `GET /api/await?timeout=25` | **长轮询**：桌面点了「开始同步」就返回 `request=<id>`（并标 taken），超时返回 `request=0` |
| `POST /api/done?request=<id>` | 手机报告这次同步完成（面板据此显示「同步完成 hh:mm」） |
| `POST /api/push` | 上传包 |
| `GET/POST /api/pull` | 下发包 |
| `GET /join.sh` | 把 `__BASE__/__TOKEN__/__NAME__` 烤进脚本（仍然用 `?t=`，只有这一次） |

鉴权：所有 API 走 `X-DSH-Sync-Token` 头；查询串 `?t=` 仅为兼容旧脚本保留。

**手机模式**：`pair`（默认，装好+等待）/ `wait` / `watch`（后台等待）/ `both|push|pull`（显式手动跑一次）/ `status` / `install`。

## 4. 状态文件（`~/.dsh/dsh-mobile-sync/state.json`）

### 4.1 形状

```jsonc
{
  "token": "…", "port": 8733, "preferred": null, "log": [], "imported": {},
  "sync": {
    "channels": { "sessions": true, "models": false, "plugins": true, "skills": true },
    "plugins": { "dsh-whale-widget": true },      // 点过的才算数；没点的按默认 off
    "skills":  { "session-sync": false },
    "models":  { "llm-pi-ai/grok": true },        // 键是模型组 key
    "secrets": false, "mode": "auto", "includeArchived": false,
    "phoneRoot": "/storage/emulated/0/DSH", "desktopRoot": "C:\\Users\\wangc\\DSH",
    "workspaceMap": { "<电脑工作区 id>": "<手机工作区 id>" },
    "force": false,
    "defaultsRev": 2
  },
  "peer":  { "device": "23116PN5BC", "at": …, "home": "…", "plugins": {"dsh-pet":"0.3.8"}, "skills": ["…"] },
  "request": { "id": "7bba2edc", "at": …, "status": "pending|taken|done", "doneAt": … },
  "sent":  { "plugins": {"x":{"version":"1.0.0","at":…}}, "skills": {"y":{"digest":"…","at":…}}, "patch": null, "credentials": null }
}
```

`~/.dsh/dsh-mobile-sync/peer/` 缓存手机上次上报的 `index.json` / `package.json` / `cordis.patch.yml` / `credentials.yaml` / `sessions.txt`
——下发时要**向这些文件里合并**，不是覆盖，否则会丢掉手机自己的东西；工作区配对也靠这份 `index.json`。

### 4.2 一次性升级（`defaultsRev`）

旧状态文件没有 `defaultsRev`。首次加载时 `normalizeSync` 判定 `rev < 2`，做一次重播种：
清空 `plugins/skills/models` 的逐项选择、`includeArchived=false`，然后写入 `defaultsRev: 2`。
之后再也不会覆盖用户点过的值。**这是用户要求「默认全不勾 / 归档不同步」落到已有安装上的方式。**
插件启动时会**立即把归一化后的 state 写回一次**（`createController` 里，`readOnly` 探针除外），
所以重播种只发生一次，新字段（`workspaceMap`、`request`）也会落盘。

## 5. 代码地图

```
index.js              宿主入口：起监听 + 两条 connection.fetch 路由（status / action 全转发给 controller.act）
client.js             侧栏面板：开始同步按钮、通道 chips、工作区配对下拉、逐插件/逐技能/逐模型组开关、二维码、日志
lib/controller.js     状态文件、LAN 监听、路由（含 /api/await、/api/done）、工作区清单、面板状态与动作
lib/transfer.js       两个方向的规划：ingestPush / planPull（工作区映射、模型组合并）
lib/channels.js       通道默认值、逐项默认 off、workspaceMap、持久化形状、defaultsRev
lib/index-sync.js     workspace.json 读/合并/原子写 + 按标题/路径找工作区 + mapWorkspace / mapDesktopWorkspace
lib/sessions.js       扫描、多帧 zstd、cwd 改写、归一化摘要、合并、目录迁移
lib/slug.js           projectKey 的精确复刻
lib/plugins.js        枚举 profile 插件、判断能否搬、读文件、bundle patch 路径
lib/skills.js         枚举 skills 根：frontmatter、目录/平铺、去重、内容摘要、读文件
lib/models.js         模型分组（整行 / config.providers 下的 provider / 插件 patch）、patch 与 credentials 合并
lib/patch.js          patch 文件整块文本编辑（按 id 替换/追加，注释原样保留）
lib/tar.js            零依赖 tar 读写（ustar + 读 GNU/pax）
lib/phone.js          把配对值烤进手机脚本（每次现读模板）
lib/qr.js             QR SVG；lib/vendor/qrcode.cjs
mobile/dsh-sync.sh    手机端脚本：pair→await→push/pull→done；按目录落位
tools/catalog-probe.mjs  只读探针，打印通道、逐项开关、模型组
tools/plan-probe.mjs  只读 dry-run 下一次下发
tools/panel-probe.mjs 用真实目录把侧栏面板渲染一遍（只读），排「面板白屏/字段没接上」
test/                 run.sh + 8 个套件 + phone.sh（含新的 pair 等待验证）
```

## 6. 怎么跑测试

```sh
NODE=C:/Users/wangc/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe \
  sh test/run.sh 8833
```

- 只跑单元：加 `SKIP_SHELL=1`；单个：`node test/{host,entry,client,qr,plugins,skills,models,transfer}.mjs`
- 手机往返用 `test/fixture.mjs` 起一个假桌面：`DSH_FIXTURE_ARM_MS=4000` 会在 READY 4 秒后自动点一次「开始同步」，
  `test/phone.sh` 第 7 节据此验证「先等待、收到指令、才上传」。
- 注意：**并发跑两个 bash 会话会撞 DSH 的 bash IPC**（`CreateFileMapping … Win32 error 5`）。串行跑，或改用 `pwsh` 跑 node。
- Windows Git-Bash 下 `kill` 一个卡在 `curl` 里的 `sh` 不一定能送达 SIGTERM，测试里用 `kill -9`；脚本自身对 INT/TERM 的 trap 会 `exit`，真机 Ctrl-C 有效。

真机/真目录只读体检：

```sh
node tools/catalog-probe.mjs C:/Users/wangc/.dsh   # 通道/逐项开关/模型组
node tools/panel-probe.mjs C:/Users/wangc/.dsh --text   # 用真实数据把侧栏面板渲染一遍（node 24）
```

当前这台机器的输出：13 个插件（7 个可搬）、2 个技能、**6 个模型组**（全部默认不勾）。

## 7. 已验证 / 未验证

**已验证（自动化）**
- 合并规则、多帧解码、`cwd` 改写后搬家、索引登记、备份、端口回退、令牌、tar 长路径（`test/host.mjs`）
- 内核式加载 `index.js`、两条路由、`restart` / `reset-token` / `rescan`、**request-sync / cancel-sync / workspace-map**（`test/entry.mjs`）
- 面板：通道、逐项开关、**开始同步按钮**、**工作区配对 select**、**模型分组**、二维码、日志（`test/client.mjs`）
- 插件/技能/模型三类枚举（各自套件），模型含嵌套 provider 与插件组
- 同步规划：逐项开关（默认 off）、版本/摘要/字节数跳过、单向、force、索引与 cwd 映射、**双向工作区配对**、profile 合并幂等（`test/transfer.mjs`）
- 手机脚本：真 `curl` + 真 `tar` 往返，第二遍为空；**pair 模式等待按钮后才上传/下载并回报 done**（`test/phone.sh`）

**没验证（需要真机）**
- 真 Android 上 mksh + Termux 的长轮询（`curl --max-time 35` 对 25s 服务端等待）行为
- 手机上覆盖 `workspace.json` 后 DSH 是否需要重启才重读（脚本会提示重载）
- 装上插件/改完 patch 后手机是否需要重启（readme 会提示重启）

## 8. 已知限制 / 下一步

1. **模型组只搬「配置文本」**：provider 子树按 YAML 缩进并入手机 patch；插件在运行时动态注册的 provider（如
   `dsh-opencode-free` 的 index.js）即使勾选，手机也需要装对应插件才有进程内的代理端口。面板对插件组标
   「插件提供」，插件本身没勾时会标「插件 X 未勾选」。
2. **模型能跑起来，除了配置还要「密钥」**（v0.4 修）：`@deepseek-ai/dsh-llm-pi-ai` 的 `resolveApiKey` 只接受
   ①`apiKeyEnv` / `apiKeyRef` 指向的名字在 `ctx.credentials`（即 `<DSH_HOME>/.credentials.yaml` 的 `refs:`）
   或启动环境里有值；**否则直接抛 `MISSING_CREDENTIAL`**，连 pi-ai 自身的环境发现都不会走。
   实测：把 `config.providers.grok.baseURL` 加进手机 patch 后，手机报
   「没有 key … GROK_API_KEY」。所以 v0.4 给模型组加了**逐组密钥**：勾选时自动把该组引用的 `refs` 一并下发，
   每组行上还有「密钥」勾。见第 2.4 节。
3. 会话每次都要读全量文件判断大小（445 条约 17 MB 读取，不传输）。真正下发只在大小不同的时候。
4. 取消勾选不会卸载手机上已装的插件/技能（只是不再推送）。
5. 子代理会话（`origin: "subagent"`）两个方向都不同步；插件也从不降级。
6. 桌面 DSH 正在运行时，它可能用内存里的索引覆盖我们写的 `workspace.json`。写完之后**重载界面**是最稳的。
7. 上传包上限 256 MB；一次下发最多 48 MB 插件 + 8 MB 技能。
8. `state.json` 的 `sent.*` / `imported` 会慢慢变大（有上限，可忽略）。
9. 面板的「开始同步」要求手机在 `pair`/`wait`/`watch` 模式里（有长轮询），否则请求会等 5 分钟过期；过期后重点一次即可。
10. 旧版手机脚本的 `auto [秒]` 后台循环如果还在跑，会按旧定时器执行 `both`，绕过按钮。升级后要重启手机 App
    （或结束旧循环），新脚本不再提供定时同步。
11. **手机端密钥是明文**：`.credentials.yaml` 必须整份覆盖，不能只追加 `refs:`（dsh 会拒绝“只有 refs 的文档”）。
    因此手机原有的 refs/records 先随上传报回桌面，桌面合并后再整份下发——这意味着第一次同步会覆盖手机上的密钥文件，
    所以「同步密钥」默认关闭，勾选时面板会写明这一点。
12. **不假设 `.env` 可用**：内核按「credentials 存储 → 启动环境 → 项目 `.env` → `$DSH_HOME/.env`」取密钥，
    但桌面/手机的启动器是否真会注入 `.env` 没有实证。所以密钥一律写进 `.credentials.yaml` 的 `refs:`
    （存储优先级最高，热重载），不依赖环境变量。
## 9. 坑（都踩过了）

- bundle patch 的 `id:` 行不能有行尾注释，且 `id` 必须等于包名，否则内核 preflight 直接拒绝。
- **patch 里同 id 的条目是整块替换 config**：所以 provider 只能并进已有条目，不能追加第二个 `- id: llm-pi-ai`。
- **patch 块里允许出现列 0 的注释**（本机 `llm-pi-ai` 块尾部就有 4 行）。计算缩进/分节时必须跳过注释行，
  否则 provider 会被当成 0 缩进而整个解析失败（v0.3 踩过，`sectionEnd`/`providerEntries` 已处理）。
- `lib/vendor/qrcode.cjs` 必须是 `.cjs`（UMD 在 `type: module` 下会被当 ESM）。
- 手机 `tar -z` 必挂（不能 exec gzip）；一律 `tar cf - … | gzip` / `gzip -dc … | tar xf -`。
- `/storage/emulated/0` 是 noexec：辅助脚本要用 `sh <path>` 调，或放 `$HOME`。
- `/tmp` 在部分镜像不可写：用 `$TMPDIR`，再退到 `$HOME`。
- 并发 bash 会话会撞 IPC（见第 6 节）。
- 手机端脚本模板每次现读，别缓存（`lib/phone.js`）；`install` 现在优先重新 `curl` `/join.sh`，
  所以从管道里跑（`$0` 是 `sh`）也能装好。
- 换行：`lib/patch.js` 会把 CRLF 归一成 LF，`digestText` 也一样，所以判「变了没有」不受换行影响。
- 定时器/长轮询：`handleAwait` 里每 500ms 轮询一次 `pendingRequest()`，超时返回 `request=0`；不要改成
  无限 await 一个 Promise，否则监听停止时请求会挂住。

## 10. 逐项默认值一览（v0.3）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 会话通道 | 开 | 整个功能的目的 |
| 插件通道 | 开（但逐项全不勾） | 打开通道只代表「允许这类数据流动」 |
| 技能通道 | 开（但逐项全不勾） | 同上 |
| 模型通道 | 关 | 需要先打开通道再勾组 |
| 每个插件 | 不勾 | 勾了才推 |
| 每个技能 | 不勾 | 勾了才推 |
| 每个模型组 | 不勾 | 勾了才推 |
| 已归档会话 | 不同步 | 面板上「含已归档会话」打开才带 |
| API 密钥 | 不同步 | 打开时面板写明明文 LAN |
| 工作区配对 | 空 = 同名对齐 | 找不到同名就落到 `<根目录>/<标题>` |

## 11. 用户情绪与偏好

- 中文交流，要「能看见效果」，讨厌「文件同步了但界面看不到」。
- 喜欢具体证据（命令输出、数字、对比），不接受空泛承诺。
- 时间紧，倾向「先能跑再完善」。
- 这次特别强调：**默认不要替用户做决定（全不勾）**、**不要自动同步（按钮）**、**模型要看得见分组**。

## 12. v0.2 状态（历史，2026-10-24）

v0.2 写了四条通道 + 逐插件/逐技能开关 + 四条 bug 修复（slug、cwd 搬家、scratch 判定、索引可见性），
但插件/技能默认全勾、模型通道因嵌套 provider 为空、没有手动同步按钮、工作区只能同名配对。
v0.3 在这四项上做了替换式升级，其余协议（push/pull 布局、tar、鉴权）保持不变。

## 13. v0.1 状态（历史，2026-10-23）

v0.1 只做会话文件双向同步：桌面起令牌保护的 LAN 服务，手机 `curl|sh` 拉脚本，手机端 `tar -z` 在真机上必挂，
靠手机 agent 加 shim 才跑通。工作区索引/模型/插件/侧栏开关只写了 `lib/index-sync.js` 没接线。
