# 使用方法

> dsh-mobile-sync v0.5.1 —— 把桌面 DSH 和手机端（[kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)，界面叫 DeepCode）
> 的**会话（逐工作区勾选）、插件、技能、模型组与密钥**对齐。其它手机端未经验证，可能不兼容。
> 这一份是**操作手册**：照着做就能跑通；为什么要这样设计和怎么改代码，见 [HANDOVER.md](../HANDOVER.md)、[../README.md](../README.md)。

---

## 0. 一分钟版

```text
1. 电脑：DSH 侧栏 →「手机同步」→ 等状态变成「运行中」
2. 手机：扫码打开说明页 → 复制那条 curl 命令 → 在 DeepCode 里粘贴回车
   （命令末尾是 pair：只配对 + 等待，不会自己同步）
3. 电脑：在面板上勾选要同步的东西 → 点「开始同步」
4. 手机：窗口里出现「收到同步指令」→ 上传 → 下载 →「本次同步完成」
```

以后每次要同步，保持手机那条命令在跑，回电脑点一次「开始同步」即可。

---

## 1. 安装插件（只做一次）

插件是本地 bundle，挂进 desktop profile 即可，不需要 npm 发布。

1. 在 profile 的 `package.json`（`~/.dsh/profiles/desktop/package.json`）里登记：

   ```json
   "dependencies": {
     "dsh-mobile-sync": "link:D:/code/dsh-android-Conversation sync"
   },
   "dsh": {
     "profile": {
       "bundles": ["...", "dsh-mobile-sync"]
     }
   }
   ```

2. 让 `node_modules` 里出现这个名字（Windows 建目录联接，插件没有第三方依赖）：

   ```bat
   cmd /c mklink /J "C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-mobile-sync" "D:\code\dsh-android-Conversation sync"
   ```

   Linux / macOS：

   ```sh
   ln -s /path/to/repo ~/.dsh/profiles/desktop/node_modules/dsh-mobile-sync
   ```

3. **完全退出并重启 DSH**（含托盘/后台进程）。左侧栏会出现「手机同步」。

   改了 `lib/`、`client.js` 之后也要重启 DSH 才会加载新代码；手机端脚本每次从 `/join.sh` 现取，改了立即生效。

---

## 2. 配对

1. 打开侧栏「手机同步」，状态变成 **运行中**（端口默认 8733，占用会顺延到 8740）。
   最上面那张卡片依次是：二维码 → 在 DeepCode 里粘贴的命令 → 网卡选择。
2. 手机用**系统相机或浏览器**扫面板上的二维码，打开手机版说明页（DeepCode 的 APK 没有开放相机，扫不了 App 内部码）。
3. 页面里那条命令复制到 DeepCode 的聊天框或内置终端执行；也可以直接点面板上的「复制命令」粘贴过去：

   ```sh
   curl -fsSL 'http://192.168.x.x:8733/join.sh?t=<令牌>' | sh -s pair
   ```

   它做两件事：把脚本装到手机 `~/.dsh-mobile-sync/sync.sh`，然后**长轮询等待**。
   **下载脚本不会触发同步。**

> 手机连不上时，点面板上的另一张网卡地址（`vEthernet`、`WSL`、`Docker` 是虚拟网卡，通常不对），二维码和命令会一起换。

4. 想让它常驻后台：

   ```sh
   curl -fsSL 'http://192.168.x.x:8733/join.sh?t=<令牌>' | sh -s watch
   ```

   日志在手机 `~/.dsh-mobile-sync/sync.log`。

> 令牌是 32 位十六进制，存在电脑 `~/.dsh/dsh-mobile-sync/state.json`。
> 面板上「重置令牌」会让手机需要重新配对。

---

## 3. 同步：只有点了按钮才开始

1. 电脑面板顶部有一张「**手动同步**」卡，按钮写着「**开始同步**」。
2. 点下去后：
   - 按钮变成「等待手机取走指令…」；
   - 手机窗口打印「收到同步指令（xxxxxxxx），开始上传…」；
   - 手机上传 → 电脑导入并回显统计 → 电脑下发 → 手机落盘 → 回报完成；
   - 面板显示「**同步完成 时:分**」，按钮变成「再同步一次」。
