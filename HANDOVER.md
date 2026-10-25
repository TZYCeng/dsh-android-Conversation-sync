# 交接文档 — dsh-mobile-sync v0.5.1

> 更新于 2026-10-25。写给要接手、改代码、开分支的人：**读完这一份就能干活**，不需要翻聊天记录。
> 用（装、扫码、点按钮）看 [README.md](README.md) 和 [docs/USAGE.md](docs/USAGE.md)；这一份讲**它为什么长这样、怎么改、怎么验证**。

---

## 0. 先说三件事

1. **手机端依赖 [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)**。
   本项目只对那个 App（`com.dsharnessmobile.shell`，界面叫 DeepCode）做过验证：它内置 Termux，
   有 `sh`/`curl`/`tar`/`gzip`，`$DSH_HOME=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh`。
   **别的手机端很可能不兼容**——协议只依赖「文件布局 + 几个 HTTP 路由」，换端时请对照第 3 节逐条核对，
   或者直接改 `mobile/dsh-sync.sh`。
2. **宿主端改完要重启 DSH**（插件是目录联接挂进 profile 的，不重启不生效）；**手机脚本不用重装**，
   每次 `pair` 都从 `/join.sh` 现取。
3. **默认什么都不勾**：工作区、插件、技能、模型组都要逐项开启；同步只在面板点「开始同步」时发生。这是刻意的产品决定，
   不要"好心"改成默认全开。

---

## 1. 目标与约束

| 目标 | 约束（改代码时别打破） |
| --- | --- |
| 桌面 ↔ 手机互传会话 | 会话必须连同 `storages/workspace.json` 一起落地，否则侧栏看不见 |
| 手机只搬字节 | 手机端只有 `curl`/`tar`/`gzip`/`sh`；**不解析 JSON、不装 node、不用 zstd**（`tar -z` 在 Android 上必挂） |
| 判定全在桌面 | zstd 多帧解码、索引合并、`cwd` 改写、插件体检都在宿主端 |
| 局域网安全 | 自己起端口 + 配对令牌；**绝不**把 DSH 自带 web 服务开到局域网 |
| 用户可见 | 每一项都能在面板上看见状态；"同步了但看不见"算 bug |

---

## 2. 代码地图（按你改什么找哪儿）

```
index.js              宿主入口：ctx.effect 起监听；ctx.connection.fetch 注册 status / action 两条路由
client.js             侧栏面板（ModuleLoader bundle，无构建）。DICT 双语、CSS、卡片、ErrorBoundary
lib/controller.js     状态文件、LAN http.Server、所有路由、workspaceCatalog、status()、act()（所有面板动作）
lib/transfer.js       planPull（电脑→手机规划：会话/插件/技能/模型/密钥）与 ingestPush（手机→电脑合并）
lib/channels.js       通道默认值、逐项开关（plugins/skills/models/workspaces/modelKeys）、配对映射、DEFAULTS_REV 迁移
lib/index-sync.js     workspace.json 读/合并/原子写；mapWorkspace / mapDesktopWorkspace / alignPath / titleLookup
lib/sessions.js       扫描、多帧 zstd、cwd 改写、mergeOne（合并后搬家）、verifyLog
lib/plugins.js        枚举 profile 插件；体检测试（原生二进制、外部依赖、自带依赖）；用途描述 describePackage
lib/skills.js         枚举 skills 根、frontmatter、目录/平铺、摘要
lib/models.js         模型分组（整行 / config.providers.<名字> / 插件 patch）、patch 与 credentials 合并
lib/patch.js          patch 文件整块文本编辑（按 id 替换/追加，注释保留）
lib/tar.js            零依赖 tar 读写
lib/qr.js             QR SVG（lib/vendor/qrcode.cjs）
lib/phone.js          把配对值烤进手机脚本模板
mobile/dsh-sync.sh    手机端脚本（pair/wait/watch/both/push/pull/status/install）
tools/*.mjs           只读探针：catalog（面板数据）、plan（dry-run 下发）、panel（真数据渲染面板）
test/run.sh           8 个单元套件 + 一次真 curl/tar/pair 往返
```

### 一次同步的数据流

```
手机 pair ──GET /api/await（长轮询 25s）──▶ 桌面 controller.handleAwait
面板「开始同步」──POST action request-sync──▶ state.request = {status:pending}
手机取走 ──▶ 标记 taken
手机 push ──tar.gz(POST /api/push)──▶ transfer.ingestPush → mergeOne + 写 workspace.json
手机 pull ──GET /api/pull──────────▶ transfer.planPull → tar.gz（会话/插件/技能/patch/credentials/readme）
手机 done ──POST /api/done?request=id──▶ 面板显示「同步完成 hh:mm」
```

---

## 3. 协议（换手机端时对照这一节）

