# 测试

这套检查不需要 DSH 在跑，也不需要真机——它自己起一个临时监听、造几个会话文件、造一个假 profile 和几个假插件/技能，把桌面端和手机端的路径都走一遍。

```sh
# 全部检查（8 个单元套件 + 一次手机形态的往返）
NODE=/path/to/node sh test/run.sh [端口]

# 只跑单元套件（不跑 curl/tar 往返）
SKIP_SHELL=1 NODE=/path/to/node sh test/run.sh

# 单独跑
node test/host.mjs      会话扫描 / cwd 改写 / 索引登记 / 目录迁移 / HTTP 路由 / tar 长路径
node test/entry.mjs     按 DSH 内核的方式加载 index.js，验证两条 connection.fetch 路由
node test/client.mjs    在 vm 里用桩 React 渲染侧栏面板，验证开始同步按钮、工作区配对、逐项开关、每组密钥开关与动作
node test/qr.mjs        把二维码 SVG 反解成点阵，和编码器逐格比对
node test/plugins.mjs   插件枚举：主机库排除、原生二进制、运行时依赖、bundle 判定、体积上限
node test/skills.mjs    技能枚举：frontmatter、目录/平铺、去重、跳过目录、内容摘要
node test/models.mjs    模型分组（整行 / config.providers / 插件 patch）、嵌套 provider 合并与幂等、credentials 的 refs 合并
node test/transfer.mjs  同步规划：默认全不勾、版本/摘要跳过、单向插件、索引与 cwd 映射、双向工作区配对
sh   test/phone.sh <工作目录> <桌面地址> <令牌>   手机端脚本的往返（含 pair 等待按钮验证）
```

## 为什么有这些套件

- **host** 是主战场：多帧 zstd 的解码边界、目录名当身份、更长者胜的合并规则、`cwd` 改写后文件必须搬目录、索引登记、备份、令牌、端口回退。
- **entry** 是唯一能证明「插件在真实内核里不会加载失败」的手段：它用 `ctx.effect` / `ctx.inject` 的桩调用 `apply()`，然后直接打那两个路由。
- **client** 用桩 React（手写 hook 数组）在 `node:vm` 里跑 `client.js`——profile 里没有 react，真渲染跑不起来，这是唯一可行的渲染测试。它还断言每个插件/技能/模型组都有自己的开关，点一下正好发出对应的 action，以及「开始同步」按钮与工作区下拉。
- **qr** 把 `M<x> <y>h1v1h-1z` 反解回点阵，逐格对照编码器输出，避免「二维码能生成但扫不出来」。
- **plugins / skills / models** 是纯文件系统的判定逻辑，用临时目录造真实形状的包和技能，避免拿真 profile 当测试夹具。
- **transfer** 直接对应用户提出的要求：插件/技能/模型组默认全不勾、开关跨次保留、版本相同不同步、插件只从电脑到手机；工作区可以改投到不同名的手机工作区，清空后恢复同名。
- **phone** 用真 `curl` + 真 `tar` 打一次包，验证「手机只搬字节」这条设计成立，第二次拉取确实是空的；第 7 节还会跑 `pair`，证明下载脚本本身不同步、只有桌面点了「开始同步」才上传/下载并回报 done。

## 辅助脚本

| 文件 | 用途 |
| --- | --- |
| `fixture.mjs` | 起一个临时桌面监听（带假 profile、假插件、假技能、真会话），打印 `READY <base> <token> <port>`；`DSH_FIXTURE_ARM_MS=4000` 会在启动 4 秒后自动点一次「开始同步」 |
| `make-phone-session.mjs` | 复制一个真会话并改写文件头 id，冒充手机产生的记录 |

`make-phone-session.mjs` 依赖本机 `~/.dsh/sessions` 里至少有一个真实会话；没有就先用 DSH 随便聊两句。