3. 请求 5 分钟没人取会过期，重点一次即可；也可以点「取消」。

**为什么这样设计**：手机上一条命令会在后台跑着，如果下载即同步，每次重开终端都会传一遍。
现在「手机在等」和「电脑按钮」缺一不可，你完全掌控同步的时机。

---

## 4. 每条通道怎么勾

面板从上到下的顺序就是操作顺序：**手机扫码 / 命令 / 网卡 → 手动同步 → 同步通道 → 同步工作区 → 插件 → 技能 → 模型组 → 统计/日志**。

| 通道 | 默认 | 怎么用 |
| --- | --- | --- |
| 会话 | 开（逐工作区全不勾） | 关掉就整条不搬会话（也不搬索引）；打开后仍要在「同步工作区」里逐个项目勾「同步对话」 |
| 插件 | 开（逐项全不勾） | 勾一项推一项，取消勾选不会卸载手机上的 |
| 技能 | 开（逐项全不勾） | 同上，`references/`、`scripts/` 一起搬 |
| 模型 | 关 | 先点「模型」通道，再按组勾 |

- 每个通道都有一个「全选 / 清空」，只影响这一类的条目。
- 所有勾选都存在电脑的 `~/.dsh/dsh-mobile-sync/state.json`，重启、升级之后仍然是上一次的样子。
- **已归档会话默认不同步**；要带走就打开「同步工作区」里的「含已归档会话」。
- 「**同步 API 密钥**」总开关在**模型组**卡片里（密钥属于模型，不属于会话通道）。

---

## 5. 同步工作区：每个工作区一个开关

「同步工作区」卡片把**所有和会话有关的东西**放在一起：目标目录、两个根目录、归档开关，
以及每个电脑工作区一行的「**同步对话**」勾选——和插件、技能一样，**默认全不勾，勾一项同步一项**。

```
☑ dsh-android-Conversation sync   1 会话 · 8 归档   →   [默认：手机同名目录 ▾]
☐ Odds and ends                   3 会话 · 434 归档  →   [默认：手机同名目录 ▾]
```

- **勾上的工作区**：它的会话双向同步（电脑 → 手机的下发、手机 → 电脑的导入都会经过它）。
- **没勾的工作区**：一个字节都不动；手机上那个项目的新会话也不会被导入。
- **目标目录**：勾上之后右侧下拉才可用。默认是 `<手机同步根目录>/<标题>`，也可以改投到手机
  任意一个已有工作区（标题不同也行）；投过去的会话回到电脑时仍落回这个工作区。

卡片**下半**是手机自己上报的工作区，每个一行，可以选它「回到电脑时落到哪个工作区」：

```
phone · demo            2 会话   ←   [默认：电脑同名目录 ▾]
phone · Phone Project   0 会话   ←   [landing project ▾]
```

- 下拉留空：回到 `<电脑同步根目录>/<标题>`。
- 选一个电脑工作区：回来的会话直接落进那个项目（标题不同也行），并登记进该工作区的侧栏。
- 右边若出现「← X」标签，说明有勾选的电脑工作区正在往这个手机目录下发。
- 手机工作区要等到手机上报过一次索引才会出现（手机跑一次 `pair` 并点过同步即可）。

- 「**清除配对**」让所有工作区回到默认的同名目录，不影响勾选。

两个根目录也在这一张卡片上改：手机默认 `/storage/emulated/0/DSH`，电脑默认
`<DSH_HOME>/sessions`（也就是 dsh 自己的对话目录；旧版本留下的 `~/DSH` 会在升级时自动迁过来，
自己改过的路径不会被覆盖）。

> 会话搬到另一台机器时，文件头里的 `cwd` 会改写成新目录，**文件也会挪到对应的项目目录**——
> dsh 是用 `projectKey(cwd)` 推导日志路径的，目录和文件头不一致的会话等于不存在。
> 会话要连同 `workspace.json` 一起落地才会出现在侧栏；面板会提示「重载界面」。

---

