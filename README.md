# dsh-mobile-sync

> 操作手册（照着做就能跑通）：[docs/USAGE.md](docs/USAGE.md)　·　设计与踩坑：[HANDOVER.md](HANDOVER.md)

把桌面端 DSH 和手机上的 **DeepCode**（`com.dsharnessmobile.shell`）拉平：会话（连同工作区索引）、插件、技能、模型配置。
同一 Wi-Fi 下扫码配对，之后**在面板上点「开始同步」**才同步——手机脚本下载后只配对并等待，不会自己开始。

- 桌面端：DSH 插件，负责扫描、比对、合并、改写、打包，并起一个带令牌的局域网小服务。
- 手机端：一支 `sh` 脚本，只用 `curl` + `tar` + `gzip` 搬字节，不装 node、不装 zstd、没有 `jq`。

## 它怎么工作

```
 桌面 DSH                                   手机 DeepCode（内置 Termux）
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

## 同步什么（四条通道，各有开关）

| 通道 | 方向 | 内容 | 默认 |
| --- | --- | --- | --- |
| 会话 | 双向 | `session.vN.jsonl.zstd` **+ 工作区索引** | 开 |
| 插件 | 电脑 → 手机（单向） | profile `node_modules` 里的插件 + bundle 注册 | 通道开，**逐项全不勾** |
| 技能 | 电脑 → 手机（单向） | `skills/<名字>/`（含 references/scripts）或 `<名字>.md` | 通道开，**逐项全不勾** |
| 模型 | 电脑 → 手机（单向） | **按组**：整行 endpoint，或 `config.providers.<名字>` 的一个提供方（插件提供的也算一组） | 关，**每组全不勾** |
| 密钥 | 电脑 → 手机（单向） | 勾选模型组时，它引用的 `refs:` 一并写入手机 `.credentials.yaml` | 随组走 |

- **默认不替用户做决定**：插件、技能、模型组一项都不勾，勾一项才推一项；选择会记住，下次同步沿用。
- **已归档会话默认不同步**。桌面 `workspace.json` 的 `archivedSessionIds` 里的会话留在本机；要带走就打开面板上的「含已归档会话」。
- **会话必须带着索引走**。DSH 的侧栏只认 `storages/workspace.json`，把会话文件拷过去而不写索引 = 文件在、列表空。
  所以每次下发都会附一份合并好的 `workspace.json`，手机原样覆盖（先备份），面板上会提示「重载界面」。
- **插件和技能只从电脑到手机**。手机装的插件不会反向覆盖电脑，避免把手机环境带回桌面。
- **版本相同就不传**。插件按手机上报的版本号比对（手机上的更新时也不降级），技能按内容摘要比对，会话按手机上报的字节数比对；相同就跳过，第二遍同步基本是空的。
- **模型带密钥走**。dsh 的 `llm-pi-ai` 只从 `<DSH_HOME>/.credentials.yaml` 的 `refs:` 或启动环境取密钥，
  取不到就直接报「未检测到环境变量」。所以勾一个模型组时，它引用的 refs（如 `GROK_API_KEY`）会一起写进手机的 `.credentials.yaml`。
- **模型按组同步**。`llm-pi-ai` 里的每个 provider（grok、chatgpt、yujianwudi…）是一组，每组一个开关；
  插件在 bundle patch 里声明的 provider 也会列出来，标「插件提供」。下发时 provider 会并进手机 patch 里同一行的
  `config.providers`，**不会**再追加一个同 id 的条目（那会整块替换 config，冲掉手机自己的 provider）。
- **子代理（subagent）会话不同步**。`origin: "subagent"` 的日志是引擎自己的草稿，两边侧栏都没有它的位置，留在产生它的那台机器上。
- **每一行开关都会被记住**：存进 `~/.dsh/dsh-mobile-sync/state.json`，重启、升级、重装插件之后仍然是上一次的样子。

### 什么时候开始同步

1. 手机执行面板给的那条命令（`… | sh -s pair`）：它只把脚本装到 `~/.dsh-mobile-sync/sync.sh`，然后**长轮询等待**。
2. 在桌面侧栏点「**开始同步**」：桌面记下这次请求（`request`），手机立刻取走，开始上传 + 下载，完成后回报。
3. 面板显示「等待手机取走 → 手机正在同步 → 同步完成 hh:mm」。请求 5 分钟没人取会自动过期，重点一次即可。
4. 想在终端里手动跑一次：`sh ~/.dsh-mobile-sync/sync.sh both`（或 `push` / `pull`）。

### 工作区怎么配

面板会列出**电脑端工作区**和**手机端工作区**，每个电脑工作区一行，默认是「同名（自动）」：

| 选择 | 规则 |
| --- | --- |
| 同名（自动）（默认） | 按工作区标题配对；找不到同名就放到 `<同步根目录>/<项目名>` |
| 指定手机工作区 | 这个电脑工作区里的会话**改投**到选中的手机工作区（标题不同也可以） |

配对是双向的：手机那个工作区里的会话回来时，也会落回你配对的电脑工作区（而不是新建一个）。
点「恢复同名」清空所有配对。两个根目录都能在面板上改：手机默认 `/storage/emulated/0/DSH`，电脑默认 `~/DSH`。

会话被搬到另一台机器时，文件头里的 `cwd` 会被改写成新目录，**文件也跟着挪到对应的项目目录**——
内核是用 `projectKey(header.cwd)` 推导日志路径的，目录和文件头不一致的会话等于不存在。

## 安装

插件是普通的本地 bundle，挂进 desktop profile 即可。

1. 在 profile 的 `package.json` 里登记（`C:\Users\wangc\.dsh\profiles\desktop\package.json`）：

   ```json
   "dependencies": {
     "dsh-mobile-sync": "link:D:/code/dsh-android-Conversation sync"
   },
   "dsh": {
     "profile": {
       "bundles": [ "...", "dsh-mobile-sync" ]
     }
   }
   ```

2. 让 `node_modules` 里有这个名字（Windows 下建一个目录联接就够，插件没有第三方依赖）：

   ```bat
   cmd /c mklink /J "C:\Users\wangc\.dsh\profiles\desktop\node_modules\dsh-mobile-sync" "D:\code\dsh-android-Conversation sync"
   ```

3. 重启 DSH。左侧栏会出现「手机同步」入口。

入口打不开时也能用：面板上有「在本机浏览器打开」按钮，直接打开带令牌的说明页；也可以手动访问 `http://127.0.0.1:8733/`，把面板上的令牌粘进去。

