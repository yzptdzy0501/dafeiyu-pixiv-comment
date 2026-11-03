/**
 * lib/wall.mjs —— 本地评论墙的「遥控器」
 * ============================================================================
 * 评论墙本体是 tools/comment-wall.mjs（零依赖的小 HTTP 服务，只监听 127.0.0.1）。
 * 这里只做四件事：算出它的地址、看它活着没、按需把它拉起来、把评语推过去。
 *
 * 为什么不把墙塞进宿主进程里：
 *   · 宿主进程重启/刷新时墙不该跟着断，独立进程更稳；
 *   · 墙是给人翻看的界面，跟 DSH 的 HTTP 鉴权无关，单独端口最省事。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const DEFAULT_URL = 'http://127.0.0.1:7878'

/** 规范化地址：去掉末尾斜杠，空则用默认值 */
export function wallBase(cfg) {
  const raw = String(cfg?.wallUrl || '').trim()
  const url = (raw || DEFAULT_URL).replace(/\/+$/, '')
  return url
}

export function wallDataDir(home) {
  return join(home, 'wall')
}

export function wallUrlFor(cfg, id) {
  return `${wallBase(cfg)}/`
}

/** 健康检查（2 秒超时）。活着返回 count，否则 error */
export async function health(cfg, timeout = 2000) {
  const base = wallBase(cfg)
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { running: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    return { running: Boolean(body?.ok), count: Number(body?.count || 0), version: body?.version || '', url: base }
  } catch (e) {
    return { running: false, error: String(e?.message ?? e) }
  }
}

/** 给设置页/状态接口看的一行摘要 */
export async function wallStatus(cfg) {
  const base = wallBase(cfg)
  const enabled = Boolean(cfg?.wallEnabled)
  const h = await health(cfg)
  return {
    enabled,
    autoStart: Boolean(cfg?.wallAutoStart),
    url: `${base}/`,
    running: h.running,
    count: h.count ?? 0,
    version: h.version || '',
    error: h.running ? '' : (h.error || ''),
  }
}

function scriptPath(pluginDir) {
  return join(pluginDir, 'tools', 'comment-wall.mjs')
}

function portOf(base) {
  try { return Number(new URL(base).port || 80) } catch { return 7878 }
}

function hostOf(base) {
  try { return new URL(base).hostname || '127.0.0.1' } catch { return '127.0.0.1' }
}

/**
 * 确保评论墙在跑。已经在跑就直接返回；否则起一个脱离父进程的子进程，
 * 并等最多 5 秒确认它真的起来了。
 */
export async function startWall({ home, cfg, pluginDir, log = () => {} }) {
  const base = wallBase(cfg)
  const before = await health(cfg, 1200)
  if (before.running) return { ok: true, already: true, url: `${base}/`, count: before.count || 0 }

  const port = portOf(base)
  const bind = hostOf(base)
  const env = {
    ...process.env,
    // Electron 主进程里 process.execPath 是 DSH 本体，加这个开关它才当 node 用
    ELECTRON_RUN_AS_NODE: '1',
    WALL_HOME: wallDataDir(home),
    WALL_PORT: String(port),
    WALL_BIND: bind,
  }
  try {
    const child = spawn(process.execPath, [scriptPath(pluginDir)], {
      env, detached: true, stdio: 'ignore', windowsHide: true, cwd: pluginDir,
    })
    child.unref()
    log(`评论墙启动中：${base}/（pid=${child.pid ?? '?'}）`)
  } catch (e) {
    return { ok: false, error: `启动失败：${e?.message ?? e}` }
  }

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    const h = await health(cfg, 800)
    if (h.running) {
      log(`评论墙就绪：${base}/`)
      return { ok: true, started: true, url: `${base}/`, count: h.count || 0 }
    }
  }
  return { ok: false, error: `5 秒内没起来（端口 ${port} 可能被占用），看看 ${join(home, 'wall', 'wall.log')}` }
}

/** 把一条评语推到墙上。墙没开就返回 ok:false，不抛错、不挡评论本身。 */
export async function pushComment(cfg, record, timeout = 3000) {
  if (!cfg?.wallEnabled) return { ok: false, skipped: true, reason: 'wall-disabled' }
  const base = wallBase(cfg)
  try {
    const res = await fetch(`${base}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(timeout),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body?.ok) return { ok: false, error: body?.error || `HTTP ${res.status}` }
    return { ok: true, duplicate: Boolean(body.duplicate), count: body.count ?? null, url: `${base}/` }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