## 6. 模型组与密钥

### 6.1 模型组是什么

模型通道按**组**列出，每组一个开关：

| 组 | 来源 | 含义 |
| --- | --- | --- |
| `llm-pi-ai/grok` | 电脑 profile patch | `config.providers.grok` 这一个提供方 |
| `llm-pi-ai/opencode-free` | 插件 `dsh-opencode-free` | 插件自带的提供方，行上标「插件提供」 |
| `some-row` | 整行 | patch 里一个自己写了 `baseURL` 的顶层条目 |

插件提供的组也会列出来（插件没勾时行上会标「插件 X 未勾选」）。

### 6.2 为什么以前只有 opencode-go 能用

dsh 的 `llm-pi-ai` 只从两处取密钥：

1. `<DSH_HOME>/.credentials.yaml` 的 `refs:`；
2. **启动时**的环境快照。

取不到就直接抛 `MISSING_CREDENTIAL`，报「未检测到环境变量」。手机原来只有
`opencode-go: { apiKeyEnv: OPENCODE_GO_API_KEY }`，而手机 `refs:` 里恰好有这一条，所以只有它能跑。

### 6.3 现在的做法：密钥跟着组走

- 勾一个模型组 = 同时准备「这组的配置」+「这组引用的 `refs:`」（`GROK_API_KEY` 等）。
- 每组行上还有一个小的「**密钥**」子勾，显示该组引用了哪些 ref；默认随组勾选。
- 电脑把这些 ref 写进合并后的 `.credentials.yaml`，**整份**下发（这个文件必须完整，dsh 会拒绝只有 `refs:` 的文档）。
- 手机原有的 `refs:` / `records:` 先随上传报回电脑，合并后整份下发，所以手机自己的密钥不会丢。

### 6.4 手动补一个密钥（不改配置文件）

只想要某一个 provider 能用、又不想同步整组：

1. 在电脑的 `~/.dsh/.credentials.yaml` 里给 `refs:` 加一行（然后等 dsh 自动热重载）：

   ```yaml
   refs:
     GROK_API_KEY: <你在 GROK 控制台拿到的密钥>
   ```

2. 在手机上做同样的事；或者勾上对应模型组、点一次「开始同步」让插件带过去。

> 密钥走局域网明文 HTTP。家里的/公司内网可以用，**别在公共 Wi-Fi 上同步**。
> 「同步 API 密钥」这个总开关就在**模型组**卡片里（紧挨着「全带密钥 / 全不带」），
> 用来整体打开/关闭密钥文件的下发——密钥属于模型，不属于会话通道。

### 6.5 检查：面板上那一行应该长什么样

```
Grok            3 模型   密钥 ✓
opencode-go    30 模型   无 endpoint   密钥 ✓   （50 模型的组也是这种形状）
```

- `密钥 ✓`：这组会带上它引用的 ref（鼠标悬停能看到 ref 名字）。
- `密钥 ✕`：这组的密钥开关关着，手机需要自己填。
- 行尾红标「缺密钥 XXX」：电脑上压根没有这个 ref，点了组也会在手机上报错——先补 `~/.dsh/.credentials.yaml`。
- `无 endpoint`：这个 provider 不自己写 `baseURL`，由插件或默认端点提供。

---

## 7. 手机上手动操作

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

---

## 8. 常见问题

**点「开始同步」手机没反应**
手机必须还在 `pair`/`wait`/`watch` 里等待（终端窗口别关）。过期了就再点一次；
或者直接在手机终端跑 `sh ~/.dsh-mobile-sync/sync.sh both`。

**手机连不上，电脑上打得开**
Windows 防火墙。允许「专用网络」，或加一条规则：

```powershell
New-NetFirewallRule -DisplayName "DSH mobile sync" -Direction Inbound -LocalPort 8733 -Protocol TCP -Action Allow -Profile Private
```

**面板上有好几个网卡地址**
虚拟机、WSL、Docker 都会冒出网卡。插件按 192.168 → 10 → 172.16–31 排序，默认选第一个；不对就点另一个地址。

