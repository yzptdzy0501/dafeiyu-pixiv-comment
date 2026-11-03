/**
 * lib/toolset.mjs —— 12 个 DSH 工具：策略闸门都在这里
 * ============================================================================
 * 分工：
 *   Python MCP  = 网络 + 字节（登录、搜索、详情、下载、正文、校验）
 *   这一层      = 命名、目录、额度、分级、去重、metadata、报告
 *
 * 为什么额度/分级/去重必须在工具里拦：提示词只能"告诉"模型怎么做。
 * 一旦作品简介里写了"忽略之前的设定"，模型可能被带走 —— 但 `pixivc_save` 仍然会拒。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { McpClient } from './mcp.mjs'
import { loadCfg, resolveSaveRoot, resolveCredentialDir } from './config.mjs'
import { dayKey, readJson, writeJson, appendLog } from './state.mjs'
import { lookup, appendEntry, savedOn } from './seen.mjs'
import { saveWork, probeDir, freeBytes, estimateBytes, verifySaved } from './save.mjs'
import { appendFavorite, readFavorites, workUrl } from './favorites.mjs'

/** 本轮是什么任务：scroll（刷图）/ comment（单独评论）。由 runner 写进环境变量。 */
const MODE = String(process.env.PIXIV_COMMENT_MODE || 'scroll').trim().toLowerCase() || 'scroll'

const MCP_TOOLS = ['px_auth', 'px_search', 'px_detail', 'px_fetch', 'px_novel', 'px_tags', 'px_verify', 'px_comment', 'px_comment_list']

