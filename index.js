/**
 * dsh-workspace-proxy — per-workspace outbound proxy routing for DeepSeek Harness.
 *
 * The Harness sends its own traffic (model providers, web search, HTTP MCP) through Node's
 * built-in `fetch`, which resolves undici's global dispatcher. This plugin owns that seat:
 * it installs one routing dispatcher that answers every request with the proxy configured
 * for the workspace of the Session that initiated it, then delegates to either a cached
 * ProxyAgent or the dispatcher it replaced.
 *
 * Settings live in `$DSH_HOME/proxy-settings.json`; the Web panel edits them over the
 * plugin's own small JSON route, so a change is live without reloading the plugin.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROUTE_PATH = '/proxy-settings'
const API_PATH = '/proxy-settings/api'
const TEST_PATH = '/proxy-settings/test'
const MAX_BODY_BYTES = 256 * 1024
const MAX_PROXIES = 50
const WORKSPACE_CACHE_MS = 2000
const HEALTH_TTL_MS = 60 * 1000

/** Empty, valid settings. */
function emptySettings() {
  return { version: 1, enabled: true, defaultProxyId: null, fallbackToDirect: true, proxies: [] }
}

/** `$DSH_HOME`, falling back to `~/.dsh` outside a profile-launched Harness. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** Tiny best-effort logger; a logger shape change must never break routing. */
function log(ctx, level, message) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('proxy-settings') : ctx.logger
    const write = logger?.[level]
    if (typeof write === 'function') write.call(logger, message)
  } catch {
    // Routing never depends on logging.
  }
}

