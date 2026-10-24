# 密钥与模型通道（v0.4 设计）

## 现状 / 问题

用户实测：手机上只有 `opencode-go` 能调用，其它模型组报

> 未检测到环境变量。请填写 API 密钥，或设置环境变量 GROK_API_KEY

## 根因

`@deepseek-ai/dsh-llm-pi-ai` 的 `resolveApiKey`：

```js
const resolveApiKey = async (provider, profile) => {
  const ref = profile.apiKeyEnv
  if (ref === void 0) return void 0
  const credentials = ctx.get('credentials')
  const hit = credentials !== void 0
    ? (await credentials.resolve(ref))?.value
    : launchEnvironmentOf(ctx).get(ref)?.value
  if (hit !== void 0 && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
  throw new LlmError(`... its profile resolves ${ref}, which is not set ...`, 'MISSING_CREDENTIAL')
}
```

1. 有 `apiKeyEnv` 时，只认两处：`ctx.credentials`（即 `<DSH_HOME>/.credentials.yaml` 的 `refs:`）
   或**启动时**的环境快照；解析不到直接抛 `MISSING_CREDENTIAL`。
2. 手机原来的 `llm-pi-ai` 只有 `opencode-go: { apiKeyEnv: OPENCODE_GO_API_KEY }`，
   而手机 `.credentials.yaml` 里恰好有 `OPENCODE_GO_API_KEY` —— 所以只有它能跑。
3. v0.3 把 provider 子树整段复制过去（包括 `apiKeyEnv: GROK_API_KEY`），
   但**从来没有下发过密钥**，手机于是报它没有的名字。

## 修法

模型通道里「密钥跟着组走」：

- 每组由 `lib/models.js` 解析出它引用的 `refs`（`apiKeyEnv`/`apiKeyRef`/`apiKey` + 扫描到的 token）。
- 勾选一组 = 同时准备「这一组的配置」和「这一组引用的 refs」。
- 面板每组多一个「密钥」子勾（默认随组走：勾组就带上），可以看到哪个 ref 没值。
- 桌面把 refs 写进合并后的 `.credentials.yaml`，**整份**下发（`.credentials.yaml` 必须是完整文档）。
- 手机原有 refs/records 先随上传报回，合并后再整份下发，所以手机自己的密钥不会丢。

## 实现清单

1. `channels.js`：`defaultSync.secrets = true`（密钥不再整体关掉），`ITEM_DEFAULTS` 不变。
2. `models.js`：
   - provider 组要能解析到 `apiKeyEnv`（现在 `KEY_REFS` 里加了 `apiKeyEnv`，已覆盖）。
   - `buildMergedCredentials` 已有「按名字写入 refs」，复用。
3. `planPull` 模型段：
   - 计算 `refsNeeded(groups)`；
   - `sync.secrets === true` 或该组 `key` 在 `sync.modelsKeys` 中 → 下发；
   - 手机没上报 credentials 时，用**空文档骨架**（`version: 1\nrefs:\n...`）生成，而不是跳过。
4. `handlePull`：模型段生成 credentials 时也要更新 `state.sent.credentials`（已有）。
5. 手机 `dsh-sync.sh`：`manifest secrets=1` 时上传 `.credentials.yaml`（已有）。
6. 桌面 `state.sync`：新增 `modelKeys` 映射（key → bool），默认 true。
7. 测试：`test/models.mjs` / `test/transfer.mjs` 覆盖「勾组 → refs 一起下发」「手机没有 credentials 也能生成骨架」。
