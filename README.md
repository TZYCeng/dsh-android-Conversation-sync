# dsh-mobile-sync

把桌面端的 **DeepSeek Harness（DSH）** 和手机端拉平：会话（连同工作区索引）、插件、技能、模型配置与 API 密钥。
同一 Wi-Fi 下扫码配对，**在面板上点「开始同步」才同步**——手机脚本下载后只配对并等待，不会自己开始。

> **手机端要求**：本项目按 [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) 这个手机端 App 设计并测试
> （包名 `com.dsharnessmobile.shell`，界面里叫 DeepCode）。**其它手机端没有按本项目的协议验证过，很可能不兼容**：
> 它需要是「内置 Termux 的 DSH 壳」，能执行 `sh`/`curl`/`tar`/`gzip`，并按文档里的目录布局落位。
> 换别的手机端时，先看 [HANDOVER.md](HANDOVER.md) 的协议一节，自己核对或改 `mobile/dsh-sync.sh`。

**先看怎么用**：往下第 1 节是扫码 / 脚本的完整步骤。细节手册在 [docs/USAGE.md](docs/USAGE.md)，
想改代码、做分支的看 [HANDOVER.md](HANDOVER.md)。

---

## 1. 怎么用（扫码 / 脚本）

### 1.1 一次性准备