## 配对

1. 打开侧栏的「手机同步」，等状态变成 **运行中**。
2. 手机扫码，或者直接在手机浏览器里打开面板上那个地址（形如 `http://192.168.x.x:8733/j?t=<令牌>`）。
3. 页面上有一条命令，复制到 DeepCode 里执行：

   ```sh
   curl -fsSL 'http://192.168.x.x:8733/join.sh?t=<令牌>' | sh -s pair
   ```

   `pair` 只做两件事：把脚本装到手机 `~/.dsh-mobile-sync/sync.sh`，然后长轮询等待。
   **它不会一上来就同步**——回到桌面侧栏点「开始同步」，手机才会开始上传和下载。
   想让它常驻后台等待，把 `pair` 换成 `watch`：

   ```sh
   curl -fsSL 'http://…/join.sh?t=…' | sh -s watch
   ```

   也可以直接在终端里手动跑一次：`sh ~/.dsh-mobile-sync/sync.sh both`。

令牌是 32 位十六进制，存在 `~/.dsh/dsh-mobile-sync/state.json`，可以随时在面板上重置（重置后手机要重新扫码）。
API 调用走 `X-DSH-Sync-Token` 请求头，不再把令牌塞进 URL 查询串（旧脚本的 `?t=` 仍然兼容）。

## 手机端命令

```sh
sh dsh-sync.sh [pair|wait|watch|both|push|pull|status|install]
```