**HTTP**（全部走 `X-DSH-Sync-Token` 头；`?t=` 仅为兼容旧脚本）

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/j` | GET | 说明页（带令牌） |
| `/join.sh` | GET | 渲染手机脚本（`__BASE__/__TOKEN__/__NAME__` 已替换） |
| `/api/ping` | GET | 存活 + 会话数 |
| `/api/manifest` | GET | 纯 `key=value`：sessions/models/plugins/skills/secrets/profile/manual/request/desktop |
| `/api/await?timeout=25` | GET | 长轮询；有请求返回 `request=<id>`，否则 `request=0` |
| `/api/done?request=<id>` | POST | 手机报告完成 |
| `/api/push` | POST | 上传 tar.gz |
| `/api/pull` | GET/POST | 下发 tar.gz |

**push（手机 → 桌面）包布局**

```
--<项目键>--/<会话 id>/session.v4.jsonl.zstd    会话日志（顶层，不带 sessions/ 前缀）
_meta/phone.env            device / home / sessions / profile / profileName
_meta/plugins.txt          "<包名> <版本>" 每行一个
_meta/skills.txt           已装技能名，每行一个
_meta/sessions.txt         "<会话 id> <字节数>"（重复同步靠它跳过）
_meta/index.json           手机的 workspace.json（工作区列表/配对靠它）
_meta/profile/package.json 手机 profile 的 package.json（manifest profile=1）
_meta/patch/cordis.patch.yml  手机 patch（manifest models=1）
_meta/patch/credentials.yaml  手机 .credentials.yaml（manifest secrets=1）
```

**pull（桌面 → 手机）包布局**

```
sessions/<手机项目键>/<会话 id>/session.v4.jsonl.zstd   头部 cwd 已改写
_meta/index.json              合并好的索引（手机先备份再覆盖）
_meta/profile/package.json    已把新 bundle 写进 dsh.profile.bundles
_meta/plugins/<包名>/…        整个目录替换 node_modules/<包名>
_meta/skills/<名字>/… 或 <名字>.md
_meta/patch/cordis.patch.yml  已合并的模型组
_meta/patch/credentials.yaml  已合并的 refs
_meta/readme.txt              这次做了什么
```

**项目键（目录名）**：`lib/slug.js::slugOf(cwd)` 精确复刻内核算法——分隔符连成 `-`，非法字符转 `~XXXX`，
外层包 `--`。**改这个文件前先跑 `test/host.mjs`**（它会逐个反查真实目录）。

---

## 4. 状态文件（`$DSH_HOME/dsh-mobile-sync/state.json`）

```jsonc
{
  "token": "…", "port": 8733, "preferred": null, "log": [], "imported": {},
  "sync": {
    "channels": { "sessions": true, "models": false, "plugins": true, "skills": true },
    "workspaces": { "<电脑工作区 id>": true },      // 「同步对话」逐项开关，默认不勾
    "plugins": { "dsh-whale-widget": true },
    "skills":  { "session-sync": false },
    "models":  { "llm-pi-ai/grok": true },
    "modelKeys": { "llm-pi-ai/grok": false },       // 每组密钥开关，未决定=随组
    "secrets": true,                                 // 「同步 API 密钥」总开关
    "workspaceMap": {
      "<电脑工作区 id>": "<手机工作区 id>",          // 电脑行：会话下发到哪个手机目录
      "phone:<手机工作区 id>": "<电脑工作区 id>"     // 手机行：会话回到哪个电脑工作区
    },
    "includeArchived": false, "force": false,
    "phoneRoot": "/storage/emulated/0/DSH",
    "desktopRoot": "<DSH_HOME>/sessions",
    "defaultsRev": 3
  },
  "peer":  { "device": "…", "at": …, "home": "…", "plugins": {}, "skills": [] },
  "request": { "id": "…", "at": …, "status": "pending|taken|done", "doneAt": … },
  "sent":  { "plugins": {}, "skills": {}, "patch": null, "credentials": null }
}
```

`peer/` 缓存手机上次上报的 `index.json` / `package.json` / `cordis.patch.yml` / `credentials.yaml` / `sessions.txt`——
**下发是向这些文件里合并，不是覆盖**，否则会丢手机自己的东西；手机工作区列表也来自这份 `index.json`。

### 4.1 `defaultsRev` 迁移

- rev 2：插件/技能/模型默认全不勾、已归档不同步（一次性重播种）。
- rev 3（v0.5）：新增 `workspaces`（从空开始）、清空旧的 `workspaceMap`（旧版同名对齐的产物）；
  `desktopRoot` **仅在仍是旧默认**（`~/DSH` 或 `<DSH_HOME>/DSH`）时迁到 `<DSH_HOME>/sessions`。
- 加字段的规则：**新字段给默认值，旧字段不清空**；要改动用户已有选择时，必须升 `DEFAULTS_REV` 并在 `normalizeSync` 里写迁移。
- `test/transfer.mjs` 的「rev-2 file is stamped / typedRoot」两段是这道迁移的护栏。

---

## 5. 面板（client.js）约定

- **卡片顺序**：`CARDS` 决定，当前是 配对信息 → 手动同步 → 通道 → 同步工作区 → 插件 → 技能 → 模型 → 统计 → 日志。
  改顺序只动 `CARDS`。
- **每张卡片有自己的 ErrorBoundary**：一张卡片抛错只显示红框，不会整块黑屏（v0.4.1 的修复，别退回去）。
- **卡片只从 `ctx` 取数据**（`card$xxx(ctx)`），`ctx` 在 `Panel` 里一次性拼好。
- **宿主→面板**的字段以 `controller.status()` 为准；加字段时同时更新 `test/client.mjs` 的 fixture，
  否则面板会渲染成 `undefined`（原来就有过）。
- 面板内**没有** `lib/channels.js` 的 `selected()`，用本地 `picked(map, key, fallback)`。
- 动作统一走 `POST action`，每个动作在 `controller.act()` 里有一支；客户端只发动作名 + 参数。
- 测试桩 React 的坑：同一渲染遍历中把 `cursor = 0` 会让**后面**的 `useCallback` 读到前面的 hook 槽。
  新增 hook 时优先写成**函数组件**（像 `keyChip`），不要依赖 `useCallback` 的闭包值。

---

## 6. 怎么测

```sh
NODE=C:/Users/wangc/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe
$NODE sh test/run.sh 8833        # 8 个单元 + 手机往返（真 curl/tar）
SKIP_SHELL=1 sh test/run.sh      # 只跑单元
$NODE test/transfer.mjs          # 单个
```

| 套件 | 管什么 |
| --- | --- |
| `host.mjs` | 真控制器 + 真 HTTP：鉴权、manifest、pull/push、工作区开关、手机工作区落点、重启、令牌 |
| `entry.mjs` | 用内核式 ctx 加载 `index.js`：路由注册、status/action、工作区配对动作校验 |
| `client.mjs` | 桩 React 渲染面板：10 个开关、插件描述、两列工作区下拉、动作上报、ErrorBoundary |
| `plugins.mjs` | 插件枚举、体检测试、自带依赖、用途描述（manifest / README 兜底） |
| `skills.mjs` / `models.mjs` | 技能枚举与摘要 / 模型分组、patch 与 credentials 合并 |
| `transfer.mjs` | 两个方向的规划：逐项开关、工作区开关、落点映射、跳过规则、状态文件迁移 |
| `qr.mjs` | QR SVG |
| `phone.sh` | 真手机脚本：pair 等待 → 取指令 → 上传下载 → 第二次为空 → done 顺序 |

只读体检（真机数据）：

```sh
$NODE tools/catalog-probe.mjs C:/Users/wangc/.dsh
$NODE tools/panel-probe.mjs  C:/Users/wangc/.dsh --text
$NODE tools/plan-probe.mjs   C:/Users/wangc/.dsh
```

**已知环境坑**：Windows 下并发跑两个 bash 会话会撞 DSH 的 bash IPC；Git-Bash 里 `kill` 一个卡在 `curl` 的 `sh`
要用 `kill -9`。这些在 `test/README.md` 里也写了。

---

## 7. 最近的改动（v0.5 → v0.5.1）

| 版本 | 改了什么 |
| --- | --- |
| v0.5 | 电脑同步根目录默认 `<DSH_HOME>/sessions`；工作区改成逐个「同步对话」开关；会话相关开关统一进「同步工作区」卡片；「同步 API 密钥」移到模型卡片；插件体检 + 警告但放行；二维码/命令置顶 |
| v0.5.1 | 面板下半列出**手机自己的**工作区，每个可指定「回到电脑的哪个工作区」（`phone:<id>` 键）；插件行显示用途描述；README/HANDOVER 重写；标注手机端依赖 |

### 7.1 v0.5.1 的两处语义

1. **手机 → 电脑落点**：`sync.workspaceMap['phone:' + phoneId] = desktopId`。导入时 `pairedDesktop(phoneId)`
   先查这个键（要求 desktopId 仍然存在），再回退到老的「电脑行指到该手机工作区」的隐式配对。
   `mapDesktopWorkspace()` 里的「按标题找电脑项目」已经删掉——**标题不再参与落点决定**，全部显式。
2. **插件描述**：`lib/plugins.js::describePackage` 先取 `package.json` 的 `description`，
   没有（或等于包名）就读 README 第一句（跳过标题、徽章、引用块、代码），最多 240 字；
   都没有就写 `未写描述 · <路径>`。面板每行下面显示 `description`，悬停显示 `descriptionFull`。

---

## 8. 仓库与发布

- 仓库：`https://github.com/TZYCeng/dsh-android-Conversation-sync`（`main`）。
- 本仓库**不含任何密钥**：`~/.dsh/.credentials.yaml` 在 DSH home，不在仓库里。
- `.gitattributes` 统一 LF；`*.cmd` 例外。
- 本地安装：profile `package.json` 的 `dependencies` 用 `link:<绝对路径>` + `dsh.profile.bundles` 加一行，
  `profiles/desktop/node_modules/dsh-mobile-sync` 是指向本仓库的目录联接（Windows `New-Item -ItemType Junction`）。