1. 桌面装好这个插件（见第 5 节），侧栏出现 **「手机同步」**，状态是 **运行中**。
2. 手机装好 [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（DeepCode），并和电脑连**同一个 Wi-Fi**。

### 1.2 配对：扫码，或者粘一条命令

打开侧栏「手机同步」，最上面那张卡片就是入口：

```
┌───────────┐   手机扫这个码（相机 / 任意扫码工具）
│  █ QR █   │   → 打开桌面插件自带的说明页（带令牌）
└───────────┘
在 DeepCode 里粘贴这条命令
curl -fsSL 'http://192.168.1.9:8733/join.sh?t=<令牌>' | sh -s pair      [复制命令]
网卡  192.168.1.9   172.26.23.72
```

- **扫码**适合只是想看看手机上的说明页；**命令适合直接干活**：
  在手机 DeepCode 的聊天框/内置终端里粘贴并回车即可。
- 命令里的 `pair` 只做两件事：把脚本装到手机 `~/.dsh-mobile-sync/sync.sh`，然后**长轮询等桌面点按钮**。
- 如果手机连不上，点一下另一张网卡地址（`vEthernet`、`WSL`、`Docker` 那些是虚拟网卡，通常不对），命令和二维码会跟着换。

### 1.3 同步

1. 手机上出现「已配对。等待桌面面板点「开始同步」…」。
2. 回到电脑，在「手动同步」卡片点 **「开始同步」**。
3. 手机立刻上传 → 下载 → 回报；面板显示「同步完成 hh:mm」，手机终端打印本次做了什么。

### 1.4 第一次同步前，先勾几项

**默认什么都不勾**（和插件、技能一样，工作区也要逐个勾）：

| 卡片 | 勾什么 |
| --- | --- |
| 同步工作区 | 每个电脑工作区一个「同步对话」——勾上这个项目的会话才双向传 |
| 同步工作区（下半） | 手机上报的工作区，各选一个「回到电脑时落到哪个工作区」（不选就落到 `<电脑根目录>/<标题>`） |
| 插件 | 勾一项推一项；行下面有一行说明告诉你这个插件是干什么的 |
| 技能 / 模型组 | 同理；模型组的「密钥」随组走 |

手机端再跑一次 `pair`（或 `sh ~/.dsh-mobile-sync/sync.sh pair`）就能在面板下半看到它的工作区列表。

### 1.5 之后

- 平时手机挂着 `pair`，需要时点一次「开始同步」。
- 不想守着终端：手机执行 `sh ~/.dsh-mobile-sync/sync.sh watch` 让它在后台等；日志在 `~/.dsh-mobile-sync/sync.log`。
- 只想手动跑一次（排障）：`sh ~/.dsh-mobile-sync/sync.sh both`。

---

## 2. 它怎么工作

```
 桌面 DSH                                   手机 dsh-mobile-apk（内置 Termux）
┌───────────────────────────┐              ┌───────────────────────────┐
│ dsh-mobile-sync 插件      │              │ sh dsh-sync.sh pair       │
│  ├─ 会话 + 工作区索引     │  tar.gz ⇄    │  ├─ 装好脚本，长轮询等待   │
│  ├─ 插件 / 技能 / 模型组  │  HTTP 局域网 │  └─ 收到指令才 tar/curl   │
│  ├─ HTTP :8733（令牌）    │              │     然后按目录落位        │
│  └─ 「开始同步」按钮      │              │                           │
└───────────────────────────┘              └───────────────────────────┘
```

判定与合并全在桌面做：真正的 zstd 解码、索引合并、`cwd` 改写都在这里，手机只搬字节。
手机端**不解析 JSON**——它要执行的东西完全由包里的文件布局决定（`_meta/plugins/<名字>/…` 就装到 `node_modules/<名字>`），
桌面告诉它什么，它就照做。

**为什么不用 DSH 自带的 web 服务？** 那个服务没有鉴权，而且只允许监听回环地址或一个明确的非回环地址；把它开到局域网等于把整个 DSH 暴露出去。所以插件自己起一个端口，用配对令牌保护。

## 3. 同步什么（四条通道，各有开关）

| 通道 | 方向 | 内容 | 默认 |
| --- | --- | --- | --- |
| 会话 | 双向 | `session.vN.jsonl.zstd` **+ 工作区索引**，**逐工作区勾选** | 通道开，**逐工作区全不勾** |
| 插件 | 电脑 → 手机（单向） | profile `node_modules` 里的插件 + bundle 注册 | 通道开，**逐项全不勾** |
| 技能 | 电脑 → 手机（单向） | `skills/<名字>/`（含 references/scripts）或 `<名字>.md` | 通道开，**逐项全不勾** |
| 模型 | 电脑 → 手机（单向） | **按组**：整行 endpoint，或 `config.providers.<名字>` 的一个提供方（插件提供的也算一组） | 关，**每组全不勾** |
| 密钥 | 电脑 → 手机（单向） | 勾选模型组时，它引用的 `refs:` 一并写入手机 `.credentials.yaml` | 随组走，总开关在模型卡片里 |

- **默认不替用户做决定**：工作区、插件、技能、模型组一项都不勾，勾一项才推一项；选择会记住，下次同步沿用。
- **已归档会话默认不同步**。桌面 `workspace.json` 的 `archivedSessionIds` 里的会话留在本机；要带走就打开「同步工作区」里的「含已归档会话」。
- **会话必须带着索引走**。DSH 的侧栏只认 `storages/workspace.json`，把会话文件拷过去而不写索引 = 文件在、列表空。
  所以每次下发都会附一份合并好的 `workspace.json`，手机原样覆盖（先备份），面板上会提示「重载界面」。
- **插件和技能只从电脑到手机**。手机装的插件不会反向覆盖电脑，避免把手机环境带回桌面。
- **插件会先体检，并写清用途**：每行插件下面是它自己 `package.json` 的 `description`（没有就读 README 第一句）。
  自带 `node_modules` 的标「自带依赖」；含原生二进制或外部 `dependencies` 的标「不兼容警告」，
  **仍然可以勾选下发**（不拦你，由手机端自行修复）。
- **版本相同就不传**。插件按手机上报的版本号比对（手机上的更新时也不降级），技能按内容摘要比对，会话按手机上报的字节数比对；相同就跳过，第二遍同步基本是空的。
- **模型带密钥走**。dsh 的 `llm-pi-ai` 只从 `<DSH_HOME>/.credentials.yaml` 的 `refs:` 或启动环境取密钥，
  取不到就直接报「未检测到环境变量」。所以勾一个模型组时，它引用的 refs（如 `GROK_API_KEY`）会一起写进手机的 `.credentials.yaml`；
  「同步 API 密钥」总开关和「全带密钥 / 全不带」都在**模型组**卡片里。
- **模型按组同步**。`llm-pi-ai` 里的每个 provider（grok、chatgpt、yujianwudi…）是一组，每组一个开关；
  插件在 bundle patch 里声明的 provider 也会列出来，标「插件提供」。下发时 provider 会并进手机 patch 里同一行的
  `config.providers`，**不会**再追加一个同 id 的条目（那会整块替换 config，冲掉手机自己的 provider）。
- **子代理（subagent）会话不同步**。`origin: "subagent"` 的日志是引擎自己的草稿，两边侧栏都没有它的位置，留在产生它的那台机器上。
- **每一行开关都会被记住**：存进 `~/.dsh/dsh-mobile-sync/state.json`，重启、升级、重装插件之后仍然是上一次的样子。

### 3.1 什么时候开始同步

1. 手机执行面板最上面那条命令（`… | sh -s pair`）：它只把脚本装到 `~/.dsh-mobile-sync/sync.sh`，然后**长轮询等待**。
2. 在桌面侧栏点「**开始同步**」：桌面记下这次请求（`request`），手机立刻取走，开始上传 + 下载，完成后回报。
3. 面板显示「等待手机取走 → 手机正在同步 → 同步完成 hh:mm」。请求 5 分钟没人取会自动过期，重点一次即可。
4. 想在终端里手动跑一次：`sh ~/.dsh-mobile-sync/sync.sh both`（或 `push` / `pull`）。

### 3.2 同步工作区怎么配

「**同步工作区**」卡片上下两半：

| 位置 | 开关 | 规则 |
| --- | --- | --- |
| 上半 · 电脑工作区 | 每行的「同步对话」 | 和插件、技能一样的逐项开关，默认全不勾；勾上这个项目的会话才双向同步 |
| 上半 · 目标目录（默认） | 下拉留空 | 落到 `<手机同步根目录>/<标题>` |
| 上半 · 目标目录（指定） | 下拉选一个手机工作区 | 这个工作区的会话**改投**到选中的手机工作区（标题不同也可以） |
| 下半 · 手机工作区 | 「默认：电脑同名目录」 | 这个手机项目的会话回到 `\<电脑同步根目录>/<标题>` |
| 下半 · 手机工作区 | 选一个电脑工作区 | 回落到那个电脑工作区里（标题不同也可以） |

配对是双向的：手机项目的下拉选了哪个电脑工作区，它回来的会话就落在那里；电脑工作区指到哪个手机目录，下发的会话就去那里。
「清除配对」两边一起清，不影响勾选。两个根目录也能在这一张卡片上改：
手机默认 `/storage/emulated/0/DSH`，电脑默认 `<DSH_HOME>/sessions`（dsh 自己的对话目录；旧版的 `~/DSH` 升级时自动迁过来，手改过的不动）。

会话被搬到另一台机器时，文件头里的 `cwd` 会被改写成新目录，**文件也跟着挪到对应的项目目录**——
内核是用 `projectKey(header.cwd)` 推导日志路径的，目录和文件头不一致的会话等于不存在。

## 4. 手机端脚本命令一览

```sh
sh ~/.dsh-mobile-sync/sync.sh [pair|wait|watch|both|push|pull|status|install]
```

| 命令 | 作用 |
| --- | --- |
| `pair`（默认） | 装好脚本，然后等待电脑的「开始同步」 |
| `wait` | 只等待，不安装 |
| `watch` | 装好后在后台等待（日志 `~/.dsh-mobile-sync/sync.log`） |
| `both` | 立刻上传再下载（显式手动，排障用） |
| `push` / `pull` | 只上传 / 只下载 |
| `status` | 桌面是否可达、清单、本机会话/插件/技能数量 |
| `install` | 只安装脚本 |

脚本自己找 DSH 目录：`$DSH_HOME` → `$HOME/.dsh` → `/data/data/com.dsharnessmobile.shell/files/home/.dsh` → `/sdcard/.dsh`。
找不到就跳过插件和模型，会话与技能照常同步。

## 5. 安装（桌面端）

插件是普通的本地 bundle，挂进 desktop profile 即可，不需要 npm 发布：

1. 在 profile 的 `package.json` 里登记（`C:\Users\wangc\.dsh\profiles\desktop\package.json`）：
   把 `dsh-mobile-sync` 加进 `dsh.profile.bundles`，并在 `dependencies` 里加 `"dsh-mobile-sync": "link:<本仓库绝对路径>"`。
2. 让 `node_modules` 里出现这个名字（Windows 建目录联接）：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-mobile-sync" `
     -Target "D:\code\dsh-android-Conversation sync"
   ```
3. 重启 DSH。侧栏出现「手机同步」，监听 8733（被占则顺延到 8740）。

> 改代码后要**重启 DSH** 才会加载新的宿主端代码；手机脚本每次从 `/join.sh` 现取，改了立即生效，不用重装。

## 6. 目录

```
index.js              宿主入口：起监听 + 两条 connection.fetch 路由（status / action）
client.js             侧栏面板（二维码/命令 → 手动同步 → 通道 → 工作区 → 插件 → 技能 → 模型 → 统计/日志）
lib/controller.js     状态文件、LAN 监听、路由、面板状态与动作
lib/transfer.js       两个方向的规划：ingestPush / planPull
lib/channels.js       通道与逐项开关、工作区开关、配对映射、defaultsRev 迁移
lib/index-sync.js     workspace.json 读/合并/写 + 工作区映射
lib/sessions.js       扫描、zstd 多帧、cwd 改写、合并、目录迁移
lib/plugins.js        枚举插件、可搬性体检、用途描述、读文件
lib/skills.js         枚举技能
lib/models.js         模型分组、patch 与 credentials 合并
lib/tar.js            零依赖 tar 读写
mobile/dsh-sync.sh    手机端脚本
tools/                只读探针（catalog / plan / panel）
test/                 run.sh + 8 个套件 + phone.sh 真往返
docs/USAGE.md         操作手册
HANDOVER.md           交接：架构、协议、状态文件、测试、坑
```

## 7. 常见问题

**手机连不上电脑**：确认同一 Wi-Fi、面板状态「运行中」、点的是手机能访问的那张网卡；公司/访客网络常开 AP 隔离。

**点「开始同步」手机没反应**：手机必须还在 `pair`/`wait`/`watch` 里等待；过期了就再点一次，或手机跑 `both`。

**模型报「未检测到环境变量 / 没有 key」**：勾上那一组并同步（会自动带密钥），或手动补 `~/.dsh/.credentials.yaml` 的 `refs:`。
启动之后才 `export` 的环境变量 dsh 看不到。

**插件行写着「不兼容警告」**：含原生二进制或外部 `dependencies`，手机端需要自己补；勾选仍然有效。

**同步过去了但侧栏没有**：会话要连同 `workspace.json` 一起落地；装了插件 / 改了 patch 要**重启 DSH**。

**升级到新版后开关全变了**：v0.4 起插件/技能/模型默认全不勾；v0.5 起工作区改成逐个勾「同步对话」，
电脑同步根目录迁到 `<DSH_HOME>/sessions`。旧状态文件只做一次性重新播种，之后不再覆盖你的勾选。

## 8. 排障工具（只读，不写任何东西）

```sh
node tools/catalog-probe.mjs C:/Users/wangc/.dsh   # 通道、逐项开关、模型组与密钥状态
node tools/panel-probe.mjs  C:/Users/wangc/.dsh --text   # 用真实目录把侧栏面板渲染一遍
node tools/plan-probe.mjs   C:/Users/wangc/.dsh   # dry-run 下一次下发
NODE=<node> sh test/run.sh 8833                   # 全部测试 + 手机往返
```
