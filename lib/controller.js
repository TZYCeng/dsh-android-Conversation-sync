/**
 * The LAN side of the plugin: a small authenticated HTTP listener the phone can
 * reach, plus the state and the panel API that drive it.
 *
 * It is deliberately *not* the DSH web server. That one refuses unspecified bind
 * addresses and carries no server-wide authentication, so widening it to the LAN
 * would expose the whole GUI. This listener instead speaks one narrow protocol —
 * a ping, a manifest, a pull (tar.gz) and a push (tar.gz) — and every route
 * requires the pairing token that the QR code carries.
 *
 * The desktop does all of the record work: the phone only moves bytes.
 *
 * @module lib/controller
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { qrSvg } from './qr.js'
import { scan } from './sessions.js'
import { pack, unpack } from './tar.js'
import { phoneScript } from './phone.js'
import {
  CHANNELS,
  clearWorkspaceMap,
  defaultSync,
  desktopForPhone,
  isOn,
  joinDesktopRoot,
  normalizeSync,
  selected,
  setPhoneWorkspaceMap,
  setSelected,
  setSelectedAll,
  setWorkspaceMap,
} from './channels.js'
import {
  ingestPush,
  loadPeerFiles,
  planPull,
  savePeerFiles,
} from './transfer.js'
import { atLeast, isNewer } from './version.js'
import { isScratchWorkspace, normalizeIndex, readIndex, safeName } from './index-sync.js'
import { baseName } from './slug.js'
import { listPlugins } from './plugins.js'
import { listSkills } from './skills.js'
import { credentialRefs, listModels } from './models.js'

/** Default TCP port; a handful of neighbours are tried when it is taken. */
const DEFAULT_PORT = 8733
/** How many ports above the default to try before giving up. */
const PORT_SPAN = 8
/** Hard cap on one uploaded bundle. */
const MAX_UPLOAD = 256 * 1024 * 1024
/** How many log rows the panel keeps. */
const LOG_LIMIT = 80
/** How long a filesystem catalog is reused before it is rebuilt. */
const CATALOG_TTL = 10_000
/** How long a manual sync request stays valid before it expires. */
const REQUEST_TTL = 5 * 60 * 1000

/* ------------------------------------------------------------------ state */

/** Directories this plugin owns below `$DSH_HOME`. */
export function stateDir(home) {
  return path.join(home, 'dsh-mobile-sync')
}

/** Where the phone's uploaded inputs are cached between a push and a pull. */
export function peerDir(home) {
  return path.join(stateDir(home), 'peer')
}

/**
 * The profile the desktop itself runs: the one whose `package.json` composes
 * bundles.
 *
 * A machine with several profiles gets the one named by `DSH_PROFILE`, else the
 * first that actually composes bundles — the same rule the phone script uses, so
 * both ends agree about which directory the plugin list describes.
 *
 * @param home - `$DSH_HOME`.
 * @returns an absolute profile directory, or null.
 */
export function activeProfile(home) {
  const root = path.join(home, 'profiles')
  const preferred = process.env.DSH_PROFILE
  if (typeof preferred === 'string' && preferred.length > 0) {
    const dir = path.join(root, preferred)
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  let names
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name)
  } catch (_error) {
    return null
  }
  const composed = []
  for (const name of names.sort()) {
    const file = path.join(root, name, 'package.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(parsed?.dsh?.profile?.bundles)) composed.push({ name, file })
    } catch (_error) {
      // A profile without a readable package.json cannot be composed.
    }
  }
  if (composed.length === 0) return null
  const desktop = composed.find(item => item.name === 'desktop')
  return path.dirname((desktop ?? composed[0]).file)
}

/** Read the persisted state, or a fresh one when the file is missing or broken. */
function loadState(home) {
  const empty = () => ({
    token: '',
    port: DEFAULT_PORT,
    preferred: null,
    log: [],
    imported: {},
    sync: defaultSync(),
    peer: null,
    // A manual sync request: the panel's button writes it, the phone's wait loop
    // takes it, and the phone reports back when it is done.
    request: null,
    sent: { plugins: {}, skills: {}, patch: null, credentials: null },
  })
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir(home), 'state.json'), 'utf8'))
    const fresh = empty()
    return {
      token: typeof parsed.token === 'string' ? parsed.token : fresh.token,
      port: Number.isInteger(parsed.port) ? parsed.port : fresh.port,
      preferred: typeof parsed.preferred === 'string' ? parsed.preferred : null,
      log: Array.isArray(parsed.log) ? parsed.log : [],
      imported: parsed.imported !== null && typeof parsed.imported === 'object' ? parsed.imported : {},
      sync: normalizeSync(parsed.sync, undefined, home),
      peer: parsed.peer !== null && typeof parsed.peer === 'object' ? parsed.peer : null,
      request: parsed.request !== null && typeof parsed.request === 'object' ? parsed.request : null,
      sent: {
        plugins: parsed.sent?.plugins ?? {},
        skills: parsed.sent?.skills ?? {},
        patch: parsed.sent?.patch ?? null,
        credentials: parsed.sent?.credentials ?? null,
      },
    }
  } catch (_error) {
    return empty()
  }
}

/** Persist state atomically. */
function saveState(home, state) {
  const dir = stateDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'state.json')
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temp, file)
}

/** A fresh pairing token: 128 bits, URL-safe. */
function newToken() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * Every address the phone could plausibly use, best first.
 *
 * A phone on the same Wi-Fi reaches the desktop through a private IPv4 address;
 * link-local and CGNAT ranges are filtered out because they are never the right
 * answer here, and the address is tried in the order a home router hands out.
 */
export function lanAddresses() {
  const found = []
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      found.push({ name, address: address.address })
    }
  }
  const rank = (item) => {
    let score = 0
    // Adapters a phone can never reach: VPN tunnels, hypervisor switches, and
    // the virtual NICs container runtimes install. They stay listed, just last.
    if (/(vEthernet|VMware|VirtualBox|Hyper-V|WSL|Docker|Loopback|Bluetooth)/i.test(item.name)) score += 100
    if (item.address.startsWith('192.168.')) return score + 0
    if (item.address.startsWith('10.')) return score + 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(item.address)) return score + 2
    return score + 3
  }
  found.sort((left, right) => rank(left) - rank(right))
  return found
}

/* ------------------------------------------------------------------- html */