- 发版：改 `package.json` 的 version，跑 `test/run.sh`，commit + push；**重启 DSH** 让新代码生效。

---

## 9. 已知限制

1. **只认 dsh-mobile-apk 的手机端**（见第 0 节）；别的端要自己适配脚本与目录布局。
2. 模型组只搬「配置文本」：插件运行时动态注册的 provider（如 `dsh-opencode-free` 的本地代理端口）即使勾选，
   手机也要装同一插件才有端口。
3. 手机密钥是明文：`.credentials.yaml` 必须整份覆盖（只有 `refs:` 的文档 dsh 会拒绝），所以会先上传再合并下发。
4. 去掉勾选不会卸载手机上已装的插件/技能（只是不再推送）。
5. 子代理会话（`origin: "subagent"`）两个方向都不同步。
6. 桌面 DSH 运行中可能用内存里的索引覆盖我们写的 `workspace.json`；写完**重载界面**最稳。
7. 上传包上限 256 MB；一次下发最多 48 MB 插件 + 8 MB 技能。
8. `state.json` 的 `sent.*` / `imported` 会慢慢变大（有上限，可忽略）。
9. 「开始同步」要求手机在 `pair`/`wait`/`watch`；请求 5 分钟过期。

---

## 10. 踩过的坑（改之前先看）