**模型报「未检测到环境变量 / 没有 key」**
按 6.3 勾上那一组并同步（会自动带密钥），或按 6.4 手动补。
注意：**启动之后才 export 的环境变量 dsh 看不到**（读的是启动快照）。

**插件行写着「不兼容警告」**
含原生二进制（`.node`/`.dll`/`.so`）或声明了**外部**运行时 `dependencies` 的插件会被标出来，
但**仍然可以勾**：勾上照样下发，日志里会写明原因，修不修由手机端决定。
如果这个包自己带了 `node_modules`（「自带依赖」标记），就不会有警告。
原因在行的悬停提示里，行下面的那行小字是插件的**用途描述**（来自它自己的 `package.json`，没有就读 README 第一句）。

**面板下半看不到手机工作区**
手机还没上报过索引。手机跑一次 `pair`（或 `sh ~/.dsh-mobile-sync/sync.sh pull` 之后点一次「开始同步」），
面板就会列出它的工作区，每个都能选回到电脑的哪个工作区。

**同步过去了但侧栏没有**
会话要连同 `workspace.json` 一起落地才可见，面板会提示「重载界面」；
装了插件 / 改了 patch 需要**重启 DSH** 才加载。

**升级到新版后开关全变了**
v0.4 把「插件 / 技能 / 模型组」的默认改成**全不勾**；v0.5 又把工作区改成逐个项目勾「同步对话」
（默认全不勾，旧版「同名自动对齐」一次性清掉），并把电脑同步根目录迁到 `<DSH_HOME>/sessions`。
旧状态文件只做一次性重新播种，之后的勾选不会再被覆盖。升级后第一件事：在「同步工作区」里把要同步的项目勾上。

---

## 9. 排障工具（只读，不写任何东西）

```sh
# 面板看到的一切：通道、逐项开关、模型组与密钥状态
node tools/catalog-probe.mjs C:/Users/wangc/.dsh

# 用真实目录把侧栏面板渲染一遍（检查字段有没有接上）
node tools/panel-probe.mjs C:/Users/wangc/.dsh --text

# dry-run 下一次下发（不连手机）
node tools/plan-probe.mjs C:/Users/wangc/.dsh
```

跑测试（不需要真机）：

```sh
NODE=<node22+> sh test/run.sh 8733          # 8 套单元 + 一次真 curl/tar/pair 往返
SKIP_SHELL=1 NODE=<node22+> sh test/run.sh  # 只跑单元
```

---

## 10. 仓库与发布

本仓库就是插件本体（本地 `link:` 挂进 profile，不需要发 npm）。

```sh
git clone https://github.com/TZYCeng/dsh-android-Conversation-sync
cd dsh-android-Conversation-sync
# 然后按第 1 节把 profile 指向这个目录
```

发布新版本：

```sh
node tools/panel-probe.mjs ~/.dsh        # 先确认面板能渲染
NODE=<node22+> sh test/run.sh 8733       # 8 套单元 + 真往返
git add -A && git commit -m "…"
git push                                 # 走 Windows 凭据管理器，第一次会让授权
```

- 仓库里**没有任何密钥**；`~/.dsh/.credentials.yaml` 在 DSH home，不在仓库目录。
- `.gitattributes` 统一 LF（`*.cmd` 例外）。

---

## 11. 安全提示

- 局域网明文 HTTP + 32 位令牌，没有 TLS。别在公共 Wi-Fi 上用。
- 密钥文件 `.credentials.yaml` 在手机上会被**整份覆盖**；它的内容是电脑上该文件的合并结果。
  第一次勾「密钥」前，确认你接受这一点。
- 服务只暴露 `/api/ping`、`/api/manifest`、`/api/await`、`/api/done`、`/api/pull`、`/api/push` 和说明页，没有任意文件读写。
- 上传包 256 MB 上限，路径里的 `..` 一律拒绝。

---

## 12. 卸载

从 profile 的 `bundles` 里删掉 `dsh-mobile-sync`，删掉那个 `node_modules` 联接，重启 DSH。
`~/.dsh/dsh-mobile-sync/`（令牌、手机上报缓存、备份）可以留着，也可以直接删。