/** Escape a value for HTML text and attribute contexts. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Human byte size. */
function sizeText(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Human time. */
function timeText(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Styling shared by the two pages this listener serves. */
const PAGE_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:28px 18px 60px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1b1d21}
main{max-width:760px;margin:0 auto}
h1{margin:0 0 4px;font-size:20px;font-weight:600}
h2{margin:28px 0 10px;font-size:14px;font-weight:600;color:#5b6470}
p{margin:6px 0}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:18px;margin-top:14px}
.row{display:flex;gap:14px;align-items:flex-start}
.qr{flex:none;background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:8px;line-height:0}
.grow{flex:1;min-width:0}
.muted{color:#6b7280;font-size:12.5px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{margin:8px 0 0;padding:12px 14px;background:#0f1115;color:#e6e8eb;border-radius:10px;overflow:auto;font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-all}
button{font:inherit;cursor:pointer;border:1px solid #d5d9de;background:#fff;border-radius:9px;padding:6px 12px;color:#1b1d21}
button:hover{background:#f1f3f5}
button.primary{background:#1b1d21;border-color:#1b1d21;color:#fff}
button.primary:hover{background:#33373d}
input{font:inherit;padding:8px 10px;border:1px solid #d5d9de;border-radius:9px;width:100%}
ul{list-style:none;margin:0;padding:0}
li{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid #f0f2f4;font-size:13px}
li:last-child{border-bottom:0}
.tag{flex:none;font-size:11px;padding:1px 7px;border-radius:999px;background:#eef1f4;color:#5b6470}
.ok{color:#0a7d4f}.warn{color:#a16207}.err{color:#b42318}
@media (prefers-color-scheme:dark){
body{background:#141618;color:#e6e8eb}
h2{color:#9aa3ae}
.card{background:#1c1f22;border-color:#2b3035}
.qr{background:#fff;border-color:#2b3035}
.muted{color:#9aa3ae}
button{background:#22262a;border-color:#343a40;color:#e6e8eb}
button:hover{background:#2a2f34}
button.primary{background:#e6e8eb;border-color:#e6e8eb;color:#141618}
button.primary:hover{background:#fff}
input{background:#141618;border-color:#343a40;color:#e6e8eb}
li{border-color:#22262a}
.tag{background:#22262a;color:#9aa3ae}
}
`

/**
 * Render the control page.
 * @param model - precomputed values for the page.
 * @returns a complete HTML document.
 */
function controlPage(model) {
  const { token, command, qr, urls, sessions, imported, log, error, channels, plugins, skills, models, request } = model
  const rows = sessions
    .slice(0, 30)
    .map((entry) => {
      const fromPhone = imported[entry.id] !== undefined
      const title = entry.title ?? entry.cwd ?? entry.id
      return (
        `<li><span class="tag">${escapeHtml(fromPhone ? '手机' : '本机')}</span>` +
        `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(title)}</span>` +
        `<span class="muted">${escapeHtml(sizeText(entry.bytes))} · ${escapeHtml(timeText(entry.mtime))}</span></li>`
      )
    })
    .join('')
  const logRows = log
    .slice(0, 12)
    .map((row) => `<li><span class="muted">${escapeHtml(timeText(row.at))}</span><span style="flex:1">${escapeHtml(row.text)}</span></li>`)
    .join('')
  const channelRows = CHANNELS.map(
    channel => `<li><span class="tag">${channels[channel] ? '开' : '关'}</span><span>${escapeHtml(channel)}</span></li>`,
  ).join('')
  const ws = model.workspaces
  const workspaceRows = (ws?.desktop ?? [])
    .map((workspace) => {
      const paired = ws.phone.find(item => item.id === workspace.mapped)
      return (
        `<li><span class="tag">${workspace.selected ? '同步' : '—'}</span>` +
        `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(workspace.title)}</span>` +
        `<span class="muted">${workspace.sessions} 会话` +
        `${workspace.archived > 0 ? ` · ${workspace.archived} 归档` : ''} → ` +
        `${escapeHtml(paired === undefined ? workspace.target : paired.title)}</span></li>`
      )
    })
    .join('')
  const pluginRows = plugins
    .map(
      plugin =>
        `<li><span class="tag">${plugin.selected ? '选' : '—'}</span><span style="flex:1">${escapeHtml(plugin.name)}</span>` +
        `<span class="muted">${escapeHtml(plugin.version ?? '?')} · ${escapeHtml(sizeText(plugin.bytes))}` +
        `${plugin.warning ? ` · ${escapeHtml(plugin.warning)}` : ''}</span></li>`,
    )
    .join('')
  const skillRows = skills
    .map(
      skill =>
        `<li><span class="tag">${skill.selected ? '选' : '—'}</span><span style="flex:1">${escapeHtml(skill.name)}</span>` +
        `<span class="muted">${escapeHtml(skill.source)} · ${escapeHtml(sizeText(skill.bytes))}</span></li>`,
    )
    .join('')
  const modelRows = (Array.isArray(models) ? models : [])
    .map(
      group =>
        `<li><span class="tag">${group.selected ? '选' : '—'}</span><span style="flex:1">${escapeHtml(group.label ?? group.key)}` +
        `${group.source === 'plugin' ? `<span class="muted"> · 插件 ${escapeHtml(group.plugin ?? '')}</span>` : ''}</span>` +
        `<span class="muted">${escapeHtml(String((group.models ?? []).length))} 模型` +
        `${group.baseURL ? ` · ${escapeHtml(group.baseURL)}` : ''}</span></li>`,
    )
    .join('')
  const requestText = request === null || request === undefined
    ? '还没有点过「开始同步」'
    : request.status === 'done'
      ? `手机已完成本次同步（${timeText(request.doneAt)}）`
      : request.status === 'taken'
        ? '手机已取走同步指令，正在同步…'
        : request.status === 'pending'
          ? '已请求同步，等待手机取走指令'
          : '上一次同步请求已过期'

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 会话同步 · ${escapeHtml(os.hostname())}</title>
<style>${PAGE_CSS}</style>
</head><body><main>
<h1>DSH 同步</h1>
<p class="muted">${escapeHtml(os.hostname())} · ${sessions.length} 个会话 · 端口已就绪</p>
${error !== null && error !== undefined ? `<div class="card"><p class="err">${escapeHtml(error)}</p></div>` : ''}
<div class="card">
  <div class="row">
    <div class="qr">${qr}</div>
    <div class="grow">
      <h2 style="margin-top:0">1 · 手机扫这个码</h2>
      <p class="muted">用手机相机或任意扫码工具扫描，会打开本页的手机版说明。</p>
      <h2>2 · 在 DeepCode 里粘贴这一条</h2>
      <pre id="cmd">${escapeHtml(command)}</pre>
      <p style="margin-top:10px"><button class="primary" onclick="copyCmd(this)">复制命令</button></p>
      <p class="muted">在手机 DeepCode 的聊天框（或内置终端）里粘贴并回车即可。第一次跑完可以用 <code>install</code> 参数把脚本留在手机上。</p>
    </div>
  </div>
</div>
<div class="card">
  <h2 style="margin-top:0">桌面地址</h2>
  <ul>${urls.map((item) => `<li><span class="tag">LAN</span><code>${escapeHtml(item)}</code></li>`).join('')}</ul>
  <p class="muted">配对令牌：<code>${escapeHtml(token)}</code>（换一个请在桌面插件面板里重置）</p>
</div>
<div class="card">
  <h2 style="margin-top:0">同步工作区（${ws?.desktop?.length ?? 0} 个电脑工作区 · 已勾选 ${ws?.on ?? 0} 个）</h2>
  <ul>${workspaceRows || '<li class="muted">电脑上没有工作区</li>'}</ul>
  <p class="muted">逐个工作区勾选「同步对话」；勾上的才会双向传。目标目录默认是手机上的同名文件夹，要改投到别的手机工作区，请在桌面侧栏的「手机同步」面板里选。</p>
</div>
<div class="card">
  <h2 style="margin-top:0">同步通道</h2>
  <ul>${channelRows}</ul>
  <p class="muted">开关在桌面侧栏的「手机同步」面板里调整，手机上不可改。</p>
</div>
<div class="card">
  <h2 style="margin-top:0">开始同步</h2>
  <p>${escapeHtml(requestText)}</p>
  <p class="muted">手机执行上面的命令后只会配对并等待，不会自动同步；在桌面面板点「开始同步」，手机才开始上传和下载。</p>
</div>
<div class="card">
  <h2 style="margin-top:0">插件 · 只从电脑到手机（${plugins.filter(item => item.selected).length}/${plugins.length} 已选）</h2>
  <ul>${pluginRows || '<li class="muted">电脑上没有可同步的插件</li>'}</ul>
</div>
<div class="card">
  <h2 style="margin-top:0">技能 · 只从电脑到手机（${skills.filter(item => item.selected).length}/${skills.length} 已选）</h2>
  <ul>${skillRows || '<li class="muted">电脑上没有可同步的技能</li>'}</ul>
</div>
<div class="card">
  <h2 style="margin-top:0">模型组 · 只从电脑到手机（${(Array.isArray(models) ? models : []).filter(item => item.selected).length}/${(Array.isArray(models) ? models : []).length} 已选）</h2>
  <ul>${modelRows || '<li class="muted">电脑上没有可同步的模型组</li>'}</ul>
</div>
<div class="card">
  <h2 style="margin-top:0">会话（最近 ${Math.min(sessions.length, 30)} 条）</h2>
  <ul>${rows || '<li class="muted">还没有任何会话记录</li>'}</ul>
</div>
<div class="card">
  <h2 style="margin-top:0">最近同步</h2>
  <ul>${logRows || '<li class="muted">还没有同步过</li>'}</ul>
</div>
</main>
<script>
function copyCmd(button){
  var text=document.getElementById('cmd').textContent;
  var done=function(){button.textContent='已复制';setTimeout(function(){button.textContent='复制命令'},1500)};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,fallback)}else{fallback()}
  function fallback(){
    var area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();
    try{document.execCommand('copy');done()}catch(e){}
    document.body.removeChild(area);
  }
}
</script>
</body></html>`
}

/** Render the page shown when the request carries no usable token. */
function gatePage(message) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 会话同步</title><style>${PAGE_CSS}</style></head>
<body><main>
<h1>DSH 同步</h1>
<p class="muted">这个地址需要配对令牌。请扫描桌面插件面板里的二维码，或粘贴配对链接。</p>
${message ? `<div class="card"><p class="err">${escapeHtml(message)}</p></div>` : ''}
<div class="card">
  <h2 style="margin-top:0">粘贴配对码或完整链接</h2>
  <form method="get" action="/j">
    <input name="t" placeholder="令牌，或 http://…/j?t=… 整条链接" autocomplete="off" autocapitalize="off">
    <p style="margin-top:10px"><button class="primary" type="submit">进入</button></p>
  </form>
</div>
</main></body></html>`
}

/* -------------------------------------------------------------- controller */

/**
 * Own the state file, the LAN listener, and the record stores.
 *
 * @param options - `{ home, sessionsRoot, deviceName, logger, profileDir }`.
 */
export function createController(options) {
  const home = options.home
  const sessionsRoot = options.sessionsRoot
  const logger = options.logger ?? console
  const deviceName = options.deviceName ?? os.hostname()
  const indexFile = path.join(home, 'storages', 'workspace.json')
  const profileDir = options.profileDir ?? activeProfile(home)
  const patchFile = profileDir === null ? null : path.join(profileDir, 'cordis.patch.yml')
  const credentialsFile = path.join(home, '.credentials.yaml')
  const skillsRoot = path.join(home, 'skills')
  const agentsRoot = process.env.DSH_AGENTS_HOME ?? path.join(os.homedir(), '.agents')

  let state = loadState(home)
  const readOnly = options.readOnly === true
  if (!/^[a-f0-9]{32}$/.test(state.token)) {
    state.token = newToken()
    if (!readOnly) saveState(home, state)
  } else if (!readOnly) {
    // Persist the normalised shape once per start. This stamps `defaultsRev` so
    // the one-time "everything off / archived home" migration cannot re-run, and
    // materialises the fields this build added (`workspaceMap`, `request`).
    try {
      saveState(home, state)
    } catch (_error) {
      // A read-only home still works; only persistence is lost.
    }
  }

  /** What the listener is doing right now. */
  let live = { running: false, port: 0, error: null }
  /** The live `http.Server`, when started. */
  let server = null
  /** Cached filesystem catalog: walking plugin and skill trees is not free. */
  let catalogCache = { at: 0, plugins: [], skills: [], models: [], errors: [] }

  /** Record one line in the shared log, newest first. */
  function note(text) {
    noteMany([text])
  }

  /** Record several lines with one write. */
  function noteMany(lines) {
    for (const text of lines) {
      state.log.unshift({ at: Date.now(), text })
    }
    if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT
    try {
      saveState(home, state)
    } catch (_error) {
      // A log line is never worth failing a request over.
    }
  }

  /** Every URL the phone may use, in preference order. */
  function urls() {
    const port = live.port || state.port
    const addresses = lanAddresses()
    // A machine with several adapters (Wi-Fi, Ethernet, a VPN) needs a way to say
    // which one the phone actually shares a network with.
    if (state.preferred !== null) {
      const index = addresses.findIndex((item) => item.address === state.preferred)
      if (index > 0) addresses.unshift(addresses.splice(index, 1)[0])
    }
    return addresses.map((item) => `http://${item.address}:${port}`)
  }

  /** The pairing URL encoded into the QR code. */
  function pairUrl() {
    const first = urls()[0]
    if (first === undefined) return ''
    return `${first}/j?t=${state.token}`
  }

  /** The exact one-liner shown on both surfaces. */
  function command() {
    const first = urls()[0]
    if (first === undefined) return ''
    // `pair` installs the script and then *waits*: downloading it must not start
    // a sync. The panel's「开始同步」button is what releases the phone.
    return `curl -fsSL '${first}/join.sh?t=${state.token}' | sh -s pair`
  }

  /* ---------------------------------------------------- manual sync requests */

  /** The request the panel has armed, or null when there is nothing to take. */
  function pendingRequest() {
    const request = state.request
    if (request === null || typeof request !== 'object') return null
    if (request.status !== 'pending') return null
    if (typeof request.at !== 'number' || Date.now() - request.at > REQUEST_TTL) return null
    return request
  }

  /** What the panel shows about the manual sync request. */
  function requestStatus() {
    const request = state.request
    if (request === null || typeof request !== 'object') return null
    const expired = request.status === 'pending' &&
      typeof request.at === 'number' && Date.now() - request.at > REQUEST_TTL
    return {
      id: typeof request.id === 'string' ? request.id : null,
      at: typeof request.at === 'number' ? request.at : null,
      status: expired ? 'expired' : String(request.status ?? 'pending'),
      doneAt: typeof request.doneAt === 'number' ? request.doneAt : null,
    }
  }

  /** Arm a new one-shot sync request (the panel's「开始同步」button). */
  function requestSync() {
    state.request = {
      id: crypto.randomBytes(4).toString('hex'),
      at: Date.now(),
      status: 'pending',
      doneAt: null,
    }
    saveState(home, state)
    note('已请求同步：等手机取走指令（手机需在等待模式）')
    return state.request
  }

  /** Drop a request that nobody took yet. */
  function cancelSync() {
    if (state.request !== null && state.request?.status === 'pending') {
      state.request = null
      saveState(home, state)
      note('已取消本次同步请求')
      return true
    }
    return false
  }

  /** Mark the request the phone just finished. */
  function finishSync(id) {
    const request = state.request
    if (request === null || typeof request !== 'object') return false
    if (typeof id === 'string' && id !== '' && request.id !== id) return false
    if (request.status !== 'pending' && request.status !== 'taken') return false
    request.status = 'done'
    request.doneAt = Date.now()
    saveState(home, state)
    note('手机已报告本次同步完成')
    return true
  }

  /** Wait for a fraction of a second, so the phone's long poll does not spin. */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /** Answer `GET /api/await`: hold the phone until a request is armed. */
  async function handleAwait(response, url) {
    const wanted = Number.parseInt(url.searchParams.get('timeout') ?? '25', 10)
    const timeout = Number.isFinite(wanted) ? Math.min(30, Math.max(1, wanted)) : 25
    const deadline = Date.now() + timeout * 1000
    while (Date.now() < deadline) {
      const request = pendingRequest()
      if (request !== null) {
        // Taken: only one phone may serve a request, and a taken one is no
        // longer offered to the next poll.
        request.status = 'taken'
        request.takenAt = Date.now()
        saveState(home, state)
        note(`手机取走同步指令（${request.id}）`)
        sendText(response, 200, `request=${request.id}\nstatus=taken\n`)
        return
      }
      await sleep(500)
    }
    sendText(response, 200, 'request=0\nstatus=idle\n')
  }

  /* ------------------------------------------------------------- catalogs */

  /**
   * The things a sync could move, rebuilt on a short delay.
   *
   * The panel polls `status` every few seconds; hashing every skill and walking
   * every plugin on each poll would be pure waste, so the result is reused for
   * `CATALOG_TTL` and rebuilt immediately on an explicit refresh.
   *
   * @param force - ignore the cached copy.
   */
  function catalogs(force = false) {
    const now = Date.now()
    if (!force && catalogCache.at > 0 && now - catalogCache.at < CATALOG_TTL) return catalogCache
    const errors = []
    let plugins = []
    let skills = []
    let models = []
    try {
      plugins = profileDir === null ? [] : listPlugins({ profileDir, skip: ['dsh-mobile-sync'] })
    } catch (error) {
      errors.push(`插件目录读取失败：${String(error?.message ?? error)}`)
    }
    try {
      skills = listSkills({ home, agentsHome: agentsRoot })
    } catch (error) {
      errors.push(`技能目录读取失败：${String(error?.message ?? error)}`)
    }
    try {
      // The plugin records are passed in so the model channel can also list
      // providers a plugin declares in its own bundle patch — the panel groups
      // them like any other provider.
      models = patchFile === null ? [] : listModels({ patchFile, credentialsFile, plugins })
    } catch (error) {
      errors.push(`模型配置读取失败：${String(error?.message ?? error)}`)
    }
    catalogCache = { at: now, plugins, skills, models, errors }
    return catalogCache
  }

  /** A plugin's display state, from the switches plus what the phone reported. */
  function pluginState(plugin) {
    // Only a package that cannot be mounted at all is "unsupported". A warned
    // plugin (native bits, external deps) is an ordinary switch like any other:
    // it travels when ticked and the panel shows the warning on its row.
    if (plugin.deliverable === false) return 'unsupported'
    const on = selected(state.sync.plugins, plugin.name, false)
    if (!on) return 'off'
    if (state.peer === null) return 'nopeer'
    if (state.sync.force === true) return 'send'
    const phoneVersion = state.peer.plugins?.[plugin.name]
    if (isNewer(phoneVersion, plugin.version)) return 'newer'
    if (atLeast(phoneVersion, plugin.version)) return 'same'
    return 'send'
  }

  /** The same, for one skill: content-addressed, so it can report "identical". */
  function skillState(skill) {
    const on = selected(state.sync.skills, skill.name, false)
    if (!on) return 'off'
    const onPhone = Array.isArray(state.peer?.skills) && state.peer.skills.includes(skill.name)
    if (state.sync.force !== true && onPhone && state.sent.skills?.[skill.name]?.digest === skill.digest) return 'same'
    return 'send'
  }

  /* ------------------------------------------------------------- messages */

  /** Read a request body up to `MAX_UPLOAD` bytes. */
  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      request.on('data', (chunk) => {
        total += chunk.length
        if (total > MAX_UPLOAD) {
          reject(new Error('上传内容过大'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    })
  }

  /** Send a small text response. */
  function sendText(response, status, text, type = 'text/plain; charset=utf-8') {
    response.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(text)
  }

  /** Send a JSON response. */
  function sendJson(response, status, value) {
    sendText(response, status, JSON.stringify(value, null, 2), 'application/json; charset=utf-8')
  }

  /* -------------------------------------------------------------- routes */

  /** Answer `POST /api/push`: unpack the phone bundle and fold it in. */
  async function handlePush(request, response, device) {
    const body = await readBody(request)
    if (body.length === 0) {
      sendText(response, 400, '空包')
      return
    }
    let entries
    let skipped
    try {
      const result = unpack(body)
      entries = result.entries
      skipped = result.skipped
    } catch (error) {
      note(`手机 ${device} 上传的包无法解开：${String(error?.message ?? error)}`)
      sendText(response, 400, `压缩包无法解开：${String(error?.message ?? error)}`)
      return
    }

    const result = ingestPush({
      sessionsRoot,
      indexFile,
      backupDir: path.join(stateDir(home), 'backup'),
      sync: state.sync,
      entries,
      device,
    })

    // Remember who the phone is: a pull needs its paths, its profile and what it
    // already has before the next upload arrives.
    state.peer = {
      device: result.peer.device,
      at: Date.now(),
      home: result.peer.info.home ?? null,
      sessionsRoot: result.peer.info.sessions ?? null,
      profileDir: result.peer.info.profile ?? null,
      profileName: result.peer.info.profileName ?? null,
      plugins: result.peer.plugins,
      skills: result.peer.skills,
    }
    try {
      const raw = (name) => entries.find(entry => entry.relative === name)?.data.toString('utf8')
      savePeerFiles(peerDir(home), {
        index: result.peer.hasIndex ? JSON.stringify(result.peer.index ?? {}, null, 2) : undefined,
        profilePackage: result.peer.hasProfile ? raw('_meta/profile/package.json') : undefined,
        patch: result.peer.hasPatch ? raw('_meta/patch/cordis.patch.yml') : undefined,
        credentials: result.peer.hasCredentials ? raw('_meta/patch/credentials.yaml') : undefined,
        sessions: result.peer.hasSessions ? raw('_meta/sessions.txt') : undefined,
      })
    } catch (error) {
      result.lines.push(`手机上报的文件未能缓存：${String(error?.message ?? error)}`)
    }

    // The panel tags a row as "from phone"; keep that list bounded.
    const ids = result.lines
      .map(line => /^导入 .* · ((?:session-)?[0-9a-f-]{36})/u.exec(line)?.[1])
      .filter(id => id !== undefined)
    for (const id of ids) state.imported[id] = { at: Date.now(), device }
    const importedKeys = Object.keys(state.imported)
    if (importedKeys.length > 2000) {
      for (const key of importedKeys.slice(0, importedKeys.length - 2000)) delete state.imported[key]
    }

    const counts = result.counts
    const summary =
      `来自 ${device}：导入 ${counts.imported}，相同 ${counts.identical}，` +
      `保留本机 ${counts['kept-local'] + counts.diverged}，无法识别 ${counts.rejected}` +
      (counts.subagent > 0 ? `，跳过子代理 ${counts.subagent}` : '') +
      ((counts.unpaired ?? 0) > 0 ? `，未勾选工作区 ${counts.unpaired}` : '') +
      (skipped.length > 0 ? `，忽略文件 ${skipped.length}` : '')
    noteMany([summary, ...result.lines.slice(0, 24)])
    sendText(response, 200, [`${summary}`, ...result.lines].join('\n') + '\n')
  }

  /** Answer `POST /api/pull` with everything the phone should install. */
  function handlePull(response) {
    let plan
    try {
      plan = planPull({
        sessionsRoot,
        indexFile,
        sync: state.sync,
        peer: state.peer ?? {},
        peerFiles: loadPeerFiles(peerDir(home)),
        catalogs: catalogs(),
        sent: state.sent,
        credentialsFile,
      })
    } catch (error) {
      const message = String(error?.message ?? error)
      note(`生成同步包失败：${message}`)
      sendText(response, 500, `生成同步包失败：${message}`)
      return
    }

    const archive = pack(plan.files)
    response.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(archive.length),
      'Content-Disposition': `attachment; filename="dsh-sync-${Date.now()}.tar.gz"`,
      'Cache-Control': 'no-store',
    })
    response.end(archive)

    // Remember what this pull handed over, so the next one can skip it.
    for (const [name, value] of Object.entries(plan.sent.plugins)) state.sent.plugins[name] = value
    for (const [name, value] of Object.entries(plan.sent.skills)) state.sent.skills[name] = value
    if (plan.sent.patch !== null) state.sent.patch = plan.sent.patch
    if (plan.sent.credentials !== null) state.sent.credentials = plan.sent.credentials
    if (state.sync.force === true) state.sync.force = false
    noteMany([`下发同步包 ${sizeText(archive.length)}：${plan.summary.sessions} 个会话`, ...plan.lines.slice(0, 10)])
  }

  /**
   * Both machines' workspaces, for the panel's「同步工作区」card.
   *
   * Two lists, both actionable:
   *
   * - **desktop**: one switch per workspace (do its conversations travel?) and
   *   one target selector (where do they land on the phone?);
   * - **phone**: the workspaces the phone reported, each with a selector for the
   *   desktop workspace it lands in when its conversations come back.
   *
   * The desktop side comes from `workspace.json`; the phone side is the index the
   * phone uploaded last time (cached under `peer/`). Until a phone has reported,
   * `phoneKnown` is false and both lists can only show their defaults.
   */
  function workspaceCatalog() {
    const loaded = readIndex(indexFile)
    const archived = new Set(loaded.index.global.archivedSessionIds)
    const desktop = []
    for (const [id, workspace] of Object.entries(loaded.index.tables.workspaces)) {
      if (isScratchWorkspace(workspace.path)) continue
      const live = workspace.sessionIds.filter(sessionId => !archived.has(sessionId)).length
      const title = workspace.title || baseName(workspace.path)
      const mapped = state.sync.workspaceMap?.[id]
      desktop.push({
        id,
        title,
        path: workspace.path,
        sessions: live,
        archived: workspace.sessionIds.length - live,
        // The per-workspace sync switch (「同步对话」), off until ticked.
        selected: selected(state.sync.workspaces, id, false),
        // '' = no explicit target: land in a phone folder named after the title.
        mapped: typeof mapped === 'string' && mapped.length > 0 ? mapped : null,
        // Where an unpaired workspace lands right now.
        target: joinDesktopRoot(state.sync.phoneRoot, title, safeName),
      })
    }
    desktop.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'))

    const phone = []
    let phoneKnown = false
    const peerFiles = loadPeerFiles(peerDir(home))
    if (peerFiles.index !== null) {
      try {
        const index = normalizeIndex(JSON.parse(peerFiles.index))
        phoneKnown = true
        for (const [id, workspace] of Object.entries(index.tables.workspaces)) {
          // The phone keeps a landing area for its own uploads; it is not a
          // project and has no business in a pairing row.
          if (isScratchWorkspace(workspace.path)) continue
          const title = workspace.title || baseName(workspace.path)
          // Which ticked desktop workspaces send into this phone folder.
          const incoming = desktop.filter(item => item.selected &&
            (item.mapped === id || (item.mapped === null && item.title === title)))
          phone.push({
            id,
            title,
            path: workspace.path,
            sessions: workspace.sessionIds.length,
            incoming: incoming.map(item => item.title),
            // The desktop workspace this phone project's conversations land in.
            // '' = none chosen: `<desktopRoot>/<title>`. A desktop→phone pairing
            // from the list above is the implicit answer and is not repeated.
            mapped: desktopForPhone(state.sync, id) ?? '',
          })
        }
        phone.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'))
      } catch (_error) {
        phoneKnown = false
      }
    }

    return {
      desktop,
      phone,
      phoneKnown,
      indexError: loaded.error !== null,
      map: { ...state.sync.workspaceMap },
      on: desktop.filter(item => item.selected).length,
      phoneRoot: state.sync.phoneRoot,
      desktopRoot: state.sync.desktopRoot,
    }
  }

  /** Build the model both HTML pages render from. */
  function pageModel(error = null) {
    const entries = scan(sessionsRoot)
    const catalog = catalogs()
    return {
      token: state.token,
      command: command(),
      qr: qrSvg(pairUrl() || 'http://127.0.0.1/', { size: 208 }),
      urls: urls(),
      sessions: entries,
      imported: state.imported,
      log: state.log,
      error,
      request: requestStatus(),
      channels: state.sync.channels,
      plugins: catalog.plugins.map(plugin => ({
        name: plugin.name,
        version: plugin.version,
        bytes: plugin.bytes,
        installable: plugin.installable,
        supported: plugin.supported === true,
        deliverable: plugin.deliverable === true,
        dependenciesInside: plugin.dependenciesInside === true,
        dependencies: plugin.dependencies ?? [],
        bundled: plugin.bundled ?? [],
        warning: plugin.warning ?? null,
        reason: plugin.reason,
        selected: selected(state.sync.plugins, plugin.name, false),
      })),
      skills: catalog.skills.map(skill => ({
        name: skill.name,
        source: skill.source,
        bytes: skill.bytes,
        selected: selected(state.sync.skills, skill.name, false),
      })),
      models: catalog.models.map(group => ({
        key: group.key,
        label: group.label,
        provider: group.provider,
        baseURL: group.baseURL,
        models: group.models ?? [],
        source: group.source,
        plugin: group.plugin ?? null,
        selected: selected(state.sync.models, group.key, false),
      })),
      workspaces: workspaceCatalog(),
    }
  }

  /** Route one request. */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    // Header first: a token in the query string ends up in server logs and in
    // any proxy between the two machines. The query form is kept for old scripts.
    const token = request.headers['x-dsh-sync-token'] ?? url.searchParams.get('t') ?? ''
    const device = (url.searchParams.get('device') ?? '').slice(0, 64) || '手机'
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (pathname === '/' || pathname === '/j') {
      if (token !== state.token) {
        sendText(response, 200, gatePage(token.length > 0 ? '令牌不对，请重新扫码。' : ''), 'text/html; charset=utf-8')
        return
      }
      if (request.method !== 'GET') {
        sendText(response, 405, 'method not allowed')
        return
      }
      sendText(response, 200, controlPage(pageModel()), 'text/html; charset=utf-8')
      return
    }

    if (token !== state.token) {
      sendJson(response, 401, { error: '无效的配对令牌' })
      return
    }

    if (pathname === '/join.sh') {
      const first = urls()[0] ?? `http://127.0.0.1:${live.port}`
      sendText(response, 200, phoneScript({ base: first, token: state.token, name: deviceName }), 'text/x-shellscript; charset=utf-8')
      return
    }

    if (pathname === '/api/ping') {
      sendJson(response, 200, {
        ok: true,
        desktop: deviceName,
        platform: process.platform,
        port: live.port,
        sessions: scan(sessionsRoot).length,
        now: Date.now(),
      })
      return
    }

    // The phone cannot parse JSON, so the one document it must understand is
    // plain `key=value` — the same shape it uses to report back.
    if (pathname === '/api/manifest') {
      const pending = pendingRequest()
      const wants = {
        sessions: isOn(state.sync, 'sessions') ? 1 : 0,
        models: isOn(state.sync, 'models') ? 1 : 0,
        plugins: isOn(state.sync, 'plugins') ? 1 : 0,
        skills: isOn(state.sync, 'skills') ? 1 : 0,
        secrets: state.sync.secrets === true ? 1 : 0,
        profile: profileDir === null ? 0 : 1,
        // `manual=1` tells the phone that a sync has to be released by the
        // panel's button; `request` names the armed one (0 = nothing pending).
        manual: 1,
        request: pending === null ? 0 : pending.id,
        desktop: deviceName.replace(/\s+/gu, ' '),
      }
      sendText(response, 200, Object.entries(wants).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')
      return
    }

    // The phone's wait loop holds this open until the panel arms a request. It
    // is what makes「点按钮才同步」instant instead of a 5-second poll.
    if (pathname === '/api/await') {
      await handleAwait(response, url)
      return
    }

    // The phone reports back after it finished the upload+download pair.
    if (pathname === '/api/done') {
      const id = url.searchParams.get('request') ?? ''
      const changed = finishSync(id)
      sendText(response, 200, changed ? 'ok=1\n' : 'ok=0\n')
      return
    }

    if (pathname === '/api/inventory') {
      sendJson(response, 200, { sessions: scan(sessionsRoot) })
      return
    }

    if (pathname === '/api/pull') {
      if (request.method !== 'POST' && request.method !== 'GET') {
        sendText(response, 405, 'method not allowed')
        return
      }
      handlePull(response)
      return
    }

    if (pathname === '/api/push') {
      if (request.method !== 'POST') {
        sendText(response, 405, 'method not allowed')
        return
      }
      await handlePush(request, response, device)
      return
    }

    sendJson(response, 404, { error: 'unknown route' })
  }

  /* ----------------------------------------------------------- lifecycle */

  /** Try to bind one port, falling back across a small span. */
  function listen(port, host) {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer((request, response) => {
        Promise.resolve()
          .then(() => handle(request, response))
          .catch((error) => {
            try {
              sendJson(response, 500, { error: String(error?.message ?? error) })
            } catch (_error) {
              // The socket may already be gone; nothing else to do.
            }
          })
      })
      candidate.keepAliveTimeout = 5000
      candidate.headersTimeout = 30000
      candidate.requestTimeout = 0
      const onError = (error) => {
        candidate.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        candidate.removeListener('error', onError)
        resolve(candidate)
      }
      candidate.once('error', onError)
      candidate.once('listening', onListening)
      candidate.listen(port, host)
    })
  }

  /**
   * Start the listener, walking forward when the preferred port is taken.
   * @param host - bind address; the wildcard is correct here because the phone
   *   is on the other side of the interface, and every route is token-gated.
   */
  async function start(host = '0.0.0.0') {
    if (server !== null) return live
    const preferred = Number.isInteger(state.port) && state.port > 0 ? state.port : DEFAULT_PORT
    let lastError = null
    for (let offset = 0; offset < PORT_SPAN; offset += 1) {
      const port = preferred + offset
      try {
        server = await listen(port, host)
        live = { running: true, port, error: null }
        if (port !== state.port) {
          state.port = port
          try {
            saveState(home, state)
          } catch (_error) {
            // A port preference is cosmetic.
          }
        }
        if (typeof logger.info === 'function') {
          logger.info(`[mobile-sync] listening on ${urls().join(' · ') || `port ${port}`}`)
        }
        return live
      } catch (error) {
        lastError = error
        server = null
      }
    }
    live = { running: false, port: 0, error: String(lastError?.message ?? lastError ?? 'bind failed') }
    if (typeof logger.warn === 'function') logger.warn(`[mobile-sync] could not bind: ${live.error}`)
    return live
  }

  /** Stop the listener. */
  async function stop() {
    const current = server
    server = null
    live = { running: false, port: 0, error: null }
    if (current === null) return
    await new Promise((resolve) => {
      current.close(() => resolve())
      if (typeof current.closeAllConnections === 'function') current.closeAllConnections()
    })
  }

  /** Restart on a new port, if one was asked for. */
  async function restart(port) {
    if (Number.isInteger(port) && port > 1024 && port < 65536) {
      state.port = port
      saveState(home, state)
    }
    await stop()
    return start()
  }

  /** Replace the pairing token; every phone must re-pair afterwards. */
  function resetToken() {
    state.token = newToken()
    saveState(home, state)
    note('已重置配对令牌')
    return state.token
  }

  /** Choose which adapter address the QR code and command point at. */
  function setAddress(address) {
    const known = lanAddresses().some((item) => item.address === address)
    state.preferred = known ? address : null
    saveState(home, state)
    note(known ? `已选用网卡地址 ${address}` : '已恢复自动选择网卡')
    return state.preferred
  }

  /** Drop the sync log, keeping the record of what was imported. */
  function clearLog() {
    state.log = []
    saveState(home, state)
    return state.log
  }

  /**
   * Apply one panel edit.
   *
   * Every action lands here rather than in the router so the browser half and
   * the LAN page cannot drift apart: whatever changes state is validated once,
   * persisted once, and answered with a complete fresh status.
   *
   * @param body - `{ action, ... }` from the panel.
   * @returns `{ status, body }` for the HTTP layer.
   */
  async function act(body) {
    const action = typeof body?.action === 'string' ? body.action : ''
    switch (action) {
      case 'restart':
        await restart(Number(body.port))
        note('已重启监听')
        break
      case 'reset-token':
        resetToken()
        break
      case 'set-address':
        setAddress(typeof body.address === 'string' ? body.address : '')
        break
      case 'rescan':
        catalogs(true)
        note('已刷新插件与技能列表')
        break
      case 'clear-log':
        clearLog()
        break
      case 'set-channel': {
        const channel = String(body.channel ?? '')
        if (!CHANNELS.includes(channel)) return { status: 400, body: { error: `unknown channel: ${channel}` } }
        state.sync.channels[channel] = body.on === true
        saveState(home, state)
        note(`${channel} 通道已${body.on === true ? '开启' : '关闭'}`)
        break
      }
      case 'set-plugin':
      case 'set-skill':
      case 'set-model':
      case 'set-key': {
        const kind = action === 'set-plugin' ? 'plugins' : action === 'set-skill' ? 'skills' : action === 'set-key' ? 'modelKeys' : 'models'
        const name = String(body.name ?? '')
        if (name.length === 0) return { status: 400, body: { error: 'missing name' } }
        setSelected(state.sync, kind, name, body.on === true)
        saveState(home, state)
        if (action === 'set-key') note(`模型组 ${name} 的密钥：${body.on === true ? '随组下发' : '不下发'}`)
        break
      }
      case 'set-keys-all': {
        // "全选密钥" / "全部不带密钥": one decision per model group, so the next
        // sync does not resend a key the user explicitly held back.
        const on = body.on === true
        for (const group of catalogs().models) state.sync.modelKeys[group.key] = on
        saveState(home, state)
        note(on ? '所有模型组都带上各自的密钥' : '所有模型组都不下发密钥')
        break
      }
      case 'set-all': {
        const known = body.kind === 'plugins' || body.kind === 'skills' || body.kind === 'models' || body.kind === 'workspaces'
        const kind = known ? body.kind : 'models'
        const catalog = catalogs()
        const names = kind === 'plugins'
          // A warned plugin is still offered: "全选" means every plugin that can
          // be delivered, and the panel keeps showing the caveat on its row.
          ? catalog.plugins.filter(item => item.deliverable === true).map(item => item.name)
          : kind === 'skills'
            ? catalog.skills.map(item => item.name)
            : kind === 'workspaces'
              ? Object.keys(readIndex(indexFile).index.tables.workspaces)
                .filter(id => !isScratchWorkspace(readIndex(indexFile).index.tables.workspaces[id].path))
              : catalog.models.map(item => item.key)
        setSelectedAll(state.sync, kind, names, body.on === true)
        saveState(home, state)
        note(`${kind}：${body.on === true ? '全选' : '全不选'} ${names.length} 个`)
        break
      }
      case 'request-sync':
        requestSync()
        break
      case 'cancel-sync':
        cancelSync()
        break
      case 'set-workspace': {
        // The「同步对话」box on one workspace row: does its conversations travel?
        const id = String(body.id ?? '').trim()
        if (id.length === 0) return { status: 400, body: { error: 'missing workspace' } }
        setSelected(state.sync, 'workspaces', id, body.on === true)
        saveState(home, state)
        const workspace = workspaceCatalog().desktop.find(item => item.id === id)
        note(`工作区 ${workspace?.title ?? id}：${body.on === true ? '同步对话' : '停止同步对话'}`)
        break
      }
      case 'set-workspace-map': {
        const desktopId = String(body.desktop ?? '').trim()
        const phoneId = String(body.phone ?? '').trim()
        if (desktopId.length === 0) return { status: 400, body: { error: 'missing desktop workspace' } }
        setWorkspaceMap(state.sync, desktopId, phoneId)
        saveState(home, state)
        note(phoneId === '' ? '工作区已改为落到手机上的同名目录' : '工作区已指定手机上的目标目录')
        break
      }
      case 'set-phone-workspace-map': {
        // The selector on the phone-workspace list: where does this phone
        // project's conversation land on this machine?
        const phoneId = String(body.phone ?? '').trim()
        const desktopId = String(body.desktop ?? '').trim()
        if (phoneId.length === 0) return { status: 400, body: { error: 'missing phone workspace' } }
        if (desktopId.length > 0 && readIndex(indexFile).index.tables.workspaces[desktopId] === undefined) {
          return { status: 400, body: { error: 'unknown desktop workspace' } }
        }
        setPhoneWorkspaceMap(state.sync, phoneId, desktopId)
        saveState(home, state)
        const catalog = workspaceCatalog()
        const phone = catalog.phone.find(item => item.id === phoneId)
        const desktop = catalog.desktop.find(item => item.id === desktopId)
        note(`手机工作区 ${phone?.title ?? phoneId}：${desktopId === '' ? '回到电脑同名目录' : `回到 ${desktop?.title ?? desktopId}`}`)
        break
      }
      case 'reset-workspace-map': {
        const cleared = clearWorkspaceMap(state.sync)
        saveState(home, state)
        note(`已清除 ${cleared} 条工作区配对（未勾选的工作区不会再传，勾选的回到手机同名目录）`)
        break
      }
      case 'set-root': {
        const which = body.which === 'desktop' ? 'desktopRoot' : 'phoneRoot'
        const value = typeof body.value === 'string' ? body.value.trim() : ''
        const defaults = defaultSync(undefined, home)
        state.sync[which] = value.length === 0 ? defaults[which] : value
        saveState(home, state)
        note(`${which === 'desktopRoot' ? '桌面' : '手机'}同步根目录：${state.sync[which]}`)
        break
      }
      case 'set-archived':
        state.sync.includeArchived = body.on === true
        saveState(home, state)
        note(body.on === true ? '将同步已归档会话' : '已归档会话保持不同步')
        break
      case 'set-secrets':
        state.sync.secrets = body.on === true
        saveState(home, state)
        note(body.on === true ? '已开启 API 密钥同步（明文 LAN）' : '已关闭 API 密钥同步')
        break
      case 'force':
        state.sync.force = true
        saveState(home, state)
        note('下一次下发将忽略「版本相同」判断')
        break
      default:
        return { status: 400, body: { error: `unknown action: ${action}` } }
    }
    return { status: 200, body: status() }
  }

  /** A snapshot for the desktop UI. */
  function status() {
    const entries = scan(sessionsRoot)
    const catalog = catalogs()
    const peer = state.peer
    const phonePlugins = peer?.plugins ?? {}
    const phoneSkills = Array.isArray(peer?.skills) ? peer.skills : []
    // Count the unindexed sessions from the listing we already have instead of
    // walking the store twice: this runs on every panel poll.
    let unindexed = 0
    try {
      const known = new Set()
      for (const workspace of Object.values(readIndex(indexFile).index.tables.workspaces)) {
        for (const id of workspace.sessionIds) known.add(id)
      }
      unindexed = entries.reduce((total, entry) => total + (known.has(entry.id) ? 0 : 1), 0)
    } catch (_error) {
      unindexed = 0
    }
    return {
      running: live.running,
      port: live.port || state.port,
      error: live.error,
      token: state.token,
      urls: urls(),
      addresses: lanAddresses(),
      preferred: state.preferred,
      pairUrl: pairUrl(),
      localUrl: live.running ? `http://127.0.0.1:${live.port}/j?t=${state.token}` : null,
      command: command(),
      qr: qrSvg(pairUrl() || 'http://127.0.0.1/', { size: 208 }),
      host: os.hostname(),
      sessionsRoot,
      total: entries.length,
      fromPhone: Object.keys(state.imported).length,
      log: state.log.slice(0, 40),

      channels: { ...state.sync.channels },
      sync: {
        includeArchived: state.sync.includeArchived,
        secrets: state.sync.secrets,
        force: state.sync.force,
        phoneRoot: state.sync.phoneRoot,
        desktopRoot: state.sync.desktopRoot,
        workspaceMap: { ...state.sync.workspaceMap },
        workspaces: { ...state.sync.workspaces },
        modelKeys: { ...state.sync.modelKeys },
        defaultsRev: state.sync.defaultsRev,
      },
      request: requestStatus(),
      workspaces: workspaceCatalog(),
      paths: {
        profile: profileDir,
        patch: patchFile,
        skills: skillsRoot,
        agentsSkills: path.join(agentsRoot, 'skills'),
        sessions: sessionsRoot,
        index: indexFile,
      },
      peer: peer === null ? null : {
        device: peer.device ?? null,
        at: peer.at ?? null,
        home: peer.home ?? null,
        profile: peer.profileName ?? null,
        plugins: Object.keys(phonePlugins).length,
        skills: phoneSkills.length,
      },
      counts: {
        sessions: entries.length,
        unindexed,
        indexed: Math.max(0, entries.length - unindexed),
      },
      plugins: catalog.plugins.map(plugin => ({
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        bytes: plugin.bytes,
        files: plugin.files,
        installable: plugin.installable,
        supported: plugin.supported === true,
        deliverable: plugin.deliverable === true,
        dependenciesInside: plugin.dependenciesInside === true,
        bundled: plugin.bundled ?? [],
        warning: plugin.warning ?? null,
        reason: plugin.reason,
        bundle: plugin.bundle,
        dependencies: plugin.dependencies,
        selected: selected(state.sync.plugins, plugin.name, false),
        phoneVersion: phonePlugins[plugin.name] ?? null,
        state: pluginState(plugin),
      })),
      skills: catalog.skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        kind: skill.kind,
        bytes: skill.bytes,
        files: skill.files,
        selected: selected(state.sync.skills, skill.name, false),
        onPhone: phoneSkills.includes(skill.name),
        state: skillState(skill),
      })),
      models: catalog.models.map(group => ({
        key: group.key,
        kind: group.kind,
        label: group.label,
        rowId: group.rowId,
        provider: group.provider,
        baseURL: group.baseURL,
        endpoint: group.endpoint,
        models: group.models ?? [],
        keys: group.keys ?? [],
        hasKey: group.hasKey !== false,
        disabled: group.disabled === true,
        source: group.source,
        plugin: group.plugin ?? null,
        pluginSelected: group.plugin === null ? null : selected(state.sync.plugins, group.plugin, false),
        selected: selected(state.sync.models, group.key, false),
        // Keys: the master switch, this group's own switch, and whether the
        // desktop actually holds every ref the group names.
        keySelected: selected(state.sync.modelKeys, group.key, true),
        secrets: state.sync.secrets === true,
        missingKeys: (group.keys ?? []).filter(ref => !credentialRefs(credentialsFile).has(ref)),
      })),
      errors: catalog.errors,
    }
  }

  return {
    start,
    stop,
    restart,
    resetToken,
    setAddress,
    clearLog,
    status,
    note,
    act,
    catalogs: force => {
      const catalog = catalogs(force === true)
      return {
        plugins: catalog.plugins.map(plugin => ({
          name: plugin.name,
          version: plugin.version,
          installable: plugin.installable,
          reason: plugin.reason,
        })),
        skills: catalog.skills.map(skill => ({ name: skill.name, digest: skill.digest })),
        models: catalog.models.map(group => ({ key: group.key, label: group.label, baseURL: group.baseURL })),
      }
    },
    inventory: () => scan(sessionsRoot),
    paths: { stateDir: stateDir(home), peerDir: peerDir(home), profileDir, patchFile, indexFile },
  }
}