- bundle patch 的 `id:` 行不能有行尾注释，且必须等于包名，否则内核 preflight 拒绝。
- **patch 里同 id 是整块替换 config**：provider 只能并进已有 `llm-pi-ai` 条目，不能追加第二个。
- patch 块里允许列 0 的注释（本机 `llm-pi-ai` 尾部就有），算缩进/分节时必须跳过注释行。
- `lib/vendor/qrcode.cjs` 必须是 `.cjs`（UMD 在 `type: module` 下会被当 ESM）。
- 手机 `tar -z` 必挂：一律 `tar cf - … | gzip` / `gzip -dc … | tar -x`。
- `/storage/emulated/0` 是 noexec：辅助脚本要 `sh <path>` 或放 `$HOME`；`/tmp` 可能不可写，用 `$TMPDIR` 再退 `$HOME`。
- 手机脚本模板每次现读（`lib/phone.js`），别缓存。
- `lib/patch.js` 把 CRLF 归一成 LF，`digestText` 也一样，判「变了没有」不受换行影响。
- 处理手机落点时，`normalizeIndex` 会补 `global.workspaceIds`；**不要**在 `readIndex` 里做清洗，写入方（`writeIndex`）才带备份。
- 工作区路径若在不可创建的盘符/目录，`ingestPush` 会回退到 `<desktopRoot>/<标题>` 并写日志（不会丢会话）。
- 测试桩 React：见第 5 节 hook 槽的坑；`assert.equal` 的第三个参数会被当成 message，别在断言里跑副作用。

---

## 11. 历史（v0.1 → v0.4，简版）

| 版本 | 要点 |
| --- | --- |
| v0.1 | 只做会话文件的桌面↔手机双向同步：令牌保护的 LAN 服务 + `curl\|sh`；手机 tar -z 必挂，靠 shim 跑通 |
| v0.2 | 四条通道 + 逐插件/技能开关；修 slug、cwd 搬家、scratch 判定、索引可见性 |
| v0.3 | 插件/技能默认全不勾、归档默认不同步、模型按 provider 分组、工作区同名对齐、手动「开始同步」按钮 |
| v0.4 | 密钥跟着模型组走（修「同步了模型没有 key」）；每组「密钥」开关；8 套测试 + 真往返；建仓 |
| v0.4.1 | 面板黑屏修复：每张卡片一个 ErrorBoundary |
| v0.5 | 同步根目录迁到 `<DSH_HOME>/sessions`、逐工作区开关、会话开关合并一栏、密钥按钮进模型卡片、插件体检/警告、二维码置顶 |
| v0.5.1 | 手机工作区上报与落点选择、插件用途描述、文档重写、标注手机端依赖 |

早期版本的状态文档已合并进本表，不再单独维护。