| 命令 | 作用 |
| --- | --- |
| `pair`（默认） | 装好脚本，然后等待桌面的「开始同步」按钮 |
| `wait` | 只等待，不安装 |
| `watch` | 装好后在后台等待（日志 `~/.dsh-mobile-sync/sync.log`） |
| `both` | 立刻上传再下载（显式手动，用于排障） |
| `push` | 只把手机的会话与元数据传到桌面 |
| `pull` | 只把桌面的内容取回手机 |
| `status` | 看桌面端是否可达、同步开关、本机会话/插件/技能数量 |
| `install` | 把脚本存到 `~/.dsh-mobile-sync/sync.sh` |

脚本自己找 DSH 目录，顺序是：`$DSH_HOME` → `$HOME/.dsh` → `/data/data/com.dsharnessmobile.shell/files/home/.dsh` → `/sdcard/.dsh`。
profile 目录按 `$DSH_PROFILE` → 含 `"bundles"` 的 `profiles/*/package.json` → 名为 `desktop` 的顺序找；找不到就跳过插件与模型，会话和技能照常同步。
设备名取 `$DSH_SYNC_DEVICE`，否则 `getprop ro.product.model`，再否则 `uname -n`。

> 从旧版（有 `auto [秒]` 定时同步的那版）升上来的手机：先重启 DeepCode 或结束旧的 `auto` 后台循环，
> 否则它还会按旧定时器跑 `both`，绕过「开始同步」按钮。新版不再提供定时同步，只有 `pair`/`wait`/`watch`。

## 冲突怎么判

| 情况 | 结果 |
| --- | --- |
| 两边内容一致（忽略 `cwd` 的 sha256 相同） | 跳过，只计数 |
| 对方帧数更多（= 追加过更多内容） | 备份本机文件后覆盖（备份在 `~/.dsh/dsh-mobile-sync/backup/<时间戳>/…`） |
| 对方帧数更少 | 保留本机，不动 |
| 帧数相同但内容不同 | 保留本机，报告「分叉」，需要人看 |

「帧数多就更新」对 DSH 是成立的：会话文件只追加，每次追加一个独立的 zstd 帧。
比较时忽略文件头里的 `cwd`，否则同一段会话在两边来回搬一次就会永远被判成「内容不同」，无限重传。

会话的身份用**目录名**（`<项目>/<会话 id>/`）判定，不用文件头里的 id。

## 安全

- 局域网里走的是明文 HTTP，靠令牌鉴权。**别在公共 Wi-Fi 上用**；家里/公司内网可以。
- 令牌泄露了就重置：面板上「重置令牌」一键换新。
- 服务只暴露 `/api/ping`、`/api/manifest`、`/api/await`、`/api/done`、`/api/pull`、`/api/push` 和说明页，没有任意文件读写。
- 上传包限制 256 MB，路径里的 `..` 一律拒绝；下载包里一次最多带 48 MB 插件、8 MB 技能。
- **API 密钥默认不同步**。打开「同步 API 密钥」才会传模型用到的 `refs`（明文 LAN 传输），`records:` 与其它 ref 原样保留。
- 桌面端只在插件启用期间监听，禁用/退出即关闭。

## 常见问题

**状态一直是「端口占用」**
8733 被别的程序占了。面板上点「重启监听」会往后找 8734–8740；也可以改 `state.json` 里的 `port` 后重启 DSH。

**手机连不上，但电脑上打得开**
Windows 防火墙。第一次启动时如果弹了提示，要允许「专用网络」。手动加规则：

```powershell
New-NetFirewallRule -DisplayName "DSH mobile sync" -Direction Inbound -LocalPort 8733 -Protocol TCP -Action Allow -Profile Private
```

**面板上有好几个网卡地址**
虚拟机、WSL、Docker 都会冒出网卡。插件按 192.168 → 10 → 172.16–31 排序，并给虚拟网卡降权，默认选第一个；不对就点另一个地址。

**插件行写着「不支持」**
含原生二进制（`.node`/`.dll`/`.so`）或声明了运行时 `dependencies` 的插件不会搬——手机上加载不了，硬搬只会报错。原因在行的 tooltip 里。

