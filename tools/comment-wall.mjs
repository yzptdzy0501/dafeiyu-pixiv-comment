#!/usr/bin/env node
/**
 * tools/comment-wall.mjs —— 本地「评论墙」
 * ============================================================================
 * 一个零依赖的小 HTTP 服务：接收插件写好的评语，存成一行行 JSON，并给出一张
 * 能直接翻看的网页。默认只监听 127.0.0.1（本机），不对外网开放。
 *
 *   GET  /                → HTML 页面（最新在上，带作品链接）
 *   GET  /api/comments    → JSON 列表（?limit=&q=）
 *   POST /api/comments    → 收一条评语（幂等：同 id 同文本 10 分钟内只存一次）
 *   GET  /api/health      → { ok, count, version }
 *
 * 环境变量（都由插件主进程传进来，也可以手动跑）：
 *   WALL_HOME  数据目录，默认 <插件家目录>/wall
 *   WALL_PORT  端口，默认 7878
 *   WALL_BIND  监听地址，默认 127.0.0.1
 * ============================================================================
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const VERSION = '1.0.0'
const PORT = Number(process.env.WALL_PORT || 7878) || 7878
const BIND = process.env.WALL_BIND || '127.0.0.1'
const HOME = process.env.WALL_HOME || join(homedir(), '.dsh', 'pixiv-comment', 'wall')
const FILE = join(HOME, 'comments.jsonl')
const MAX_BODY = 32 * 1024

mkdirSync(HOME, { recursive: true })

function readAll() {
  if (!existsSync(FILE)) return []
  const rows = []
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { rows.push(JSON.parse(t)) } catch { /* 跳过坏行 */ }
  }
  return rows
}

function sameWithinAMinute(a, b) {
  if (!a || !b) return false
  const ta = Date.parse(a.ts || '') || 0
  const tb = Date.parse(b.ts || '') || 0
  return Math.abs(ta - tb) < 10 * 60 * 1000
}