/* -------------------------------------------------------------------------- */
/* Settings model                                                             */
/* -------------------------------------------------------------------------- */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Parse one proxy URL, returning `{ proxy }` or `{ error }`. */
function parseProxyUrl(raw) {
  const text = stringOr(raw, '').trim()
  if (text === '') return { error: '代理地址不能为空' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { error: `无法解析代理地址：${text}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: '只支持 http:// 或 https:// 代理' }
  }
  if (url.hostname === '') return { error: '代理地址缺少主机名' }
  return { proxy: url }
}

/** Normalize one stored proxy record; tolerant so a hand-edited file still loads. */
function normalizeProxy(raw, index) {
  const source = isPlainObject(raw) ? raw : {}
  const id = stringOr(source.id, '').trim() || `proxy-${index + 1}`
  return {
    id,
    name: stringOr(source.name, '').trim() || `代理 ${index + 1}`,
    url: stringOr(source.url, '').trim(),
    username: stringOr(source.username, ''),
    password: stringOr(source.password, ''),
    noProxy: stringOr(source.noProxy, ''),
    enabled: booleanOr(source.enabled, true),
    workspaceIds: uniqueStrings(source.workspaceIds),
  }
}

/** Normalize a whole settings document from disk; never throws. */
function parseStoredSettings(raw) {
  if (!isPlainObject(raw)) return emptySettings()
  const proxies = Array.isArray(raw.proxies) ? raw.proxies.slice(0, MAX_PROXIES).map(normalizeProxy) : []
  const seen = new Set()
  for (const proxy of proxies) {
    if (seen.has(proxy.id)) proxy.id = `${proxy.id}-${seen.size + 1}`
    seen.add(proxy.id)
  }
  const defaultProxyId = stringOr(raw.defaultProxyId, null)
  return {
    version: 1,
    enabled: booleanOr(raw.enabled, true),
    fallbackToDirect: booleanOr(raw.fallbackToDirect, true),
    defaultProxyId: defaultProxyId && proxies.some((p) => p.id === defaultProxyId) ? defaultProxyId : null,
    proxies,
  }
}

/**
 * Validate a settings document written by the panel.
 *
 * @returns `{ settings }` or `{ error }` with a message the panel can show.
 */
function validateSettings(raw) {
  if (!isPlainObject(raw)) return { error: '设置必须是一个 JSON 对象' }
  const rawProxies = Array.isArray(raw.proxies) ? raw.proxies : []
  if (rawProxies.length > MAX_PROXIES) return { error: `代理数量不能超过 ${MAX_PROXIES} 个` }
  const proxies = []
  const used = new Set()
  const clears = new Set()
  for (const [index, entry] of rawProxies.entries()) {
    if (!isPlainObject(entry)) return { error: `第 ${index + 1} 个代理格式不正确` }
    const proxy = normalizeProxy(entry, index)
    const parsed = parseProxyUrl(proxy.url)
    if (parsed.error) return { error: `「${proxy.name}」：${parsed.error}` }
    proxy.url = parsed.proxy.toString().replace(/\/$/, '')
    if (used.has(proxy.id)) proxy.id = `${proxy.id}-${index + 1}`
    used.add(proxy.id)
    if (entry.clearPassword === true) clears.add(proxy.id)
    proxies.push(proxy)
  }
  const defaultProxyId = typeof raw.defaultProxyId === 'string' ? raw.defaultProxyId : null
  return {
    clears,
    settings: {
      version: 1,
      enabled: booleanOr(raw.enabled, true),
      fallbackToDirect: booleanOr(raw.fallbackToDirect, true),
      defaultProxyId: defaultProxyId && used.has(defaultProxyId) ? defaultProxyId : null,
      proxies,
    },
  }
}

/** Read settings from disk once, tolerating a missing or broken file. */
function loadSettings(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return parseStoredSettings(JSON.parse(text))
  } catch {
    return emptySettings()
  }
}

/** Persist settings atomically so a crash cannot leave a half-written file. */
function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

/* -------------------------------------------------------------------------- */
/* Proxy URL semantics                                                        */
/* -------------------------------------------------------------------------- */

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/** Loopback never travels through a proxy: the GUI, the API and local MCP servers live there. */
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host === '' || LOOPBACK_NAMES.has(host)) return host !== ''
  if (host.endsWith('.localhost')) return true
  if (/^127\./.test(host)) return true
  if (host === '::ffff:127.0.0.1' || host.startsWith('::ffff:127.')) return true
  return false
}

/** `NO_PROXY`-style bypass: host suffix match, optional port, `*` for everything. */
function bypassesProxy(noProxy, url) {
  const list = stringOr(noProxy, '').trim()
  if (list === '') return false
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  for (const entry of list.split(/[,\s]+/)) {
    const raw = entry.trim().toLowerCase()
    if (raw === '') continue
    if (raw === '*') return true
    const [name, entryPort] = splitHostPort(raw)
    if (name === '') continue
    if (entryPort !== undefined && entryPort !== port) continue
    const bare = name.replace(/^\*\./, '.').replace(/^\./, '')
    if (bare === '') continue
    if (hostname === bare || hostname.endsWith(`.${bare}`)) return true
    if (bare.startsWith('::') || bare.includes(':')) {
      if (hostname === bare) return true
    }
  }
  return false
}

/** Split `host:port`, tolerating bracketed IPv6. */
function splitHostPort(entry) {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']')
    if (end === -1) return [entry, undefined]
    const rest = entry.slice(end + 1)
    return [entry.slice(1, end), rest.startsWith(':') ? rest.slice(1) : undefined]
  }
  const at = entry.lastIndexOf(':')
  if (at === -1) return [entry, undefined]
  const port = entry.slice(at + 1)
  if (!/^\d+$/.test(port)) return [entry, undefined]
  return [entry.slice(0, at), port]
}

/** The URI handed to undici's ProxyAgent, credentials included when configured. */
function proxyUri(proxy) {
  const parsed = parseProxyUrl(proxy.url)
  if (!parsed.proxy) return proxy.url
  const url = parsed.proxy
  if (proxy.username) {
    url.username = proxy.username
    url.password = proxy.password
  }
  return url.toString().replace(/\/$/, '')
}

/* -------------------------------------------------------------------------- */
/* Proxy health                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Probe one proxy with a real CONNECT handshake.
 *
 * Reachability is what matters: any HTTP status line — including `407` for a proxy that
 * wants credentials — proves the endpoint answers. Only a refused, unresolvable or silent
 * socket marks it unreachable, which is the one case where routing through it would turn
 * every model request into an opaque transport failure.
 */
function checkProxy(proxy, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const parsed = parseProxyUrl(proxy.url)
    if (!parsed.proxy) {
      resolve({ ok: false, detail: 'invalid-url', at: Date.now() })
      return
    }
    const secure = parsed.proxy.protocol === 'https:'
    const host = parsed.proxy.hostname.replace(/^\[/, '').replace(/\]$/, '')
    const port = Number(parsed.proxy.port || (secure ? 443 : 80))
    const target = 'api.deepseek.com:443'
    const authorization =
      proxy.username !== ''
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
        : ''
    let settled = false
    let socket
    const finish = (ok, detail) => {
      if (settled) return
      settled = true
      try {
        socket?.destroy()
      } catch {
        // Already gone.
      }
      resolve({ ok, detail, at: Date.now() })
    }
    try {
      socket = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port })
    } catch (error) {
      finish(false, error instanceof Error ? error.message : String(error))
      return
    }
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    let buffer = ''
    socket.setTimeout(timeoutMs)
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization}\r\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      if (!buffer.includes('\r\n')) return
      clearTimeout(timer)
      const statusLine = buffer.split('\r\n')[0] ?? ''
      const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine.trim())
      const status = match ? Number(match[1]) : 0
      if (status > 0) {
        finish(true, status === 407 ? 'auth-required' : `http-${status}`)
        return
      }
      finish(false, statusLine.slice(0, 80) || 'no-status')
    })
    socket.once('timeout', () => {
      clearTimeout(timer)
      finish(false, 'timeout')
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      finish(false, error.code ?? error.message)
    })
    socket.once('close', () => {
      clearTimeout(timer)
      finish(false, 'closed')
    })
  })
}



/* -------------------------------------------------------------------------- */
/* Workspace matching                                                         */
/* -------------------------------------------------------------------------- */

function normalizePathForMatch(target) {
  const resolved = path.resolve(target)
  const normalized = path.normalize(resolved)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** `cwd` is the workspace directory itself or below it. */
function isInside(cwd, workspacePath) {
  const child = normalizePathForMatch(cwd)
  const parent = normalizePathForMatch(workspacePath)
  if (child === parent) return true
  const withSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`
  return child.startsWith(withSep)
}

/** Longest workspace path containing `cwd`, so nested workspaces resolve narrowest-first. */
function matchWorkspace(workspaces, cwd) {
  let best
  for (const workspace of workspaces) {
    if (typeof workspace.path !== 'string' || workspace.path === '') continue
    if (!isInside(cwd, workspace.path)) continue
    if (!best || workspace.path.length > best.path.length) best = workspace
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* undici discovery                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Locate the `undici` build this Harness already ships.
 *
 * The Host process is not inside a project, so a bare specifier does not resolve from the
 * plugin. The deployment's own copy is probed instead: Electron exposes `resourcesPath`,
 * and the `dsh` CLI runs a script with the installation on its own resolution path.
 */
function undiciCandidates() {
  const candidates = []
  const push = (directory) => {
    if (typeof directory === 'string' && directory !== '') candidates.push(directory)
  }
  try {
    if (typeof process.resourcesPath === 'string') {
      push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'))
      push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules'))
      push(path.join(process.resourcesPath, 'dsh', 'node_modules'))
    }
  } catch {
    // Not Electron.
  }
  try {
    push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'))
  } catch {
    // exe path unavailable.
  }
  try {
    if (process.argv[1]) {
      let directory = path.dirname(path.resolve(process.argv[1]))
      for (let i = 0; i < 8; i += 1) {
        push(path.join(directory, 'node_modules'))
        const parent = path.dirname(directory)
        if (parent === directory) break
        directory = parent
      }
    }
  } catch {
    // argv unavailable.
  }
  try {
    let directory = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 10; i += 1) {
      push(path.join(directory, 'node_modules'))
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  } catch {
    // import.meta unavailable.
  }
  return candidates
}

/** Resolve `undici` from the first candidate that owns a usable copy. */
function loadUndici() {
  const failures = []
  for (const directory of undiciCandidates()) {
    try {
      const requireFrom = createRequire(path.join(directory, 'noop.cjs'))
      const resolved = requireFrom.resolve('undici')
      const undici = requireFrom('undici')
      if (typeof undici.ProxyAgent !== 'function') {
        failures.push(`${resolved}: 缺少 ProxyAgent`)
        continue
      }
      if (typeof undici.getGlobalDispatcher !== 'function' || typeof undici.setGlobalDispatcher !== 'function') {
        failures.push(`${resolved}: 缺少 dispatcher 接口`)
        continue
      }
      return { undici, resolved }
    } catch (error) {
      failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const detail = failures.slice(0, 3).join('; ')
  throw new Error(`找不到可用的 undici（${detail || '未发现安装位置'}）`)
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The dispatcher installed into undici's global seat.
 *
 * Every dispatch resolves the proxy for its origin from the current Session's workspace and
 * then forwards `(opts, handler)` to the chosen transport, exactly as undici's own composite
 * agents do. Any resolution failure degrades to the dispatcher this one replaced.
 */
class RoutingDispatcher {
  constructor({ ctx, store, base, undici }) {
    this.ctx = ctx
    this.store = store
    this.base = base
    this.ProxyAgent = undici.ProxyAgent
    this.agents = new Map()
    this.health = new Map()
    this.sweeping = undefined
    this.override = new AsyncLocalStorage()
    this.forced = new AsyncLocalStorage()
    this.workspaceCache = { at: 0, workspaces: [] }
  }

  /** Run `operation` as if it originated from one explicit workspace directory. */
  withDirectory(directory, operation) {
    return directory ? this.override.run(directory, operation) : operation()
  }

  /** Run `operation` through one explicit proxy, ignoring workspace binding (connectivity test). */
  withProxy(proxy, operation) {
    return proxy ? this.forced.run(proxy, operation) : operation()
  }

  /** Live workspaces, cached briefly: the registry projection is synchronous but not free. */
  workspaces() {
    const now = Date.now()
    if (now - this.workspaceCache.at < WORKSPACE_CACHE_MS) return this.workspaceCache.workspaces
    let workspaces = []
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const list = registry?.list?.() ?? []
      workspaces = list.map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
      }))
    } catch {
      workspaces = []
    }
    this.workspaceCache = { at: now, workspaces }
    return workspaces
  }

  /** The directory of the Session that initiated this asynchronous chain, when there is one. */
  currentDirectory() {
    const override = this.override.getStore()
    if (typeof override === 'string' && override !== '') return override
    try {
      const agents = this.ctx.get('agents')
      const sessions = this.ctx.get('sessions')
      const workingDirectory = this.ctx.get('workingDirectory')
      const agent = agents?.currentInitiator?.()
      if (!agent) return undefined
      const session = sessions?.get?.(agent.id)
      if (!session) return undefined
      const directory = workingDirectory?.get?.(session)
      if (typeof directory === 'string' && directory !== '') return directory
      const recorded = session.header?.cwd
      return typeof recorded === 'string' && recorded !== '' ? recorded : undefined
    } catch {
      return undefined
    }
  }

  /** The proxy that would serve `url`, with the reason it was chosen or skipped. */
  inspect(url, directory) {
    const settings = this.store.read()
    if (!settings.enabled) return { proxy: null, reason: 'disabled' }
    const target = typeof url === 'string' ? safeUrl(url) : url
    if (!target) return { proxy: null, reason: 'invalid-url' }
    if (isLoopbackHost(target.hostname)) return { proxy: null, reason: 'loopback' }
    const forced = this.forced.getStore()
    if (forced) {
      if (bypassesProxy(forced.noProxy, target)) return { proxy: null, reason: 'no-proxy', proxyName: forced.name }
      return { proxy: forced, reason: 'explicit' }
    }
    const cwd = directory ?? this.currentDirectory()
    let chosen
    let matchedWorkspace
    if (cwd) {
      matchedWorkspace = matchWorkspace(this.workspaces(), cwd)
      if (matchedWorkspace) {
        chosen = settings.proxies.find(
          (proxy) => proxy.enabled && proxy.workspaceIds.includes(matchedWorkspace.id),
        )
      }
    }
    if (!chosen && settings.defaultProxyId) {
      chosen = settings.proxies.find((proxy) => proxy.enabled && proxy.id === settings.defaultProxyId)
    }
    if (!chosen) {
      return {
        proxy: null,
        reason: matchedWorkspace ? 'workspace-unbound' : 'no-default',
        workspace: matchedWorkspace ? { id: matchedWorkspace.id, title: matchedWorkspace.title } : undefined,
      }
    }
    if (bypassesProxy(chosen.noProxy, target)) {
      return { proxy: null, reason: 'no-proxy', proxyName: chosen.name }
    }
    const health = this.health.get(chosen.id)
    const stale = health !== undefined && Date.now() - health.at > HEALTH_TTL_MS
    if (settings.fallbackToDirect !== false && health !== undefined && !health.ok && !stale) {
      // A proxy that answered no handshake must not turn every request into a transport
      // failure: fall back to a direct connection and let the panel report why.
      return { proxy: null, reason: 'proxy-unreachable', proxyName: chosen.name, health }
    }
    return {
      proxy: chosen,
      reason: matchedWorkspace ? 'workspace' : 'default',
      workspace: matchedWorkspace ? { id: matchedWorkspace.id, title: matchedWorkspace.title } : undefined,
    }
  }

  /** Record one health observation for a proxy id. */
  setHealth(id, result) {
    this.health.set(id, result)
  }

  /** One sweep over enabled proxies; a request during a sweep queues exactly one more. */
  sweep() {
    if (this.sweeping) {
      this.sweepPending = true
      return this.sweeping
    }
    this.sweeping = (async () => {
      const settings = this.store.read()
      for (const proxy of settings.proxies) {
        if (!proxy.enabled) continue
        const result = await checkProxy(proxy)
        this.setHealth(proxy.id, result)
      }
      for (const id of [...this.health.keys()]) {
        if (!settings.proxies.some((proxy) => proxy.id === id)) this.health.delete(id)
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.sweeping = undefined
        if (this.sweepPending) {
          this.sweepPending = false
          void this.sweep()
        }
      })
    return this.sweeping
  }

  /** Cached ProxyAgent for one proxy record; the cache key covers every routing field. */
  agentFor(proxy) {
    const key = `${proxy.id}\u0000${proxy.url}\u0000${proxy.username}\u0000${proxy.password}`
    let agent = this.agents.get(key)
    if (!agent) {
      agent = new this.ProxyAgent({ uri: proxyUri(proxy) })
      this.agents.set(key, agent)
    }
    return agent
  }

  /** Drop agents whose proxy record changed or disappeared. */
  prune() {
    const settings = this.store.read()
    const live = new Set(
      settings.proxies.map(
        (proxy) => `${proxy.id}\u0000${proxy.url}\u0000${proxy.username}\u0000${proxy.password}`,
      ),
    )
    for (const [key, agent] of this.agents) {
      if (live.has(key)) continue
      this.agents.delete(key)
      Promise.resolve()
        .then(() => agent.close())
        .catch(() => {})
    }
  }

  dispatch(options, handler) {
    let target = this.base
    try {
      const origin = options?.origin
      const url = origin instanceof URL ? origin : safeUrl(String(origin))
      const route = url ? this.inspect(url) : { proxy: null }
      if (route.proxy) target = this.agentFor(route.proxy)
    } catch {
      target = this.base
    }
    return target.dispatch(options, handler)
  }

  async close() {
    const agents = [...this.agents.values()]
    this.agents.clear()
    await Promise.allSettled(agents.map((agent) => agent.close()))
  }

  destroy(error, callback) {
    this.close()
      .catch(() => {})
      .finally(() => callback?.(error))
  }
}

function safeUrl(value) {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Loopback, link-local, and RFC 1918 targets.
 *
 * The `/test` endpoint performs a real outbound request, so an unrestricted URL would make the
 * Harness a blind SSRF primitive against this machine and the local network.
 */
function isPrivateTarget(url) {
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  for (const suffix of ['.local', '.internal', '.lan', '.home.arpa']) {
    if (host.endsWith(suffix)) return true
  }
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
  const parts = host.split('.').map(Number)
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 198 && (b === 18 || b === 19)) return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* HTTP API                                                                   */
/* -------------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function workspaceList(ctx) {
  try {
    const registry = ctx.get('workspaceRegistry')
    return (registry?.list?.() ?? []).map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    }))
  } catch {
    return []
  }
}

/** Settings as the browser may see them: no password, only whether one is stored. */
function publicSettings(settings) {
  return {
    ...settings,
    proxies: settings.proxies.map((proxy) => ({
      ...proxy,
      password: '',
      hasPassword: proxy.password !== '',
    })),
  }
}

function snapshot(ctx, store, engine, router) {
  const health = {}
  if (router) for (const [id, result] of router.health) health[id] = result
  return {
    ok: true,
    settings: publicSettings(store.read()),
    workspaces: workspaceList(ctx),
    engine,
    health,
    file: store.file,
  }
}

/** One loopback request through the same routing code the real traffic uses. */
async function probe(router, target, directory, forcedProxy, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await router.withProxy(forcedProxy, () =>
      router.withDirectory(directory, () =>
        fetch(target, { method: 'GET', redirect: 'manual', signal: controller.signal }),
      ),
    )
    const status = response.status
    try {
      await response.arrayBuffer()
    } catch {
      // The status is the observation; a body read failure is not a routing failure.
    }
    return { status, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mount the per-workspace proxy router and its settings route.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const file = path.join(dshHome(), 'proxy-settings.json')
  const store = {
    file,
    read: () => state,
    write(next) {
      state = next
      saveSettings(file, next)
      return state
    },
  }
  let state = loadSettings(file)
  let router
  let engine = { available: false, reason: '正在初始化' }

  // The dispatcher seat is the whole feature: without a locatable undici the panel still
  // edits settings, and reports why routing is inactive instead of silently doing nothing.
  ctx.effect(() => {
    let disposed = false
    let restore
    ;(async () => {
      const { undici, resolved } = loadUndici()
      const base = undici.getGlobalDispatcher()
      const candidate = new RoutingDispatcher({ ctx, store, base, undici })
      undici.setGlobalDispatcher(candidate)
      if (disposed) {
        undici.setGlobalDispatcher(base)
        await candidate.close()
        return
      }
      router = candidate
      engine = { available: true, detail: resolved }
      restore = async () => {
        undici.setGlobalDispatcher(base)
        router = undefined
        engine = { available: false, reason: '已卸载' }
        await candidate.close()
      }
      log(ctx, 'info', `proxy routing installed (undici: ${resolved})`)
      void candidate.sweep()
    })().catch((error) => {
      engine = {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      }
      log(ctx, 'warn', `proxy routing unavailable: ${engine.reason}`)
    })
    return async () => {
      disposed = true
      if (restore) await restore()
    }
  }, 'proxy-settings: routing dispatcher')

  ctx.inject(['webServer'], (webCtx) => {
    // Trust rules for the settings route. The route is reachable by every local process, so
    // the browser-facing attacks are closed here: a forged `Host` (DNS rebinding) and a
    // cross-site write (a `text/plain` "simple request" needs no preflight) are both refused.
    const allowedHosts = new Set()
    try {
      const origin = new URL(webCtx.webServer.getOrigin())
      const port = origin.port || (origin.protocol === 'https:' ? '443' : '80')
      allowedHosts.add(origin.host.toLowerCase())
      for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
        allowedHosts.add(`${name}:${port}`)
        if (port === '80' || port === '443') allowedHosts.add(name)
      }
    } catch {
      // A missing origin leaves the set empty; every request is then refused rather than trusted.
    }
    const trustFailure = (req) => {
      const host = String(req.headers.host ?? '').toLowerCase()
      if (!allowedHosts.has(host)) return 'host'
      const site = req.headers['sec-fetch-site']
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return 'cross-site'
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin !== '') {
        try {
          if (!allowedHosts.has(new URL(origin).host.toLowerCase())) return 'origin'
        } catch {
          return 'origin'
        }
      }
      return undefined
    }
    const handler = async (req, res) => {
      try {
        const refusal = trustFailure(req)
        if (refusal !== undefined) {
          log(ctx, 'warn', `proxy settings request refused (${refusal})`)
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === API_PATH) {
          if (req.method === 'GET' || req.method === 'HEAD') {
            sendJson(res, 200, snapshot(ctx, store, engine, router))
            return
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
            if (!contentType.startsWith('application/json')) {
              // A non-JSON content type is what a browser can send cross-site without a
              // preflight; requiring JSON forces one, which this route does not answer.
              sendJson(res, 415, { ok: false, error: 'content-type 必须是 application/json' })
              return
            }
            let body
            try {
              body = await readJsonBody(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : '无效的 JSON' })
              return
            }
            const validated = validateSettings(body)
            if (validated.error) {
              sendJson(res, 400, { ok: false, error: validated.error })
              return
            }
            // Passwords never travel back to the browser: an omitted one keeps the stored value,
            // and `clearPassword` is the only way to remove it.
            const current = store.read()
            for (const proxy of validated.settings.proxies) {
              if (validated.clears.has(proxy.id)) {
                proxy.password = ''
                continue
              }
              if (proxy.password === '') {
                const previous = current.proxies.find((entry) => entry.id === proxy.id)
                if (previous) proxy.password = previous.password
              }
            }
            store.write(validated.settings)
            router?.prune()
            void router?.sweep()
            sendJson(res, 200, snapshot(ctx, store, engine, router))
            return
          }
          sendJson(res, 405, { ok: false, error: '只支持 GET 与 POST' })
          return
        }
        if (url.pathname === TEST_PATH) {
          const target = url.searchParams.get('url') || 'https://api.deepseek.com/'
          const parsedTarget = safeUrl(target)
          if (!parsedTarget || (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:')) {
            sendJson(res, 400, { ok: false, error: '只支持 http:// 或 https:// 测试地址' })
            return
          }
          if (isPrivateTarget(parsedTarget)) {
            // Without this the endpoint is a blind SSRF primitive against loopback and LAN.
            sendJson(res, 400, { ok: false, error: '测试地址不能指向本机或内网' })
            return
          }
          const workspaceId = url.searchParams.get('workspaceId')
          const proxyId = url.searchParams.get('proxyId')
          const workspace = workspaceId
            ? workspaceList(ctx).find((entry) => entry.id === workspaceId)
            : undefined
          if (workspaceId && !workspace) {
            sendJson(res, 404, { ok: false, error: '工作区不存在' })
            return
          }
          const forcedProxy = proxyId
            ? store.read().proxies.find((proxy) => proxy.id === proxyId)
            : undefined
          if (proxyId && !forcedProxy) {
            sendJson(res, 404, { ok: false, error: '代理不存在' })
            return
          }
          if (!router) {
            sendJson(res, 200, {
              ok: false,
              via: 'engine-unavailable',
              error: engine.reason,
              route: { reason: 'engine-unavailable' },
            })
            return
          }
          const route = router.withProxy(forcedProxy, () =>
            router.inspect(target, forcedProxy ? undefined : workspace?.path),
          )
          if (forcedProxy) router.setHealth(forcedProxy.id, await checkProxy(forcedProxy))
          try {
            const result = await probe(router, target, workspace?.path, forcedProxy)
            sendJson(res, 200, {
              ok: true,
              via: route.proxy ? 'proxy' : 'direct',
              route: {
                reason: route.reason,
                proxyName: route.proxy?.name ?? route.proxyName,
                workspace: route.workspace,
              },
              health: forcedProxy ? router.health.get(forcedProxy.id) : undefined,
              status: result.status,
              ms: result.ms,
            })
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              via: route.proxy ? 'proxy' : 'direct',
              route: { reason: route.reason, proxyName: route.proxy?.name ?? route.proxyName },
              health: forcedProxy ? router.health.get(forcedProxy.id) : undefined,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }
        sendJson(res, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        log(ctx, 'warn', `proxy settings request failed: ${error instanceof Error ? error.message : String(error)}`)
        try {
          sendJson(res, 500, { ok: false, error: 'internal-error' })
        } catch {
          // The response may already be closed.
        }
      }
    }
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }),
      'proxy-settings: settings route',
    )
    log(ctx, 'info', `proxy settings API on ${API_PATH}`)
  })

  log(ctx, 'info', `settings file: ${file}`)
}
