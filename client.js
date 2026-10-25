/**
 * dsh-mobile-sync — browser half.
 *
 * One surface: a sidebar panel that shows the pairing QR code, the address the
 * phone should reach, the exact command to paste into the phone's DeepCode app,
 * the sync switches, and what has been synced. Data comes from the host half
 * over the plugin's own same-origin `/api/dsh-mobile-sync/*` routes.
 *
 * The switches are the point of this panel rather than a detail of it: every
 * channel and every single plugin / skill has its own switch, an undecided item
 * gets that item's default, and a decided one keeps the user's choice — the host
 * persists it, so the next sync starts exactly where the last one left off.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides, and every colour comes from theme
 * variables so the panel survives a light/dark switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile-sync',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const NS = 'dsh-mobile-sync'
    const PANEL_ID = 'dsh-mobile-sync'

    // Resolved against the page base, not the origin: DSH can be mounted under a
    // reverse-proxy prefix, where a leading slash would drop that prefix.
    const API = (() => {
      try {
        return new URL('api/dsh-mobile-sync', document.baseURI).pathname
      } catch {
        return '/api/dsh-mobile-sync'
      }
    })()

    /* ------------------------------------------------------------ dictionary */

    const DICT = {
      zh: {
        nav: '手机同步',
        title: '手机同步',
        subtitle: '同一 Wi-Fi 下把会话、插件、技能对齐到手机',
        running: '运行中',
        stopped: '未运行',
        starting: '启动中…',
        portError: '端口占用',
        scan: '手机扫码',
        scanHint: '扫码打开说明页；也可以直接在手机浏览器里打开下面的地址。',
        paste: '在 DeepCode 里粘贴这条命令',
        copy: '复制命令',
        copied: '已复制',
        copyFailed: '复制失败，请手动选中',
        openPage: '在本机浏览器打开',
        installHint: '命令里的 pair 会配对并等待：下载脚本不会自动同步，点上面的「开始同步」双方才开始。',
        adapters: '网卡',
        adapterHint: '手机和电脑要在同一个局域网里，选一个手机能访问到的地址。',
        stats: '本机会话',
        fromPhone: '来自手机',
        refresh: '刷新',
        resetToken: '重置令牌',
        resetConfirm: '重置后手机需要重新扫码，确定吗？',
        restart: '重启监听',
        log: '最近同步',
        noLog: '还没有同步记录',
        sessionsRoot: '会话目录',
        noAddress: '没有找到可用的局域网地址，请检查网络连接。',
        loadFailed: '无法读取插件状态',
        retry: '重试',

        channels: '同步通道',
        chSessions: '会话',
        chModels: '模型',
        chPlugins: '插件',
        chSkills: '技能',
        channelHint: '关掉的通道整条不动；打开后还要下面逐项勾选才会真的传。',
        mode: '目标工作区',
        modeAuto: '同名工作区互传',
        modeRoot: '统一放到同步目录',
        modeHint: '目标目录：勾上的工作区落在手机上的同名文件夹；也可以在这一行右侧把它改投到手机任意一个工作区。',
        phoneRoot: '手机同步根目录',
        desktopRoot: '电脑同步根目录',
        archived: '含已归档会话',
        secrets: '同步 API 密钥',
        secretsWarn: '密钥走局域网明文 HTTP，默认关闭：只传模型用到的 refs，records 不动。',
        force: '强制重发',
        forceHint: '忽略「版本相同 / 内容相同」的判断，下一次下发全量重传。',
        plugins: '插件',
        pluginsHint: '只从电脑到手机（单向）。默认全不勾：勾一项推一项；取消勾选不会卸载手机上已装的。标「不兼容警告」的也能勾，开启时提示，由手机端自行修。',
        skills: '技能',
        skillsHint: '只从电脑到手机。默认全不勾：勾选后才推送，references/scripts 一起搬。',
        models: '模型',
        modelsHint: '只同步勾选的模型组；插件装载的模型也按组列出。',
        modelsEmpty: '电脑上没有可同步的模型组。',
        selectAll: '全选',
        selectNone: '清空',
        selectedCount: '已选',
        remote: '手机',
        noPeer: '还没有手机上报，先让手机跑一次',
        stateSend: '下发',
        stateSame: '版本相同',
        stateNewer: '手机较新',
        stateOff: '未选',
        stateUnsupported: '不支持',
        stateNoPeer: '待手机上报',
        noneInCategory: '没有可同步的条目',
        countsLabel: '本机会话',
        countsIndexed: '已登记',
        countsUnindexed: '未登记（不同步）',
        errors: '读取失败',

        syncTitle: '手动同步',
        syncNow: '开始同步',
        syncCancel: '取消',
        syncWaiting: '等待手机取走指令…',
        syncTaken: '手机正在同步…',
        syncDone: '同步完成',
        syncNever: '还没有点过同步',
        syncAgain: '再同步一次',
        syncIdle: '手机配对后不会自动同步；点这个按钮，双方才开始上传和下载。',
        syncNeedPair: '手机要先跑命令里的 pair 模式（配对并等待），按钮才有效。',

        workspaceTitle: '同步工作区',
        workspaceHint: '上半：每个电脑工作区一个「同步对话」开关（和插件、技能一样，默认全不勾），勾上才双向同步。下半：手机上报的工作区，选它回到电脑时落到哪个工作区。',
        workspaceAuto: '同名（自动）',
        workspaceTarget: '默认：手机同名目录',
        workspaceRoot: '手机根目录',
        workspacePhone: '手机端工作区',
        workspacePhoneHint: '手机上报的项目列在下面；给某项选一个电脑工作区，它回到电脑时就落到那儿（不选则落到电脑根目录下的同名文件夹）。',
        workspacePhoneTarget: '默认：电脑同名目录',
        workspaceNone: '手机还没有上报工作区索引。先让手机配对并完成一次同步。',
        workspaceReset: '清除配对',
        workspaceSessions: '会话',
        workspaceDeskCount: '电脑',
        workspacePhoneCount: '手机',
        workspaceArchived: '归档',
        workspaceNoIndex: '电脑的 workspace.json 读不出来',
        workspaceSync: '同步对话',
        workspaceSyncHint: '「同步对话」：勾选后这个工作区的会话才会和手机互传',
        pluginBundled: '自带依赖',
        pluginWarn: '不兼容警告',
        pluginWarnTitle: '开启时提醒：',
        modelsGroups: '模型组',
        modelsGroupHint: '每个模型组单独勾选：一行自带 endpoint 的配置，或 config.providers 里的一个提供方；插件提供的也在列表里。',
        modelsPlugin: '插件提供',
        modelsPluginOff: '插件未勾选',
        modelsNoEndpoint: '无 endpoint',
        modelsKeyMissing: '缺密钥',
        modelsKey: '密钥',
        modelsKeysAll: '全带密钥',
        modelsKeysNone: '全不带',
        modelsKeysHint: '勾选模型组时，它用到的 API 密钥会一起写进手机的 .credentials.yaml；这里可以逐组关掉。',
        secretsOff: '「同步 API 密钥」总开关关着：模型配置会下发，但手机仍会报「没有 key」。',
      },
      en: {
        nav: 'Phone sync',
        title: 'Phone sync',
        subtitle: 'Align sessions, plugins and skills with the phone over Wi-Fi',
        running: 'Running',
        stopped: 'Stopped',
        starting: 'Starting…',
        portError: 'Port unavailable',
        scan: 'Scan on the phone',
        scanHint: 'Scanning opens the instructions page. You can also open the address below in the phone browser.',
        paste: 'Paste this into DeepCode on the phone',
        copy: 'Copy command',
        copied: 'Copied',
        copyFailed: 'Copy failed — select it manually',
        openPage: 'Open in browser',
        installHint: 'pair installs the script and waits. Downloading it never starts a sync — press Start sync above.',
        adapters: 'Adapter',
        adapterHint: 'The phone and this computer must share a network. Pick an address the phone can reach.',
        stats: 'Local sessions',
        fromPhone: 'from phone',
        refresh: 'Refresh',
        resetToken: 'Reset token',
        resetConfirm: 'Phones will have to scan again. Continue?',
        restart: 'Restart listener',
        log: 'Recent sync',
        noLog: 'Nothing synced yet',
        sessionsRoot: 'Session store',
        noAddress: 'No LAN address found — check the network connection.',
        loadFailed: 'Could not read plugin state',
        retry: 'Retry',

        channels: 'Channels',
        chSessions: 'Sessions',
        chModels: 'Models',
        chPlugins: 'Plugins',
        chSkills: 'Skills',
        channelHint: 'A channel that is off moves nothing; an item still has to be ticked below.',
        mode: 'Target workspace',
        modeAuto: 'Match by title',
        modeRoot: 'One sync folder',
        modeHint: 'Target: a ticked workspace lands in the phone folder of the same name; use the selector on its row to point it somewhere else.',
        phoneRoot: 'Phone sync root',
        desktopRoot: 'Desktop sync root',
        archived: 'Include archived',
        secrets: 'Sync API keys',
        secretsWarn: 'Keys would cross plain HTTP. Off by default; only the refs the models use, records untouched.',
        force: 'Force resend',
        forceHint: 'Ignore the "same version / same content" shortcut for the next pull.',

        plugins: 'Plugins',
        pluginsHint: 'Desktop to phone only (one-way). Nothing is ticked by default; a plugin marked with a warning can still be ticked and repaired on the phone.',
        skills: 'Skills',
        skillsHint: 'Desktop to phone. Nothing is ticked by default; references and scripts travel with the skill.',
        models: 'Models',
        modelsHint: 'Only ticked model groups travel; plugin-provided models are listed as groups too.',
        modelsEmpty: 'No model group to sync on this computer.',
        selectAll: 'All',
        selectNone: 'None',
        selectedCount: 'selected',
        remote: 'Phone',
        noPeer: 'No report from the phone yet — run it once',
        stateSend: 'send',
        stateSame: 'same version',
        stateNewer: 'phone newer',
        stateOff: 'off',
        stateUnsupported: 'unsupported',
        stateNoPeer: 'waiting for phone',
        noneInCategory: 'Nothing to sync',
        countsLabel: 'Local sessions',
        countsIndexed: 'indexed',
        countsUnindexed: 'unindexed (not synced)',
        errors: 'read failed',

        syncTitle: 'Manual sync',
        syncNow: 'Start sync',
        syncCancel: 'Cancel',
        syncWaiting: 'Waiting for the phone to pick it up…',
        syncTaken: 'The phone is syncing…',
        syncDone: 'Sync finished',
        syncNever: 'Not started yet',
        syncAgain: 'Sync again',
        syncIdle: 'A paired phone does not sync by itself. This button releases both sides.',
        syncNeedPair: 'The phone has to run the command in pair mode (pair and wait) first.',

        workspaceTitle: 'Workspaces',
        workspaceHint: 'Top: one「sync conversations」switch per desktop workspace, off like plugins and skills; only a ticked one syncs both ways. Bottom: the workspaces the phone reports — pick the desktop workspace each lands in when its conversations come back.',
        workspaceAuto: 'Same name (auto)',
        workspaceTarget: 'Default: same-named phone folder',
        workspaceRoot: 'Phone root',
        workspacePhone: 'Phone workspaces',
        workspacePhoneHint: 'The projects the phone reported. Pick a desktop workspace for one and its conversations land there (otherwise in a same-named folder under the desktop root).',
        workspacePhoneTarget: 'Default: desktop folder of the same name',
        workspaceNone: 'The phone has not reported its workspace index yet. Pair it and run one sync.',
        workspaceReset: 'Clear pairings',
        workspaceSessions: 'sessions',
        workspaceDeskCount: 'desktop',
        workspacePhoneCount: 'phone',
        workspaceArchived: 'archived',
        workspaceNoIndex: 'The desktop workspace.json is unreadable',
        workspaceSync: 'Sync conversations',
        workspaceSyncHint: 'Sync conversations: only a ticked workspace travels to and from the phone',
        pluginBundled: 'self-contained',
        pluginWarn: 'compat warning',
        pluginWarnTitle: 'On enable: ',
        modelsGroups: 'Model groups',
        modelsGroupHint: 'One switch per group: a whole endpoint row, or one provider inside config.providers. Plugin-provided groups are listed too.',
        modelsPlugin: 'from plugin',
        modelsPluginOff: 'plugin not ticked',
        modelsNoEndpoint: 'no endpoint',
        modelsKeyMissing: 'key missing',
        modelsKey: 'key',
        modelsKeysAll: 'Keys on',
        modelsKeysNone: 'Keys off',
        modelsKeysHint: "A ticked group carries the API key it names into the phone's .credentials.yaml; this toggles that per group.",
        secretsOff: 'The "Sync API keys" master switch is off: models travel but the phone will still report a missing key.',
      },
    }

    /* ----------------------------------------------------------------- style */

    const CSS = `
.msy-root{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:12px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-primary);height:100%;overflow-y:auto;scrollbar-gutter:stable}
.msy-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.msy-title{font-size:14px;font-weight:600;margin:0}
.msy-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.msy-state{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.msy-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#9aa3ae)}
.msy-dot-on{background:var(--dsw-alias-state-success-primary,#0a7d4f)}
.msy-dot-err{background:var(--dsw-alias-state-error-primary,#b42318)}
.msy-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.msy-card-tight{padding:8px 10px;gap:6px}
.msy-label{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.02em}
.msy-label-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}
.msy-qr{display:flex;justify-content:center;padding:6px 0}
.msy-qr svg{display:block;border-radius:6px;background:#fff;padding:4px}
.msy-code{margin:0;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-all;user-select:all}
.msy-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.msy-btn{font:inherit;font-size:11.5px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 10px;line-height:1.5}
.msy-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.msy-btn:disabled{opacity:.5;cursor:default}
.msy-btn-primary{background:var(--dsw-alias-button-primary-fill,#1b1d21);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.msy-btn-primary:hover{filter:brightness(1.08)}
.msy-chip{font:inherit;font-size:11px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 9px;line-height:1.6}
.msy-chip:hover{color:var(--dsw-alias-label-primary)}
.msy-chip-on{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 12%,transparent)}
.msy-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.msy-item{display:flex;gap:7px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;min-width:0}
.msy-item:last-child{border-bottom:0}
/* A plugin row carries a name and a description, so its items line up at the top. */
.msy-item{align-items:flex-start}
.msy-item>.msy-check,.msy-item>.msy-tag,.msy-item>.msy-meta{margin-top:2px}
.msy-check{flex:none;appearance:none;font:inherit;font-size:10px;line-height:1;width:14px;height:14px;padding:0;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.msy-check-on{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:var(--dsw-alias-brand-primary,#4c8dff);color:#fff}
.msy-check:disabled{opacity:.45;cursor:default}
.msy-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px}
.msy-name-col{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.msy-name-col .msy-name{flex:none}
.msy-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.35}
.msy-meta{flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10.5px;font-variant-numeric:tabular-nums}
.msy-tag{flex:none;font-size:10px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);line-height:1.5}
.msy-tag-send{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff)}
.msy-tag-same{color:var(--dsw-alias-state-success-primary,#0a7d4f);border-color:currentColor}
.msy-tag-bad{color:var(--dsw-alias-state-error-primary,#b42318);border-color:currentColor}
.msy-tag-warn{color:var(--dsw-alias-state-warning-primary,#a16207);border-color:currentColor;cursor:help}
.msy-stats{display:flex;gap:14px;flex-wrap:wrap}
.msy-stat{display:flex;flex-direction:column;gap:0}
.msy-stat-n{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}
.msy-stat-k{color:var(--dsw-alias-label-secondary);font-size:11px}
.msy-log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.msy-log li{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;min-width:0}
.msy-log li:last-child{border-bottom:0}
.msy-log-time{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));flex:none;font-variant-numeric:tabular-nums;font-size:10.5px}
.msy-log-text{flex:1;min-width:0;overflow-wrap:anywhere}
.msy-empty{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.msy-err{color:var(--dsw-alias-state-error-primary,#b42318);font-size:11.5px}
.msy-path{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));overflow-wrap:anywhere}
.msy-input{font:inherit;font-size:11px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);width:100%;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.msy-field{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.msy-key{font:inherit;font-size:10px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:0 7px;line-height:1.7;flex:none}
.msy-key:hover{color:var(--dsw-alias-label-primary)}
.msy-key-on{border-color:var(--dsw-alias-state-success-primary,#0a7d4f);color:var(--dsw-alias-state-success-primary,#0a7d4f)}
.msy-key:disabled{opacity:.45;cursor:default}
.msy-select{font:inherit;font-size:11px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);max-width:100%;min-width:0;flex:1}
.msy-group{display:flex;flex-direction:column;gap:2px;padding:4px 0 2px}
.msy-group-title{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:600;padding:4px 0 2px;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.msy-sync{display:flex;flex-direction:column;gap:6px}
.msy-sync-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.msy-btn-sync{font-weight:600;padding:6px 14px}
.msy-pairing{display:flex;flex-direction:column;gap:6px}
.msy-pair{display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;min-width:0}
.msy-pair:last-child{border-bottom:0}
.msy-pair-name{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px}
.msy-pair-arrow{flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
`

    /* ------------------------------------------------------------------ data */

    /** Call the host half; throws with a readable message on any failure. */
    async function api(path, options) {
      const { timeout = 20000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, redirect: 'error', signal: controller.signal })
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = { error: text.slice(0, 200) }
        }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /** A per-item switch value with an "undecided" fallback. */
    function picked(map, key, fallback) {
      const value = map?.[key]
      return typeof value === 'boolean' ? value : fallback
    }

    /** Format a timestamp as a short wall clock. */
    function clock(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—'
      const date = new Date(ms)
      const pad = value => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Human byte size, matching the host's wording. */
    function size(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /** Copy text, falling back to a hidden textarea on hosts without the API. */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Fall through to the legacy path.
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------- fragments */

    /** One switchable row: a box, a name, and whatever else the caller adds. */
    function SwitchRow(props) {
      const { checked, onToggle, disabled, label, children, title, ariaLabel } = props
      return h(
        'li',
        { className: 'msy-item', title },
        h(
          'button',
          {
            type: 'button',
            className: checked ? 'msy-check msy-check-on' : 'msy-check',
            role: 'checkbox',
            'aria-checked': checked === true,
            'aria-label': ariaLabel ?? `${label} sync`,
            disabled: disabled === true,
            onClick: onToggle,
          },
          checked ? '✓' : '·',
        ),
        h('span', { className: 'msy-name' }, label),
        ...(Array.isArray(children) ? children : [children]),
      )
    }

    /** The per-item state chip. */
    function StateTag(props) {
      const { state, t } = props
      const text = {
        send: t('stateSend'),
        same: t('stateSame'),
        newer: t('stateNewer'),
        off: t('stateOff'),
        unsupported: t('stateUnsupported'),
        nopeer: t('stateNoPeer'),
      }[state] ?? t('stateOff')
      const kind =
        state === 'send'
          ? 'msy-tag msy-tag-send'
          : state === 'same' || state === 'newer'
            ? 'msy-tag msy-tag-same'
            : state === 'unsupported'
              ? 'msy-tag msy-tag-bad'
              : 'msy-tag'
      return h('span', { className: kind }, text)
    }

    /** A titled list of switches with its own 全选/清空 buttons. */
    function SwitchList(props) {
      const { t, title, hint, items, onToggle, onAll, busy, render, emptyText, extra } = props
      const chosen = items.filter(item => item.selected === true).length
      return h(
        'div',
        { className: 'msy-card' },
        h(
          'div',
          { className: 'msy-label-row' },
          h('span', { className: 'msy-label' }, `${title} · ${chosen}/${items.length} ${t('selectedCount')}`),
          h(
            'span',
            { className: 'msy-row' },
            h('button', { type: 'button', className: 'msy-btn', disabled: busy || items.length === 0, onClick: () => onAll(true) }, t('selectAll')),
            h('button', { type: 'button', className: 'msy-btn', disabled: busy || chosen === 0, onClick: () => onAll(false) }, t('selectNone')),
          ),
        ),
        h('div', { className: 'msy-empty' }, hint),
        items.length === 0
          ? h('div', { className: 'msy-empty' }, emptyText ?? t('noneInCategory'))
          : h('ul', { className: 'msy-list' }, ...items.map((item, index) => render(item, index, onToggle, busy, t))),
        extra ?? null,
      )
    }

    /* --------------------------------------------------------------- surface */

    /**
     * The panel body. Polls the host while mounted so a phone that syncs shows up
     * without the user reloading anything.
     */
    function Panel(props) {
      const t = props.t
      const [status, setStatus] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [copied, setCopied] = useState(false)
      const [busy, setBusy] = useState(false)
      // Bumped by every status reload: a card that captured a render error
      // forgets it, so a retry (or the next poll) gets a fresh attempt.
      const [syncKey, setSyncKey] = useState(0)
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const next = await api('/status')
          if (alive.current) {
            setStatus(next)
            setError(undefined)
            // A boundary holds its error until this key changes; the poll is the
            // cheapest signal that "whatever broke may now work".
            setSyncKey(value => value + 1)
          }
        } catch (cause) {
          if (alive.current) setError(String(cause?.message ?? cause))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(load, 4000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const act = useCallback(
        async (action, body) => {
          setBusy(true)
          try {
            const next = await api('/action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, ...body }),
            })
            setStatus(next)
            setError(undefined)
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy(false)
          }
        },
        [],
      )

      const onCopy = useCallback(async () => {
        const ok = await copyText(status?.command ?? '')
        setCopied(ok ? 'ok' : 'fail')
        setTimeout(() => setCopied(false), 1600)
      }, [status])

      const running = status?.running === true
      const stateText =
        status === undefined
          ? t('starting')
          : running
            ? t('running')
            : status.error !== null && status.error !== undefined
              ? `${t('portError')}: ${status.error}`
              : t('stopped')
      const dotClass = running ? 'msy-dot msy-dot-on' : status?.error ? 'msy-dot msy-dot-err' : 'msy-dot'
      const address = status?.urls?.[0]
      const channels = status?.channels ?? {}
      const sync = status?.sync ?? {}
      const plugins = Array.isArray(status?.plugins) ? status.plugins : []
      const skills = Array.isArray(status?.skills) ? status.skills : []
      const models = Array.isArray(status?.models) ? status.models : []
      const peer = status?.peer ?? null
      const request = status?.request ?? null
      const requestState = request?.status ?? null
      const workspaces = status?.workspaces ?? null
      const desktopWorkspaces = Array.isArray(workspaces?.desktop) ? workspaces.desktop : []
      const phoneWorkspaces = Array.isArray(workspaces?.phone) ? workspaces.phone : []
      const phoneKnown = workspaces?.phoneKnown === true
      const wsMap = sync.workspaceMap ?? {}

      /** The phone workspace a desktop one resolves to right now. */
      const resolveTarget = (workspace) => {
        const paired = wsMap[workspace.id]
        if (typeof paired === 'string' && paired.length > 0) {
          return phoneWorkspaces.find(item => item.id === paired) ?? null
        }
        const title = String(workspace.title ?? '').trim().toLowerCase()
        return phoneWorkspaces.find(item => String(item.title ?? '').trim().toLowerCase() === title) ?? null
      }

      /** The manual-sync button label and state. */
      const syncButton = (() => {
        if (requestState === 'pending') return { label: t('syncWaiting'), disabled: true, action: null }
        if (requestState === 'taken') return { label: t('syncTaken'), disabled: true, action: null }
        return {
          label: requestState === 'done' ? t('syncAgain') : t('syncNow'),
          disabled: busy,
          action: 'request-sync',
        }
      })()
      const syncLine =
        requestState === 'pending'
          ? t('syncWaiting')
          : requestState === 'taken'
            ? t('syncTaken')
            : requestState === 'done'
              ? `${t('syncDone')} ${clock(request?.doneAt ?? 0)}`
              : requestState === 'expired'
                ? t('syncNever')
                : t('syncIdle')

      /**
       * One row of the plugin list: version, size and what the next pull will do.
       *
       * A plugin with native bits or outside dependencies is still switchable —
       * the phone may be the place to repair it — but its row carries a warning
       * tag. Only a package that cannot be mounted at all stays disabled.
       */
      /**
       * One row of the plugin list: version, size and what the next pull will do.
       *
       * The package name alone does not say what a plugin is for, so the row
       * carries the package's own one-line description underneath it (the
       * long description, if any, is the hover title). A plugin with native bits
       * or outside dependencies is still switchable — the phone may be the place
       * to repair it — but its row carries a warning tag. Only a package that
       * cannot be mounted at all stays disabled.
       */
      const pluginRow = (plugin, index, onToggle, isBusy, translate) => {
        const summary = typeof plugin.description === 'string' ? plugin.description.trim() : ''
        const long = typeof plugin.descriptionFull === 'string' ? plugin.descriptionFull.trim() : ''
        return h(
          'li',
          { className: 'msy-item', title: [long || summary, plugin.warning].filter(Boolean).join('\n') },
          h(
            'button',
            {
              type: 'button',
              className: plugin.selected === true ? 'msy-check msy-check-on' : 'msy-check',
              role: 'checkbox',
              'aria-checked': plugin.selected === true,
              'aria-label': `${plugin.name} sync`,
              disabled: isBusy || plugin.deliverable === false,
              onClick: () => onToggle(plugin.name, plugin.selected !== true),
            },
            plugin.selected === true ? '✓' : '·',
          ),
          h(
            'span',
            { className: 'msy-name-col' },
            h(
              'span',
              { className: 'msy-name' },
              plugin.version ? `${plugin.name}@${plugin.version}` : plugin.name,
            ),
            summary.length > 0
              ? h('span', { className: 'msy-desc', 'aria-label': `${plugin.name} description` }, summary)
              : null,
          ),
          plugin.dependenciesInside === true && (plugin.dependencies ?? []).length > 0
            ? h('span', { className: 'msy-tag msy-tag-same' }, translate('pluginBundled'))
            : null,
          plugin.deliverable === false
            ? h('span', { className: 'msy-tag msy-tag-bad' }, translate('stateUnsupported'))
            : plugin.warning
              ? h(
                  'span',
                  { className: 'msy-tag msy-tag-warn', title: plugin.warning },
                  translate('pluginWarn'),
                )
              : null,
          h('span', { className: 'msy-meta' }, size(plugin.bytes)),
          h(StateTag, { state: plugin.state, t: translate }),
        )
      }

      const skillRow = (skill, index, onToggle, isBusy, translate) =>
        h(
          SwitchRow,
          {
            key: skill.name,
            checked: skill.selected === true,
            disabled: isBusy,
            label: skill.name,
            title: skill.description ?? skill.name,
            onToggle: () => onToggle(skill.name, skill.selected !== true),
          },
          h('span', { className: 'msy-meta' }, `${skill.files ?? 1} · ${size(skill.bytes)}`),
          h(StateTag, { state: skill.state, t: translate }),
        )

      /** Flip one model group's key switch (it rides along with the group). */
      const onKey = useCallback((name, on) => act('set-key', { name, on }), [act])

      /**
       * The per-group key switch ("密钥 ✓/✕"): whether this group carries the
       * credential refs it names. A plain function component keeps the value
       * readable both in the panel and in a render pass.
       */
      function keyChip(model, isBusy, translate, onKeyToggle) {
        const on = model.keySelected !== false
        return h(
          'button',
          {
            type: 'button',
            className: on ? 'msy-key msy-key-on' : 'msy-key',
            role: 'checkbox',
            'aria-checked': on,
            'aria-label': `${model.label ?? model.key} key`,
            disabled: isBusy,
            title: `${(model.keys ?? []).join(', ') || '—'}${
              (model.missingKeys ?? []).length > 0 ? ` · 电脑上缺 ${model.missingKeys.join(', ')}` : ''
            }`,
            onClick: () => onKeyToggle(model.key, !on),
          },
          `${translate('modelsKey')} ${on ? '✓' : '✕'}`,
        )
      }

      const modelRow = (model, index, onToggle, isBusy, translate, onKeyToggle, keyOn) =>
        h(
          SwitchRow,
          {
            key: model.key,
            checked: model.selected === true,
            disabled: isBusy,
            label: `${model.label ?? model.provider ?? model.key}`,
            title: [
              model.kind === 'provider' ? `${model.rowId ?? ''}/${model.provider ?? ''}` : model.key,
              model.baseURL ?? model.endpoint ?? '',
              (model.models ?? []).join(', '),
              model.plugin ? `plugin: ${model.plugin}` : '',
            ]
              .filter(part => part !== '')
              .join(' · '),
            ariaLabel: `${model.label ?? model.provider ?? model.key} sync`,
            onToggle: () => onToggle(model.key, model.selected !== true),
          },
          h('span', { className: 'msy-meta' }, `${(model.models ?? []).length} 模型`),
          model.baseURL
            ? null
            : h('span', { className: 'msy-tag' }, translate('modelsNoEndpoint')),
          model.source === 'plugin'
            ? h(
                'span',
                { className: model.pluginSelected === false ? 'msy-tag msy-tag-bad' : 'msy-tag' },
                model.pluginSelected === false ? `插件 ${model.plugin} 未勾选` : `${translate('modelsPlugin')} ${model.plugin ?? ''}`,
              )
            : null,
          keyChip(model, isBusy, translate, onKeyToggle),
          (model.missingKeys ?? []).length > 0
            ? h('span', { className: 'msy-tag msy-tag-bad' }, `${translate('modelsKeyMissing')} ${model.missingKeys.join(',')}`)
            : null,
        )

      // The panel groups the model rows by the top-level patch entry they live
      // in, which is also how the planner merges them.
      const modelSections = []
      const byRow = new Map()
      for (const model of models) {
        const rowKey = model.rowId ?? model.key
        if (!byRow.has(rowKey)) {
          const section = { rowId: rowKey, source: model.source, plugin: model.plugin ?? null, items: [] }
          byRow.set(rowKey, section)
          modelSections.push(section)
        }
        byRow.get(rowKey).items.push(model)
      }

      /** Everything a card may read; one object so cards stay scope-free. */
      const ctx = {
        t, act, busy, status, error, load, copied, onCopy, onKey,
        channels, sync, plugins, skills, models, modelSections,
        peer, workspaces, desktopWorkspaces, phoneWorkspaces, phoneKnown,
        wsMap, resolveTarget, request, requestState, syncLine, syncButton,
        pluginRow, skillRow, modelRow, address, dotClass, stateText,
        resetKey: syncKey,
      }

      return h(
        'div',
        { className: 'msy-root' },
        h(
          'div',
          { className: 'msy-head' },
          h('h2', { className: 'msy-title' }, t('title')),
          h('span', { className: 'msy-state' }, h('span', { className: dotClass }), stateText),
        ),
        h('div', { className: 'msy-sub' }, t('subtitle')),

        error !== undefined
          ? h(
              'div',
              { className: 'msy-card msy-card-tight' },
              h('div', { className: 'msy-err' }, `${t('loadFailed')}: ${error}`),
              h('div', { className: 'msy-row' }, h('button', { className: 'msy-btn', onClick: load }, t('retry'))),
            )
          : null,

        (status?.errors ?? []).length > 0
          ? h(
              'div',
              { className: 'msy-card msy-card-tight' },
              h('div', { className: 'msy-label' }, t('errors')),
              ...status.errors.map((line, index) => h('div', { key: index, className: 'msy-err' }, line)),
            )
          : null,

        /* ---------------------------------------------------- manual sync */
        ...guarded(CARDS, ctx),
      )
    }

    /** The rail icon: a phone with two arrows, sized to whatever the rail asks for. */
    function Logo(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          x: 4.4,
          y: 1.2,
          width: 7.2,
          height: 13.6,
          rx: 1.8,
          stroke: 'currentColor',
          strokeWidth: 1.25,
        }),
        h('path', { d: 'M6.6 3.5h2.8', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
        h('path', {
          d: 'M6.3 7.2h3.4m0 0-1.1-1.1m1.1 1.1-1.1 1.1',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M9.7 11.2H6.3m0 0 1.1-1.1M6.3 11.2l1.1 1.1',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /* ----------------------------------------------------------------- mount */

    /** Slot services this half needs before it can contribute anything. */
    const inject = ['slots', 'locale']

    /**
     * Register the panel and its rail entry.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'mobile-sync: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-mobile-sync')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'mobile-sync: styles')

      const t = ctx.locale.bind(NS)
      if (ctx.slots === undefined) return

      // `sidebar.panellist` is the rail; registering into it is also what tells
      // the shell this plugin has a panel worth showing. Both registrations live
      // together so a shell without a sidebar leaves nothing half-mounted.
      try {
        ctx.slots.inject('sidebar.panellist', () => {
          const offPanel = ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) },
            owner => h(Panel, { ...owner, t }),
          )
          const offRow = ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => t('nav'), locale: NS },
            owner => h(Logo, { size: owner?.size ?? 16 }),
          )
          return () => {
            if (typeof offRow === 'function') offRow()
            if (typeof offPanel === 'function') offPanel()
          }
        })
      } catch (cause) {
        // A shell without a sidebar still serves the LAN page, which is the
        // whole feature; losing the panel is a downgrade, not a failure.
        if (typeof console !== 'undefined') console.warn('[mobile-sync] sidebar unavailable:', cause)
      }
    }

    exports.name = 'mobile-sync'
    exports.inject = inject
    exports.apply = apply
    exports.__test = {
      clock,
      copyText,
      size,
      DICT,
      SwitchRow,
      SwitchList,
      StateTag,
      // The boundary is declared below the export line so the card list can
      // reference it lazily; exposing it through a getter keeps the test hook
      // working without hoisting the class ahead of its declaration.
      get Boundary() {
        return Boundary
      },
    }

    /* --------------------------------------------------------------- guards */

    /**
     * Error boundary for one card.
     *
     * A render that throws anywhere inside the panel used to blank the whole
     * body - a black rectangle with no clue which card broke. Every card now
     * renders inside its own boundary, so a failure is a small red box in that
     * card's place and everything else (retry button, log, switches) keeps
     * working.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: String((error && error.message) || error) }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined') console.error('[mobile-sync] card failed:', error, info)
      }

      componentDidUpdate(prev) {
        // A retry bumps `resetKey`; drop the captured error so the card renders
        // again instead of staying a red box forever.
        if (this.state.error !== null && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
      }

      render() {
        if (this.state.error !== null) {
          return h(
            'div',
            { className: 'msy-card msy-card-tight' },
            h('div', { className: 'msy-label' }, this.props.label ?? ''),
            h('div', { className: 'msy-err' }, this.state.error),
          )
        }
        return this.props.children ?? null
      }
    }

    /** Render every card, each inside its own boundary. */
    function guarded(cards, ctx) {
      return cards.map((card, index) =>
        h(Boundary, { key: index, label: card.key, resetKey: ctx.resetKey }, card.make(ctx)),
      )
    }

    /** Every panel card, in display order. */
    const CARDS = [
      // 连接先行：二维码/命令/网卡是每次使用的入口，放在最上面。
      { key: 'pairing', make: ctx => h(card$pairing, ctx) },
      { key: 'syncTitle', make: ctx => h(card$syncTitle, ctx) },
      { key: 'channels', make: ctx => h(card$channels, ctx) },
      // 会话通道的全部开关集中在一个卡片里（含目标模式、根目录、工作区勾选）。
      { key: 'workspaceTitle', make: ctx => h(card$workspaces, ctx) },
      { key: 'plugins', make: ctx => h(card$plugins, ctx) },
      { key: 'skills', make: ctx => h(card$skills, ctx) },
      { key: 'modelsGroups', make: ctx => h(card$modelsGroups, ctx) },
      { key: 'stats', make: ctx => h(card$stats, ctx) },
      { key: 'log', make: ctx => h(card$log, ctx) },
    ]

    /** Card `syncTitle`: rendered behind its own error boundary. */
    function card$syncTitle(ctx) {

      const {
        t, act, busy, status, error, load, copied, onCopy, onKey,
        channels, sync, plugins, skills, models, modelSections,
        peer, workspaces, desktopWorkspaces, phoneWorkspaces, phoneKnown,
        wsMap, resolveTarget, request, requestState, syncLine, syncButton,
        pluginRow, skillRow, modelRow, address, dotClass, stateText,
      } = ctx
      return (
        h(
          'div',
          { className: 'msy-card msy-sync' },
          h(
            'div',
            { className: 'msy-label-row' },
            h('span', { className: 'msy-label' }, t('syncTitle')),
            h('span', { className: requestState === 'done' ? 'msy-meta' : 'msy-empty' }, syncLine),
          ),
          h(
            'div',
            { className: 'msy-sync-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'msy-btn msy-btn-primary msy-btn-sync',
                disabled: syncButton.disabled === true || typeof syncButton.action !== 'string',
                onClick: () => syncButton.action !== null && act(syncButton.action),
              },
              syncButton.label,
            ),
            requestState === 'pending'
              ? h(
                  'button',
                  { type: 'button', className: 'msy-btn', disabled: busy, onClick: () => act('cancel-sync') },
                  t('syncCancel'),
                )
              : null,
          ),
          h('div', { className: 'msy-empty' }, t('syncIdle')),
          h('div', { className: 'msy-meta' }, t('syncNeedPair')),
        )
      )
    }

    /** Card `channels`: rendered behind its own error boundary. */
    function card$channels(ctx) {

      const { t, act, busy, peer } = ctx
      return (
        h(
          'div',
          { className: 'msy-card msy-card-tight' },
          h(
            'div',
            { className: 'msy-label-row' },
            h('span', { className: 'msy-label' }, t('channels')),
            h('span', { className: 'msy-meta' }, peer === null ? t('noPeer') : `${t('remote')} ${peer.device ?? ''}`),
          ),
          h(
            'div',
            { className: 'msy-row' },
            ...[
              ['sessions', t('chSessions')],
              ['models', t('chModels')],
              ['plugins', t('chPlugins')],
              ['skills', t('chSkills')],
            ].map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: ctx.channels[key] === true ? 'msy-chip msy-chip-on' : 'msy-chip',
                  'aria-pressed': ctx.channels[key] === true,
                  disabled: busy,
                  onClick: () => act('set-channel', { channel: key, on: ctx.channels[key] !== true }),
                },
                label,
              ),
            ),
          ),
          h('div', { className: 'msy-empty' }, t('channelHint')),
        )
      )
    }

    /**
     * Card `workspaces`: every switch about conversations, in one place.
     *
     * 目标工作区（同名/统一目录）、两个根目录、「含已归档」和每个工作区自己的
     * 「同步对话」勾选都在这里；「同步 API 密钥」跟着模型走（见模型卡片）。
     */
    function card$workspaces(ctx) {
      const { t, act, busy, sync, desktopWorkspaces, phoneWorkspaces, phoneKnown, wsMap, resolveTarget } = ctx
      const chosen = desktopWorkspaces.filter(item => item.selected === true).length
      const root = String(sync.phoneRoot ?? '').replace(/\/+$/u, '')
      return h(
        'div',
        { className: 'msy-card msy-pairing' },
        h(
          'div',
          { className: 'msy-label-row' },
          h('span', { className: 'msy-label' }, `${t('workspaceTitle')} · ${chosen}/${desktopWorkspaces.length} ${t('selectedCount')}`),
          h(
            'span',
            { className: 'msy-row' },
            h(
              'button',
              { type: 'button', className: 'msy-btn', disabled: busy || desktopWorkspaces.length === 0, onClick: () => act('set-all', { kind: 'workspaces', on: true }) },
              t('selectAll'),
            ),
            h(
              'button',
              { type: 'button', className: 'msy-btn', disabled: busy || chosen === 0, onClick: () => act('set-all', { kind: 'workspaces', on: false }) },
              t('selectNone'),
            ),
            Object.keys(wsMap).length > 0
              ? h(
                  'button',
                  { type: 'button', className: 'msy-btn', disabled: busy, onClick: () => act('reset-workspace-map') },
                  t('workspaceReset'),
                )
              : null,
          ),
        ),
        h('div', { className: 'msy-empty' }, t('workspaceHint')),
        ctx.workspaces?.indexError === true ? h('div', { className: 'msy-err' }, t('workspaceNoIndex')) : null,

        /* --------------------------------------------------- roots + extras */
        h(
          'div',
          { className: 'msy-row' },
          h(
            'label',
            { className: 'msy-field' },
            h('span', { className: 'msy-meta' }, t('phoneRoot')),
            h('input', {
              className: 'msy-input',
              defaultValue: sync.phoneRoot ?? '',
              spellCheck: false,
              onBlur: event => act('set-root', { which: 'phone', value: event?.target?.value ?? '' }),
            }),
          ),
          h(
            'label',
            { className: 'msy-field' },
            h('span', { className: 'msy-meta' }, t('desktopRoot')),
            h('input', {
              className: 'msy-input',
              defaultValue: sync.desktopRoot ?? '',
              spellCheck: false,
              onBlur: event => act('set-root', { which: 'desktop', value: event?.target?.value ?? '' }),
            }),
          ),
        ),
        h(
          'div',
          { className: 'msy-row' },
          h(
            'button',
            {
              type: 'button',
              className: sync.includeArchived ? 'msy-chip msy-chip-on' : 'msy-chip',
              'aria-pressed': sync.includeArchived === true,
              disabled: busy,
              onClick: () => act('set-archived', { on: sync.includeArchived !== true }),
            },
            t('archived'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'msy-btn',
              disabled: busy,
              title: t('forceHint'),
              onClick: () => act('force'),
            },
            t('force'),
          ),
        ),
        h('div', { className: 'msy-meta' }, t('modeHint')),

        /* ------------------------------------------------- desktop rows */
        desktopWorkspaces.length === 0
          ? h('div', { className: 'msy-empty' }, t('noneInCategory'))
          : h(
              'div',
              { className: 'msy-pairing' },
              ...desktopWorkspaces.map(workspace => {
                const target = resolveTarget(workspace)
                return h(
                  'div',
                  { key: workspace.id, className: 'msy-pair' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: workspace.selected === true ? 'msy-check msy-check-on' : 'msy-check',
                      role: 'checkbox',
                      'aria-checked': workspace.selected === true,
                      'aria-label': `${workspace.title} 同步对话`,
                      title: t('workspaceSyncHint'),
                      disabled: busy,
                      onClick: () => act('set-workspace', { id: workspace.id, on: workspace.selected !== true }),
                    },
                    workspace.selected === true ? '✓' : '·',
                  ),
                  h('span', { className: 'msy-pair-name', title: workspace.path }, workspace.title),
                  h(
                    'span',
                    { className: 'msy-meta' },
                    `${workspace.sessions} ${t('workspaceSessions')}` +
                      (workspace.archived > 0 ? ` · ${workspace.archived} ${t('workspaceArchived')}` : ''),
                  ),
                  h('span', { className: 'msy-pair-arrow' }, '→'),
                  h(
                    'select',
                    {
                      className: 'msy-select',
                      value: typeof wsMap[workspace.id] === 'string' ? wsMap[workspace.id] : '',
                      disabled: busy || !phoneKnown || workspace.selected !== true,
                      title: target?.path ?? `${root}/${workspace.title}`,
                      onChange: event => act('set-workspace-map', {
                        desktop: workspace.id,
                        phone: event?.target?.value ?? '',
                      }),
                    },
                    h('option', { value: '' }, t('workspaceTarget')),
                    ...phoneWorkspaces.map(item =>
                      h('option', { key: item.id, value: item.id }, `${item.title}（${item.sessions}）`),
                    ),
                  ),
                )
              }),
            ),
        h(
          'div',
          { className: 'msy-label-row' },
          h('span', { className: 'msy-label' }, `${t('workspacePhone')} · ${phoneWorkspaces.length}`),
        ),
        h('div', { className: 'msy-empty' }, t('workspacePhoneHint')),
        phoneKnown
          ? phoneWorkspaces.length === 0
            ? h('div', { className: 'msy-empty' }, t('noneInCategory'))
            : h(
                'div',
                { className: 'msy-pairing' },
                ...phoneWorkspaces.map(item => {
                  const home = desktopWorkspaces.find(workspace => workspace.id === wsMap[`phone:${item.id}`])
                  return h(
                    'div',
                    { key: item.id, className: 'msy-pair' },
                    h('span', { className: 'msy-pair-name', title: item.path }, item.title),
                    h('span', { className: 'msy-meta' }, `${item.sessions} ${t('workspaceSessions')}`),
                    h('span', { className: 'msy-pair-arrow' }, '←'),
                    // Where this phone project's conversations land when they
                    // come back: a desktop workspace the user picks here.
                    h(
                      'select',
                      {
                        className: 'msy-select',
                        value: typeof wsMap[`phone:${item.id}`] === 'string' ? wsMap[`phone:${item.id}`] : '',
                        disabled: busy || desktopWorkspaces.length === 0,
                        title: home === undefined ? `${root}/${item.title}` : home.path,
                        'aria-label': `${item.title} → 电脑工作区`,
                        onChange: event => act('set-phone-workspace-map', {
                          phone: item.id,
                          desktop: event?.target?.value ?? '',
                        }),
                      },
                      h('option', { value: '' }, t('workspacePhoneTarget')),
                      ...desktopWorkspaces.map(workspace =>
                        h('option', { key: workspace.id, value: workspace.id }, workspace.title),
                      ),
                    ),
                    (item.incoming ?? []).length > 0
                      ? h(
                          'span',
                          { className: 'msy-tag msy-tag-send', title: item.incoming.join('、') },
                          `← ${item.incoming.join('、')}`,
                        )
                      : null,
                  )
                }),
              )
          : h('div', { className: 'msy-empty' }, t('workspaceNone')),
      )
    }

    /** Card `plugins`: rendered behind its own error boundary. */
    function card$plugins(ctx) {

      const {
        t, act, busy, status, error, load, copied, onCopy, onKey,
        channels, sync, plugins, skills, models, modelSections,
        peer, workspaces, desktopWorkspaces, phoneWorkspaces, phoneKnown,
        wsMap, resolveTarget, request, requestState, syncLine, syncButton,
        pluginRow, skillRow, modelRow, address, dotClass, stateText,
      } = ctx
      return (
        h(SwitchList, {
          t,
          title: t('plugins'),
          hint: t('pluginsHint'),
          busy,
          items: plugins,
          onAll: on => act('set-all', { kind: 'plugins', on }),
          onToggle: (name, on) => act('set-plugin', { name, on }),
          render: pluginRow,
        })
      )
    }

    /** Card `skills`: rendered behind its own error boundary. */
    function card$skills(ctx) {

      const {
        t, act, busy, status, error, load, copied, onCopy, onKey,
        channels, sync, plugins, skills, models, modelSections,
        peer, workspaces, desktopWorkspaces, phoneWorkspaces, phoneKnown,
        wsMap, resolveTarget, request, requestState, syncLine, syncButton,
        pluginRow, skillRow, modelRow, address, dotClass, stateText,
      } = ctx
      return (
        h(SwitchList, {
          t,
          title: t('skills'),
          hint: t('skillsHint'),
          busy,
          items: skills,
          onAll: on => act('set-all', { kind: 'skills', on }),
          onToggle: (name, on) => act('set-skill', { name, on }),
          render: skillRow,
        })
      )
    }

    /** Card `modelsGroups`: rendered behind its own error boundary. */
    function card$modelsGroups(ctx) {

      const {
        t, act, busy, status, error, load, copied, onCopy, onKey,
        channels, sync, plugins, skills, models, modelSections,
        peer, workspaces, desktopWorkspaces, phoneWorkspaces, phoneKnown,
        wsMap, resolveTarget, request, requestState, syncLine, syncButton,
        pluginRow, skillRow, modelRow, address, dotClass, stateText,
      } = ctx
      return (
        h(
          'div',
          { className: 'msy-card' },
          h(
            'div',
            { className: 'msy-label-row' },
            h(
              'span',
              { className: 'msy-label' },
              `${t('modelsGroups')} · ${models.filter(m => m.selected === true).length}/${models.length} ${t('selectedCount')}`,
            ),
            h(
              'span',
              { className: 'msy-row' },
              h('button', { type: 'button', className: 'msy-btn', disabled: busy || models.length === 0, onClick: () => act('set-all', { kind: 'models', on: true }) }, t('selectAll')),
              h('button', { type: 'button', className: 'msy-btn', disabled: busy || models.length === 0, onClick: () => act('set-all', { kind: 'models', on: false }) }, t('selectNone')),
              h('button', { type: 'button', className: 'msy-btn', disabled: busy || models.length === 0, onClick: () => act('set-keys-all', { on: true }) }, t('modelsKeysAll')),
              h('button', { type: 'button', className: 'msy-btn', disabled: busy || models.length === 0, onClick: () => act('set-keys-all', { on: false }) }, t('modelsKeysNone')),
            ),
          ),
          h('div', { className: 'msy-empty' }, models.length === 0 ? t('modelsEmpty') : t('modelsGroupHint')),
          // 「同步 API 密钥」总开关跟着模型走：密钥属于模型组，不属于会话通道。
          h(
            'div',
            { className: 'msy-row' },
            h(
              'button',
              {
                type: 'button',
                className: sync.secrets ? 'msy-chip msy-chip-on' : 'msy-chip',
                'aria-pressed': sync.secrets === true,
                disabled: busy,
                title: t('secretsWarn'),
                onClick: () => act('set-secrets', { on: sync.secrets !== true }),
              },
              t('secrets'),
            ),
            models.length === 0 ? null : h('span', { className: 'msy-meta' }, t('modelsKeysHint')),
          ),
          sync.secrets === false && models.length > 0 ? h('div', { className: 'msy-err' }, t('secretsOff')) : null,
          models.length === 0
            ? null
            : h(
                'div',
                null,
                ...modelSections.map(section =>
                  h(
                    'div',
                    { key: section.rowId, className: 'msy-group' },
                    h(
                      'div',
                      { className: 'msy-group-title' },
                      h('span', null, section.rowId),
                      h(
                        'span',
                        { className: 'msy-tag' },
                        `${section.items.length} ${t('models')}`,
                      ),
                      section.source === 'plugin'
                        ? h('span', { className: 'msy-tag' }, `${t('modelsPlugin')} ${section.plugin ?? ''}`)
                        : null,
                    ),
                    h(
                      'ul',
                      { className: 'msy-list' },
                      ...section.items.map((model, index) =>
                        modelRow(
                          model,
                          index,
                          (name, on) => act('set-model', { name, on }),
                          busy,
                          t,
                          onKey,
                          picked(sync.modelKeys, model.key, true),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          h('div', { className: 'msy-meta' }, t('secretsWarn')),
        )
      )
    }

    /** Card `pairing`: rendered behind its own error boundary. */
    function card$pairing(ctx) {

      const {
        t, act, busy, status, error, load, copied, onCopy, onKey,
        channels, sync, plugins, skills, models, modelSections,
        peer, workspaces, desktopWorkspaces, phoneWorkspaces, phoneKnown,
        wsMap, resolveTarget, request, requestState, syncLine, syncButton,
        pluginRow, skillRow, modelRow, address, dotClass, stateText,
      } = ctx
      // The pairing card owns three stacked panels; they are one card so the
      // pairing command and its QR never get separated by a failed boundary.
      return [
        address === undefined
          ? h('div', { className: 'msy-card msy-card-tight' }, h('div', { className: 'msy-empty' }, t('noAddress')))
          : h(
              'div',
              { className: 'msy-card' },
              h('div', { className: 'msy-label' }, t('scan')),
              h('div', { className: 'msy-qr', dangerouslySetInnerHTML: { __html: status.qr } }),
              h('div', { className: 'msy-empty' }, t('scanHint')),
            ),

        h(
          'div',
          { className: 'msy-card' },
          h('div', { className: 'msy-label' }, t('paste')),
          h('pre', { className: 'msy-code' }, status?.command ?? ''),
          h(
            'div',
            { className: 'msy-row' },
            h(
              'button',
              { className: 'msy-btn msy-btn-primary', onClick: onCopy, disabled: !status?.command },
              copied === 'ok' ? t('copied') : copied === 'fail' ? t('copyFailed') : t('copy'),
            ),
          ),
          h('div', { className: 'msy-empty' }, t('installHint')),
        ),

        status?.addresses?.length > 1
          ? h(
              'div',
              { className: 'msy-card msy-card-tight' },
              h('div', { className: 'msy-label' }, t('adapters')),
              h(
                'div',
                { className: 'msy-row' },
                ...status.addresses.map(item =>
                  h(
                    'button',
                    {
                      key: item.address,
                      className: item.address === status.preferred || (status.preferred === null && item.address === status.addresses[0].address)
                        ? 'msy-chip msy-chip-on'
                        : 'msy-chip',
                      onClick: () => act('set-address', { address: item.address }),
                      title: item.name,
                    },
                    item.address,
                  ),
                ),
              ),
              h('div', { className: 'msy-empty' }, t('adapterHint')),
            )
          : null,
      ]
    }

    /** Card `stats`: rendered behind its own error boundary. */
    function card$stats(ctx) {

      const {
        t, act, busy, status, error, load, copied, onCopy, onKey,
        channels, sync, plugins, skills, models, modelSections,
        peer, workspaces, desktopWorkspaces, phoneWorkspaces, phoneKnown,
        wsMap, resolveTarget, request, requestState, syncLine, syncButton,
        pluginRow, skillRow, modelRow, address, dotClass, stateText,
      } = ctx
      return (
        h(
          'div',
          { className: 'msy-card msy-card-tight' },
          h(
            'div',
            { className: 'msy-stats' },
            h('div', { className: 'msy-stat' }, h('span', { className: 'msy-stat-n' }, status?.total ?? '—'), h('span', { className: 'msy-stat-k' }, t('stats'))),
            h('div', { className: 'msy-stat' }, h('span', { className: 'msy-stat-n' }, status?.fromPhone ?? '—'), h('span', { className: 'msy-stat-k' }, t('fromPhone'))),
            h('div', { className: 'msy-stat' }, h('span', { className: 'msy-stat-n' }, plugins.filter(item => item.selected === true).length), h('span', { className: 'msy-stat-k' }, t('plugins'))),
            h('div', { className: 'msy-stat' }, h('span', { className: 'msy-stat-n' }, skills.filter(item => item.selected === true).length), h('span', { className: 'msy-stat-k' }, t('skills'))),
          ),
          h(
            'div',
            { className: 'msy-row' },
            h('button', { className: 'msy-btn', onClick: () => act('rescan'), disabled: busy }, t('refresh')),
            h('button', { className: 'msy-btn', disabled: busy, onClick: () => act('restart') }, t('restart')),
            h(
              'button',
              {
                className: 'msy-btn',
                disabled: busy,
                onClick: () => {
                  if (typeof window.confirm === 'function' && !window.confirm(t('resetConfirm'))) return
                  act('reset-token')
                },
              },
              t('resetToken'),
            ),
            status?.localUrl
              ? h('a', { className: 'msy-btn', href: status.localUrl, target: '_blank', rel: 'noreferrer' }, t('openPage'))
              : null,
          ),
          status?.counts
            ? h(
                'div',
                { className: 'msy-meta' },
                `${t('countsLabel')} ${status.counts.sessions} · ${t('countsIndexed')} ${status.counts.indexed} · ` +
                  `${t('countsUnindexed')} ${status.counts.unindexed}`,
              )
            : null,
          status?.sessionsRoot ? h('div', { className: 'msy-path' }, `${t('sessionsRoot')}: ${status.sessionsRoot}`) : null,
          status?.paths?.skills ? h('div', { className: 'msy-path' }, `skills: ${status.paths.skills}`) : null,
          status?.paths?.profile ? h('div', { className: 'msy-path' }, `profile: ${status.paths.profile}`) : null,
        )
      )
    }

    /** Card `log`: rendered behind its own error boundary. */
    function card$log(ctx) {

      const {
        t, act, busy, status, error, load, copied, onCopy, onKey,
        channels, sync, plugins, skills, models, modelSections,
        peer, workspaces, desktopWorkspaces, phoneWorkspaces, phoneKnown,
        wsMap, resolveTarget, request, requestState, syncLine, syncButton,
        pluginRow, skillRow, modelRow, address, dotClass, stateText,
      } = ctx
      return (
        h(
          'div',
          { className: 'msy-card msy-card-tight' },
          h('div', { className: 'msy-label' }, t('log')),
          status?.log?.length > 0
            ? h(
                'ul',
                { className: 'msy-log' },
                ...status.log.slice(0, 14).map((row, index) =>
                  h(
                    'li',
                    { key: `${row.at}-${index}` },
                    h('span', { className: 'msy-log-time' }, clock(row.at)),
                    h('span', { className: 'msy-log-text' }, row.text),
                  ),
                ),
              )
            : h('div', { className: 'msy-empty' }, t('noLog')),
        )
      )
    }

    return module.exports
  },
})