function append(row) {
  const rows = readAll()
  const dup = rows.find((r) => r.id === row.id && r.text === row.text && sameWithinAMinute(r, row))
  if (dup) return { ok: true, duplicate: true, count: rows.length }
  appendFileSync(FILE, `${JSON.stringify(row)}\n`, 'utf8')
  return { ok: true, duplicate: false, count: rows.length + 1 }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function page() {
  const rows = readAll().slice().reverse()
  const cards = rows.map((r) => {
    const title = r.title ? esc(r.title) : `作品 ${esc(r.id)}`
    const artist = r.artist ? `<span class="who">${esc(r.artist)}</span>` : ''
    const r18 = String(r.rating || '').toLowerCase().includes('18') ? '<span class="tag r18">R-18</span>' : ''
    const kindTag = `<span class="tag">${esc(r.kind || 'illust')}</span>`
    const when = esc(String(r.ts || '').replace('T', ' ').slice(0, 16))
    const link = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.url.replace(/^https?:\/\/[^/]+/, ''))}</a>` : ''
    const posted = r.posted ? '<span class="tag posted">已发到 Pixiv</span>' : ''
    return `<article>
      <header><h2>${title}</h2> ${kindTag} ${r18} ${posted} ${artist}</header>
      <p class="text">${esc(r.text)}</p>
      <footer><time>${when}</time> ${link}</footer>
    </article>`
  }).join('\n') || '<p class="empty">还没有评语。让插件跑一轮评论，或者在上面贴一条。</p>'

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>评论墙 · ${rows.length} 条</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin: 0; padding: 28px 18px 60px; background: #14161a; color: #e7e9ee;
         font: 15px/1.65 "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif }
  .wrap { max-width: 760px; margin: 0 auto }
  h1 { font-size: 20px; margin: 0 0 4px }
  .sub { color: #8a909c; font-size: 13px; margin-bottom: 22px }
  article { background: #1b1e24; border: 1px solid #262b33; border-radius: 12px;
            padding: 14px 16px; margin-bottom: 12px }
  article header { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap }
  h2 { font-size: 15px; margin: 0; font-weight: 600 }
  .who { color: #9aa1ad; font-size: 13px }
  .text { margin: 8px 0 10px; font-size: 15px }
  footer { display: flex; gap: 12px; font-size: 12px; color: #7f8794; flex-wrap: wrap }
  a { color: #6fb2ff; text-decoration: none }
  a:hover { text-decoration: underline }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: #262b33; color: #9aa1ad }
  .tag.r18 { background: #3a1f28; color: #ff9db4 }
  .tag.posted { background: #1f3326; color: #86e0a8 }
  .empty { color: #7f8794 }
  form { display: flex; gap: 8px; margin-bottom: 22px }
  input { flex: 1; background: #1b1e24; border: 1px solid #2a3038; color: #e7e9ee;
          border-radius: 8px; padding: 8px 10px; font: inherit }
  button { background: #2a3038; border: 0; color: #e7e9ee; border-radius: 8px; padding: 8px 14px; font: inherit; cursor: pointer }
</style></head><body><div class="wrap">
<h1>评论墙</h1>
<div class="sub">共 ${rows.length} 条 · 只在本机 ${esc(BIND)}:${PORT} 上 · ${esc(FILE)}</div>
<form id="f"><input id="q" placeholder="贴一条评语：id 文本，例如 151549547 这句画得真好"><button>存下</button></form>
${cards}
</div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault()
  const v = document.getElementById('q').value.trim()
  const m = v.match(/^(\\d+)\\s+([\\s\\S]+)$/)
  if (!m) { alert('格式：作品id 空格 评语'); return }
  const r = await fetch('/api/comments', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: Number(m[1]), text: m[2], kind: 'illust' }),
  })
  if (r.ok) location.reload(); else alert('没存上：' + r.status)
})
</script></body></html>`
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'GET' && path === '/') return send(res, 200, 'text/html; charset=utf-8', page())

  if (req.method === 'GET' && path === '/api/health') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, count: readAll().length, version: VERSION, file: FILE }))
  }

  if (req.method === 'GET' && path === '/api/comments') {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)))
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    let rows = readAll()
    if (q) rows = rows.filter((r) => `${r.title || ''} ${r.artist || ''} ${r.text || ''} ${r.id}`.toLowerCase().includes(q))
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, count: rows.length, rows: rows.slice(-limit).reverse() }))
  }

  if (req.method === 'POST' && path === '/api/comments') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY) { req.destroy(); send(res, 413, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '太大' })) }
    })
    req.on('end', () => {
      let body
      try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'JSON 解析失败' })) }
      const id = Number(body.id)
      const text = String(body.text || '').trim()
      if (!Number.isFinite(id) || id <= 0 || !text) {
        return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '需要 id 和 text' }))
      }
      const row = {
        ts: String(body.ts || new Date().toISOString()),
        date: String(body.date || new Date().toISOString().slice(0, 10)),
        id,
        kind: String(body.kind || 'illust'),
        title: String(body.title || ''),
        artist: String(body.artist || ''),
        url: String(body.url || ''),
        rating: String(body.rating || ''),
        text,
        posted: Boolean(body.posted),
        source: String(body.source || 'plugin'),
      }
      const r = append(row)
      log(r.duplicate ? `重复，跳过 id=${id}` : `收下 id=${id}`)
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, ...r }))
    })
    return
  }

  return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'not found' }))
})

function log(msg) {
  try { appendFileSync(join(HOME, 'wall.log'), `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch { /* 忽略 */ }
  try { writeFileSync(join(HOME, 'wall.pid'), String(process.pid), 'utf8') } catch { /* 忽略 */ }
}

server.on('error', (e) => {
  log(`启动失败：${e?.code || ''} ${e?.message || e}`)
  process.exit(e?.code === 'EADDRINUSE' ? 0 : 1)
})

server.listen(PORT, BIND, () => {
  log(`评论墙已启动 ${BIND}:${PORT}（数据 ${FILE}）`)
  // 让父进程容易确认「起来了」
  console.log(`[comment-wall] http://${BIND}:${PORT}/`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`收到 ${sig}，退出`); server.close(() => process.exit(0)) })
}