**同步过去了但列表里没有**
会话要连同 `workspace.json` 一起落地才可见；脚本会覆盖并备份索引。装完插件/改完 patch 需要**重启 DSH** 才会加载；会话列表刷新或重开界面即可。

**手机上找不到会话目录**
先 `sh dsh-sync.sh status` 看它认的路径对不对；不对就用 `DSH_HOME=/实际/路径 sh dsh-sync.sh both`。

**点了「开始同步」手机没反应**
手机必须还在 `pair`/`wait`/`watch` 里等待（终端的窗口别关，或用 `watch` 放后台）。请求 5 分钟没人取会过期，重点一次即可；
也可以直接在手机终端跑 `sh ~/.dsh-mobile-sync/sync.sh both`。

## 已知限制

- **不能在 App 内扫码**：DeepCode 的 APK 没有开放相机/扫码桥接，所以二维码只能由手机系统相机或浏览器扫。想做 App 内一键配对，得改 APK。
- 只同步会话/索引/插件/技能/模型配置；DSH 的其它设置（主题、快捷键等）不动。
- 桌面端必须开着（DSH 在跑），手机才能同步。
- 插件必须是 bundle（`dsh.bundle`），否则无法在手机上自动注册，面板会标明。
- 模型组只搬「配置文本」：provider 会并进手机 patch 里同一行的 `config.providers`。插件在运行时动态注册的 provider 即使勾选，
  手机也需要装对应插件才有进程内的端口（面板会标「插件提供」）。
- 取消勾选不会卸载手机上已经装好的插件/技能，只是不再推送更新。

## 目录结构

```
index.js            宿主端入口：起监听、注册 /api/dsh-mobile-sync/* 路由
client.js           浏览器端：侧栏面板（开始同步按钮、工作区配对、逐项开关、二维码、地址、命令、日志）
cordis.patch.yml    把插件插进 DSH 的 bundle
lib/controller.js   状态文件、局域网监听、HTTP 路由、面板状态与动作
lib/transfer.js     两个方向的规划：ingestPush（手机→桌面）/ planPull（桌面→手机）
lib/channels.js     通道开关与逐项选择的默认值、持久化形状
lib/index-sync.js   workspace.json：读取、合并、按标题/路径找工作区、双向工作区映射
lib/sessions.js     会话扫描、zstd 多帧解码、cwd 改写、比对与合并、目录迁移
lib/slug.js         项目目录名（kernel projectKey 的精确复刻）
lib/plugins.js      枚举 profile 里的插件、判断能否搬、读文件
lib/skills.js       枚举 skills 根目录、解析 frontmatter、内容摘要
lib/patch.js        patch 文件的整块文本编辑（按 id 替换/追加）
lib/models.js       模型分组（整行 / config.providers 的 provider / 插件 patch）、合并 patch 与 credentials
lib/tar.js          零依赖 tar 打包/解包
lib/phone.js        把配对信息烤进手机脚本
lib/qr.js           二维码 SVG
lib/vendor/         qrcode-generator（MIT）
tools/panel-probe.mjs  用真实 $DSH_HOME 的目录把侧栏面板渲染一遍（只读，排障用）
mobile/dsh-sync.sh  手机端脚本
test/               测试（见 test/README.md）
```

## 测试

不需要 DSH 在跑，也不需要真机：

```sh
NODE=/path/to/node sh test/run.sh
```

七套单元测试（合并规则与端到端 HTTP、入口加载、面板渲染、二维码点阵、插件枚举、技能枚举、模型与 patch、同步规划）加一次真 `curl` + `tar` 的手机形态往返。细节见 [test/README.md](test/README.md)。

## 卸载

从 profile 的 `bundles` 里删掉 `dsh-mobile-sync`，删掉那个 `node_modules` 联接，重启 DSH。
状态文件 `~/.dsh/dsh-mobile-sync/` 可以留着（含令牌、手机上报的缓存和备份），也可以直接删。

## 许可

MIT。二维码编码器来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（Kazuhiko Arase，MIT）。