/** 白名单随轮次下发；没写就全给 */
function mcpEnv(home, cfg, allow = MCP_TOOLS) {
  const env = {
    PIXIV_COMMENT_HOME: home,
    PIXIV_CREDENTIAL_FILE: join(resolveCredentialDir(cfg, home), 'credential.json'),
    PIXIV_CACHE_DIR: join(home, 'cache'),
    PIXIV_MCP_TOOLS: allow.join(','),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  // 代理：这台机器上 Pixiv 直连不通，必须走本地代理。
  // ⚠️ requests 读的是环境里**最后出现**的那个键，且大小写都认 ——
  //    父进程里的小写 https_proxy（沙箱那条，对 pixiv 返 502）会把大写覆盖掉，
  //    所以四个键一起写。
  const proxy = String(cfg?.proxyUrl || '').trim()
  if (proxy) {
    env.HTTP_PROXY = proxy; env.http_proxy = proxy
    env.HTTPS_PROXY = proxy; env.https_proxy = proxy
    env.ALL_PROXY = proxy; env.all_proxy = proxy
    env.NO_PROXY = '127.0.0.1,localhost'; env.no_proxy = '127.0.0.1,localhost'
  } else {
    // 不要继承沙箱那条对 pixiv 返 502 的代理
    env.HTTP_PROXY = ''; env.http_proxy = ''
    env.HTTPS_PROXY = ''; env.https_proxy = ''
    env.ALL_PROXY = ''; env.all_proxy = ''
  }
  return env
}

const safe = (v) => JSON.parse(JSON.stringify(v))

/** 存好一件后自动打开它的文件夹（失败不抛：这只是便利功能） */
function openFolder(dir) {
  try {
    if (process.platform === 'win32') spawn('explorer', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch { return false }
}

class ToolError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** 一轮的计数器（落盘，进程重启也不丢；**按 roundId 隔离**） */
function roundState(home) {
  const f = join(home, 'state.json')
  const st = readJson(f, {})
  return { file: f, st }
}

/** 换了轮次就把计数清零 —— 否则上一轮用掉的预算会一直压着这一轮 */
function ensureRound(st, roundId) {
  if (!st.round || st.round.id !== roundId) {
    st.round = { id: roundId, startedAt: new Date().toISOString(), counters: {} }
  }
  if (!st.round.counters) st.round.counters = {}
  return st.round
}

function bumpCounter(home, field, by = 1, roundId = 'manual') {
  const { file, st } = roundState(home)
  const round = ensureRound(st, roundId)
  round.counters[field] = Number(round.counters[field] || 0) + by
  st.round = round
  try { writeJson(file, st) } catch { /* 忽略 */ }
  return round.counters[field]
}

function counterOf(home, field, roundId = 'manual') {
  const { st } = roundState(home)
  if (st.round?.id !== roundId) return 0
  return Number(st.round?.counters?.[field] || 0)
}

/** 中文判定：language → 汉字占比 → 标签 */
export function judgeChinese(detail, sampleText, cfg) {
  const mode = cfg.zhMode
  if (mode === 'off') return { zh: true, why: '未启用中文判定' }
  const tags = (detail.tags || []).map((t) => `${t.name} ${t.translated || ''}`.toLowerCase())
  const tagHit = tags.find((t) => /中文|中国语|中国語|漢化|汉化|翻译|翻譯|简体|繁體|繁体/.test(t))
  if (mode === 'tag') return tagHit ? { zh: true, why: `标签命中：${tagHit}` } : { zh: false, why: '标签里没有中文标记' }
  if (detail.language === 'zh') return { zh: true, why: 'language=zh' }
  if (mode === 'language') return { zh: false, why: `language=${detail.language || 'unknown'}` }

  const text = String(sampleText || '')
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length
  const ratio = text.length ? han / text.length : 0
  if (kana / Math.max(1, text.length) > 0.05) return { zh: false, why: `假名占比 ${(kana / text.length * 100).toFixed(1)}%` }
  if (ratio >= cfg.zhRatio) return { zh: true, why: `汉字占比 ${(ratio * 100).toFixed(0)}%` }
  if (mode === 'auto' && tagHit) return { zh: true, why: `标签命中：${tagHit}` }
  return { zh: false, why: `汉字占比仅 ${(ratio * 100).toFixed(0)}%（阈值 ${(cfg.zhRatio * 100).toFixed(0)}%）` }
}

/** 偏好打分（只用于报告与排序，不做硬过滤） */
export function scoreItem(item, cfg) {
  const weights = new Map()
  for (const line of String(cfg.tagWeights || '').split(/\r?\n/)) {
    const m = /^(.+?)\s*[=:：]\s*(-?\d+(?:\.\d+)?)$/.exec(line.trim())
    if (m) weights.set(m[1].trim().toLowerCase(), Number(m[2]))
  }
  const tags = (item.tags || []).map((t) => `${t.name}`.toLowerCase())
  let score = 0
  const matched = []
  for (const [tag, w] of weights) {
    if (tags.some((t) => t.includes(tag))) { score += w; matched.push(tag) }
  }
  for (const kw of cfg.keywords) {
    const k = kw.toLowerCase()
    if (tags.some((t) => t.includes(k))) { score += 1; matched.push(kw) }
  }
  if (Number(item.bookmarks) > 1000) score += 0.5
  return { score, matched }
}

/** 硬过滤：内容类型 / 分级 / 必须标签 / 排除标签 / 收藏数区间 */
function filterItems(items, cfg) {
  const out = []
  const dropped = []
  const req = cfg.requiredTags.map((s) => s.toLowerCase())
  const exc = cfg.excludeTags.map((s) => s.toLowerCase())
  for (const it of items) {
    const tags = (it.tags || []).map((t) => `${t.name} ${t.translated || ''}`.toLowerCase())
    if (it.kind === 'illust' && !cfg.contentIllust) { dropped.push({ id: it.id, why: 'content:illust' }); continue }
    if (it.kind === 'manga' && !cfg.contentManga) { dropped.push({ id: it.id, why: 'content:manga' }); continue }
    if (it.kind === 'novel' && !cfg.contentNovel) { dropped.push({ id: it.id, why: 'content:novel' }); continue }
    if (!cfg.allowR18 && it.rating !== 'all') { dropped.push({ id: it.id, why: 'r18' }); continue }
    if (req.length && !req.every((t) => tags.some((x) => x.includes(t)))) { dropped.push({ id: it.id, why: 'required-tags' }); continue }
    if (exc.length && exc.some((t) => tags.some((x) => x.includes(t)))) { dropped.push({ id: it.id, why: 'excluded-tag' }); continue }
    const bm = Number(it.bookmarks ?? 0)
    if (cfg.bookmarkMin > 0 && bm < cfg.bookmarkMin) { dropped.push({ id: it.id, why: 'bookmark-min' }); continue }
    if (cfg.bookmarkMax > 0 && bm > cfg.bookmarkMax) { dropped.push({ id: it.id, why: 'bookmark-max' }); continue }
    out.push(it)
  }
  return { out, dropped }
}

/**
 * 创建工具集。
 * @param {object} o
 * @param {object} o.ctx          DSH 上下文（只需 tools）
 * @param {Function} o.defineTool 宿主的 defineTool（或本地等价实现）
 * @param {string} o.home         插件家目录
 * @param {string} o.roundId      本轮 id（host 手动调用时可为 'manual'）
 * @param {object} o.log          日志函数
 */
export function createToolset({ ctx, defineTool, home, roundId = 'manual', log = () => {} }) {
  let client = null
  let cfgCache = null
  let cfgAt = 0

  const freshCfg = () => {
    if (!cfgCache || Date.now() - cfgAt > 3000) {
      cfgCache = loadCfg(home)
      cfgAt = Date.now()
    }
    return cfgCache
  }

  const invalidateCfg = () => { cfgCache = null }

  function ensureMcp() {
    if (client) return client
    const cfg = freshCfg()
    const py = cfg.pythonPath || 'python'
    const args = [join(home, 'mcp_server.py')]
    client = new McpClient({
      command: py,
      args,
      cwd: home,
      env: mcpEnv(home, cfg),
      log: (m) => log(`[mcp] ${m}`),
    })
    return client
  }

  async function callPx(name, args = {}, timeoutMs = 180000) {
    const c = ensureMcp()
    const res = await c.call(name, args, { timeoutMs })
    if (res && typeof res === 'object' && res.ok === false) {
      throw new ToolError(res.code || 'MCP_FAILED', res.message || 'MCP 调用失败')
    }
    return res
  }

  function stop() {
    try { client?.stop() } catch { /* 已退出 */ }
    client = null
  }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
  }

  const reg = (spec) => ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters || {},
    output: spec.output || textOutput,
    timeoutMs: spec.timeoutMs ?? 240000,
    async execute(args, exec) {
      try {
        return safe(await spec.execute(args || {}, exec))
      } catch (e) {
        const code = e?.code || 'UNKNOWN'
        log(`工具 ${spec.name} 失败：${code} ${e?.message || e}`)
        return safe({ ok: false, code, message: String(e?.message || e).slice(0, 500) })
      }
    },
  }))

  /* ───────────────────────── pixivc_status ───────────────────────── */
  reg({
    name: 'pixivc_status',
    description: '一轮开场总览：登录态、额度、保存目录、环境、本轮预算。先调这个。',
    parameters: {},
    async execute() {
      const cfg = freshCfg()
      const root = resolveSaveRoot(cfg, home)
      let auth = { state: 'none' }
      let mcpReady = false
      try {
        auth = await callPx('px_auth', { action: 'status' }, 60000)
        mcpReady = true
      } catch (e) {
        auth = { state: 'error', message: String(e?.message || e).slice(0, 200) }
      }
      const probe = probeDir(root)
      const used = savedOn(home)
      const { st } = roundState(home)
      return {
        ok: true,
        version: '1.0.0',
        auth: {
          state: auth.state, loggedIn: auth.state === 'ok',
          userId: auth.userId ?? null, pixivId: cfg.pixivId || auth.pixivId || null,
        },
        env: {
          mcpReady, python: cfg.pythonPath,
          saveRoot: root, saveRootWritable: probe.ok, freeGB: probe.free ? +(probe.free / 1e9).toFixed(1) : null,
          error: probe.ok ? null : probe.error,
        },
        today: { saved: used, quota: cfg.perDay, left: Math.max(0, cfg.perDay - used) },
        round: {
          id: roundId,
          startedAt: st.round?.id === roundId ? st.round.startedAt : null,
          counters: st.round?.id === roundId ? (st.round.counters || {}) : {},
          unfinished: st.unfinished ?? null,
        },
        config: {
          content: [cfg.contentIllust && 'illust', cfg.contentManga && 'manga', cfg.contentNovel && 'novel'].filter(Boolean),
          allowR18: cfg.allowR18,
          keywords: cfg.keywords,
          requiredTags: cfg.requiredTags,
          excludeTags: cfg.excludeTags,
          bookmarkRange: { min: cfg.bookmarkMin, max: cfg.bookmarkMax },
          days: cfg.daysOn ? cfg.days : 0,
          daysEnabled: cfg.daysOn,
          novelMode: cfg.novelMode,
          novelVibe: cfg.novelVibe || null,
          novelVibeMin: cfg.novelVibeMin,
          zhMode: cfg.zhMode,
          dirTemplate: cfg.dirTemplate,
          openAfterSave: cfg.openAfterSave,
        },
        limits: {
          perRound: Math.min(cfg.perRound, Math.max(0, cfg.perDay - used)),
          maxCandidates: cfg.maxCandidates,
          maxImages: cfg.maxImages,
          maxPagesPerWork: cfg.maxPagesPerWork,
        },
        paths: {
          home,
          cache: join(home, 'cache'),
          ledger: join(home, 'ledger.jsonl'),
          report: join(home, 'out', `${dayKey()}.md`),
        },
      }
    },
  })

  /* ───────────────────────── pixivc_login_status ───────────────────────── */
  reg({
    name: 'pixivc_login_status',
    description: '查登录态（会尝试刷新一次 token）。返回 state / userId / expiresInMin。',
    parameters: {},
    async execute() {
      const r = await callPx('px_auth', { action: 'status' }, 60000)
      return { ok: true, ...r }
    },
  })

  /* ───────────────────────── pixivc_search ───────────────────────── */
  reg({
    name: 'pixivc_search',
    description: '批量搜索（1–3 个查询一次返回，返回紧凑元数据，不含图片 URL）。自动按内容类型/分级/必须标签/排除标签/收藏数过滤。',
    parameters: {
      queries: { type: 'array', required: true, items: { type: 'string' }, description: '1–3 个搜索词（标签用空格表示 AND）' },
      kind: { type: 'string', enum: ['illust', 'manga', 'novel', 'all'], description: '内容类型，默认 all' },
      days: { type: 'number', description: '只看最近几天，默认取配置' },
      limit: { type: 'number', description: '每个查询最多几条，默认 20' },
      sort: { type: 'string', enum: ['date_desc', 'date_asc', 'popular_desc'], description: '排序' },
    },
    async execute({ queries, kind = 'all', days, limit = 20, sort = 'date_desc' }) {
      const cfg = freshCfg()
      const qs = (Array.isArray(queries) ? queries : [queries]).filter(Boolean).slice(0, 3)
      if (!qs.length) return { ok: false, code: 'BAD_REQUEST', message: 'queries 不能为空' }
      const used = counterOf(home, 'candidates', roundId)
      const budget = Math.max(0, cfg.maxCandidates - used)
      if (budget <= 0) return { ok: false, code: 'BUDGET', message: '本轮的候选元数据预算用完了' }
      const res = await callPx('px_search', {
        queries: qs.join('||'),
        kind,
        // 时间窗关掉时传 0 ⇒ MCP 不带任何日期参数（不限发布时间）
        days: cfg.daysOn ? Number(days ?? cfg.days) : 0,
        limit: Math.min(30, Math.max(1, Number(limit))),
        sort,
      })
      const { out, dropped } = filterItems(res.items || [], cfg)
      bumpCounter(home, 'candidates', out.length, roundId)
      return {
        ok: true,
        cached: Boolean(res.cached),
        items: out.slice(0, budget).map((it) => ({
          ...it,
          score: scoreItem(it, cfg).score,
        })),
        dropped: dropped.slice(0, 40),
        byQuery: res.byQuery ?? [],
        note: out.length ? undefined : '这一批没有通过过滤的；换关键词，或放宽 minBookmarks',
      }
    },
  })

  /* ───────────────────────── pixivc_inspect ───────────────────────── */
  reg({
    name: 'pixivc_inspect',
    description: '批量作品详情（≤12 个 id）。返回完整元数据、是否已存、评分线索；不含图片 URL。kind=novel 时只查小说库（插画/小说 id 会撞号）',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'number' }, description: '作品 id 列表（≤12）' },
      kind: { type: 'string', enum: ['auto', 'novel', 'illust'], description: '按哪个命名空间查；默认 auto（先插画后小说）' },
    },
    async execute({ ids, kind = 'auto' }) {
      const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite).slice(0, 12)
      if (!arr.length) return { ok: false, code: 'BAD_REQUEST', message: 'ids 不能为空' }
      const res = await callPx('px_detail', { ids: arr.join(','), kind })
      const cfg = freshCfg()
      const known = lookup(home, res.items || [], cfg.revisitDays)
      const saved = new Map(known.known.map((k) => [`${k.kind}:${k.id}`, k]))
      const items = (res.items || []).map((it) => {
        const hit = saved.get(`${it.kind}:${it.id}`) || saved.get(`illust:${it.id}`) || saved.get(`manga:${it.id}`)
        const { _pageUrls, ...rest } = it
        return {
          ...rest,
          score: scoreItem(it, cfg).score,
          saved: hit ? { saved: hit.action === 'saved', dir: hit.dir, at: hit.savedAt } : { saved: false },
        }
      })
      return { ok: true, items, errors: res.errors ?? [] }
    },
  })

  /* ───────────────────────── pixivc_prepare ───────────────────────── */
  reg({
    name: 'pixivc_prepare',
    description: '把缩图下到本地缓存并返回路径（供 read_image 读）。每件默认取封面+前 2 页；受 maxImages 预算约束。',
    parameters: {
      items: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false, properties: {
            id: { type: 'number', required: true },
            pages: { type: 'array', items: { type: 'number' } },
          },
        },
        description: '最多 3 件；pages 省略则取前 3 页',
      },
      maxEdge: { type: 'number', description: '缩图长边上限，默认 1536' },
    },
    async execute({ items, maxEdge = 1536 }) {
      const cfg = freshCfg()
      const list = (Array.isArray(items) ? items : []).slice(0, 3)
      if (!list.length) return { ok: false, code: 'BAD_REQUEST', message: 'items 不能为空' }
      const imgs = counterOf(home, 'images', roundId)
      const budget = Math.max(0, cfg.maxImages - imgs)
      if (budget <= 0) return { ok: false, code: 'BUDGET', message: `本轮读图预算（${cfg.maxImages} 张）用完了` }
      const trimmed = list.map((it) => ({
        id: Number(it.id),
        pages: Array.isArray(it.pages) ? it.pages.slice(0, Math.min(3, budget)) : undefined,
      }))
      const res = await callPx('px_fetch', {
        items: JSON.stringify(trimmed),
        variant: 'view',
        maxEdge: Math.min(2048, Math.max(512, Number(maxEdge))),
        defaultPages: Math.min(3, budget),
      })
      let n = 0
      for (const it of res.items || []) n += (it.files || []).length
      bumpCounter(home, 'images', n, roundId)
      return { ok: true, items: res.items || [], usedImages: imgs + n, maxImages: cfg.maxImages }
    },
  })

  /* ───────────────────────── 小说三件套 ───────────────────────── */
  reg({
    name: 'pixivc_novel_outline',
    description: '小说骨架：字数、段落数、章节、语言、开头 800 字。判断要不要读、读哪儿。',
    parameters: { id: { type: 'number', required: true, description: '小说 id' } },
    async execute({ id }) {
      const res = await callPx('px_novel', { id: Number(id), action: 'outline' }, 120000)
      const detail = await callPx('px_detail', { ids: String(id) }, 60000).catch(() => ({ items: [] }))
      const meta = detail.items?.[0] || {}
      const zh = judgeChinese(meta, res.head, freshCfg())
      return { ...res, chinese: zh }
    },
  })

  reg({
    name: 'pixivc_novel_read',
    description: '按段落读正文：fromBlock 起读 blocks 段（≤60）。用来补选段的上下文。',
    parameters: {
      id: { type: 'number', required: true },
      fromBlock: { type: 'number', description: '起始段落序号，默认 0' },
      blocks: { type: 'number', description: '读多少段，默认 20，最多 60' },
    },
    async execute({ id, fromBlock = 0, blocks = 20 }) {
      return callPx('px_novel', {
        id: Number(id), action: 'read',
        fromBlock: Number(fromBlock), blocks: Math.min(60, Number(blocks)),
      }, 120000)
    },
  })

  reg({
    name: 'pixivc_novel_pick',
    description: '按关键词挑最相关段落（返回段落序号、命中词、正文）。长篇选段就用它。',
    parameters: {
      id: { type: 'number', required: true },
      terms: { type: 'array', required: true, items: { type: 'string' }, description: '相关性关键词（来自用户偏好/标签）' },
      blocks: { type: 'number', description: '最多几段，默认 6' },
      context: { type: 'number', description: '每段带前后几段，默认 0' },
    },
    async execute({ id, terms, blocks = 6, context = 0 }) {
      return callPx('px_novel', {
        id: Number(id), action: 'pick',
        terms: (terms || []).join(','),
        blocks: Math.min(20, Number(blocks)),
        context: Math.min(3, Number(context)),
      }, 120000)
    },
  })

  /* ───────────────────────── pixivc_novel_vibe ───────────────────────── */
  reg({
    name: 'pixivc_novel_vibe',
    description: '按「小说正文模糊偏好」比对正文：返回匹配度（0–1）、命中的词片与最相关段落。保存前想确认合不合口味就用它。',
    parameters: {
      id: { type: 'number', required: true, description: '小说 id' },
      vibe: { type: 'string', description: '自然语言场景描述；省略则用设置里的偏好' },
      blocks: { type: 'number', description: '返回几段最相关的，默认 6' },
    },
    async execute({ id, vibe, blocks = 6 }) {
      const cfg = freshCfg()
      const text = String(vibe || cfg.novelVibe || '').trim()
      if (!text) return { ok: false, code: 'NO_VIBE', message: '设置里没有填小说正文偏好' }
      const r = await callPx('px_novel', {
        id: Number(id), action: 'vibe', vibe: text, blocks: Math.min(12, Math.max(1, Number(blocks))),
      }, 180000)
      return { ...r, threshold: cfg.novelVibeMin, pass: Number(r.score ?? 0) >= cfg.novelVibeMin }
    },
  })


  /* ───────────────────────── pixivc_seen ───────────────────────── */
  reg({
    name: 'pixivc_seen',
    description: '批量判重（≤50 个 id）。known 里 action=saved 的不要再存；action=skipped 且在冷却期内的也别重复看。',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'number' } },
      kinds: { type: 'array', items: { type: 'string' }, description: '可选：与 ids 对应的类型' },
    },
    async execute({ ids, kinds }) {
      const cfg = freshCfg()
      const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite).slice(0, 50)
      const items = arr.map((id, i) => ({ id, kind: kinds?.[i] }))
      const r = lookup(home, items, cfg.revisitDays)
      return { ok: true, ...r, revisitDays: cfg.revisitDays }
    },
  })

  /* ───────────────────────── pixivc_report ───────────────────────── */
  reg({
    name: 'pixivc_report',
    description: '写当日报告（追加，不覆盖）。每条第一行固定 `### <kind>:<id>`。',
    parameters: {
      summary: { type: 'string', required: true, description: '两三句总结：看了几条、存了几条、跳过几条' },
      entries: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false, properties: {
            id: { type: 'number', required: true },
            kind: { type: 'string', required: true },
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            saved: { type: 'boolean', required: true },
            dir: { type: 'string' },
            reason: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
    },
    async execute({ summary, entries }) {
      const day = dayKey()
      const file = join(home, 'out', `${day}.md`)
      const lines = []
      const fresh = !existsSync(file)
      if (fresh) {
        lines.push(`# Pixiv 日报 · ${day}`, '')
      }
      lines.push(`<!-- round ${roundId} @ ${new Date().toISOString()} -->`)
      lines.push('', String(summary || '').trim(), '')
      for (const e of entries || []) {
        lines.push(`### ${e.kind}:${e.id}`)
        lines.push(`- 标题：${e.title}`)
        lines.push(`- 链接：${e.url}`)
        if (e.saved) lines.push(`- 已存：\`${e.dir || ''}\``)
        else lines.push(`- 未存：${e.note || e.reason || ''}`)
        if (e.reason) lines.push(`- 理由：${e.reason}`)
        lines.push('')
      }
      const text = lines.join('\n')
      mkdirSync(join(home, 'out'), { recursive: true })
      appendFileSync(file, text, 'utf8')
      return { ok: true, file, bytes: Buffer.byteLength(text) }
    },
  })

  /* ───────────────────────── pixivc_tag_suggest ───────────────────────── */
  reg({
    name: 'pixivc_tag_suggest',
    description: '按种子词看相邻标签（带翻译与出现次数），用于扩展或收敛偏好。',
    parameters: {
      seed: { type: 'string', required: true },
      limit: { type: 'number', description: '默认 12' },
    },
    async execute({ seed, limit = 12 }) {
      return callPx('px_tags', { seed: String(seed), limit: Math.min(30, Number(limit)) }, 90000)
    },
  })

  /* ───────────────────────── pixivc_comment ───────────────────────── */
  reg({
    name: 'pixivc_comment',
    description: '给刚存下的作品写一句评语。默认只存本地（comments.jsonl）；只有设置里开了「真的发出去」且 post=true 时才会发到 Pixiv 评论区。',
    parameters: {
      id: { type: 'number', required: true },
      text: { type: 'string', required: true, description: '一句中文评语，15–40 字，具体、真诚、不剧透' },
      kind: { type: 'string', description: 'illust / manga / novel；默认 auto' },
      post: { type: 'boolean', description: '是否真的发出去（还要设置里那个开关也开着，并受每日上限约束）' },
    },
    async execute({ id, text, kind = 'auto', post = false }) {
      const cfg = freshCfg()
      if (!cfg.commentEnabled) {
        return { ok: false, blocked: true, code: 'COMMENT_DISABLED', hint: '设置 → 刷Pixiv → Pixiv 评论：「评论功能总开关」是关的' }
      }
      const wantPost = Boolean(post) && Boolean(cfg.commentPost)
      const r = await callPx('px_comment', {
        id: Number(id),
        text: String(text || ''),
        kind: String(kind || 'auto'),
        post: wantPost,
      }, 90000)
      log(`评语 id=${id} posted=${r?.posted ?? false}${r?.postError ? ` 失败：${r.postError}` : ''}`)
      // `cap` 是「真发出去」的每日上限，跟「今天能写几条」不是一回事。
      // 原样回给模型会被误读成"额度用完了"，所以改名成 postCap 说清楚。
      const { cap, ...rest } = r || {}
      const out = { ...rest, postCap: cap, posted: Boolean(r?.posted), local: r?.local !== false }
      // 单独评论任务：顺手提醒把「真的优秀」的记进精选表（刷图轮会优先挑）
      if (MODE === 'comment' && cfg.commentFavorites) {
        const url = workUrl(kind === 'auto' ? 'illust' : kind, id)
        return {
          ...out,
          commentRequired: false,
          favoriteCheck: `这件如果值 4 分或以上（构图/表情/细节让你想再看一遍），现在就调用 pixivc_favorite（id=${id}，kind=${kind === 'auto' ? 'illust' : kind}，score=4 或 5，reason=一句话，url=${url}）；低于 4 分才允许跳过。`,
        }
      }
      return out
    },
  })

  /* ───────────────────────── pixivc_comments ───────────────────────── */
  reg({
    name: 'pixivc_comments',
    description: '看本地已经写过的评语（可按作品 id 过滤），排查"到底存没存"。',
    parameters: {
      id: { type: 'number', description: '作品 id；省略 = 全部' },
      limit: { type: 'number', description: '默认 20' },
    },
    async execute({ id = 0, limit = 20 }) {
      return callPx('px_comment_list', { id: Number(id) || 0, limit: Number(limit) || 20 }, 60000)
    },
  })

  /* ───────────────────────── pixivc_favorite ───────────────────────── */
  reg({
    name: 'pixivc_favorite',
    description: '把一件优秀作品记进精选表（favorites.jsonl，带网址）。刷图轮会优先从精选表里挑，所以只记真的值得再看的。',
    parameters: {
      id: { type: 'number', required: true },
      kind: { type: 'string', description: 'illust / manga / novel；默认 illust' },
      score: { type: 'number', description: '1–5，5 = 最想再看到' },
      reason: { type: 'string', description: '好在哪：一句话，具体' },
      title: { type: 'string', description: '可选；不填就留空' },
      artist: { type: 'string', description: '可选；画师名' },
      rating: { type: 'string', description: '可选：all / r18' },
      comment: { type: 'string', description: '可选：刚写的评语，一起存下来' },
      url: { type: 'string', description: '可选；省略 = 按 id 自动生成作品网址' },
    },
    async execute({ id, kind = 'illust', score = 4, reason = '', title = '', artist = '', rating = '', comment = '', url = '' }) {
      const cfg = freshCfg()
      if (!cfg.commentFavorites) {
        return { ok: false, blocked: true, code: 'FAVORITES_OFF', hint: '设置 → 刷Pixiv → Pixiv 评论：「记录优秀作品」是关的' }
      }
      const r = appendFavorite(home, { id, kind, score, reason, title, artist, rating, comment, url })
      if (!r.ok) return { ok: false, blocked: true, code: 'FAVORITE_WRITE_FAILED', hint: r.error }
      // 与刷图插件共用登录态时，也把精选记进它的表 —— 刷图轮的【优先候选】读的是那一份
      const credDir = resolveCredentialDir(cfg, home)
      let mirrored = null
      if (credDir !== home) {
        try {
          const m = appendFavorite(credDir, { id, kind, score, reason, title, artist, rating, comment, url })
          if (m?.ok) mirrored = m.file
        } catch { /* 共用表写不进去也不影响本地记录 */ }
      }
      log(`精选 id=${id} kind=${kind} score=${r.row.score}`)
      return { ok: true, saved: true, row: r.row, file: r.file, ...(mirrored ? { mirrored } : {}) }
    },
  })

  /* ───────────────────────── pixivc_favorites ───────────────────────── */
  reg({
    name: 'pixivc_favorites',
    description: '看精选表（评论时记下的优秀作品，含网址）。刷图时可以拿这份当优先候选。',
    parameters: {
      limit: { type: 'number', description: '默认 20，按分数从高到低' },
      kind: { type: 'string', description: '只看某一类：illust / novel；省略 = 全部' },
    },
    async execute({ limit = 20, kind = '' }) {
      const rows = readFavorites(home, { limit: Math.max(1, Math.min(200, Number(limit) || 20)), kind })
      return {
        ok: true,
        count: rows.length,
        file: join(home, 'favorites.jsonl'),
        rows: rows.map((r) => ({
          id: r.id, kind: r.kind, score: r.score, title: r.title, artist: r.artist,
          rating: r.rating, url: r.url || workUrl(r.kind, r.id), reason: r.reason, comment: r.comment, ts: r.ts,
        })),
      }
    },
  })

  return { stop, restart: () => { stop(); ensureMcp() }, invalidateCfg, ensureMcp }
}
