/**
 * dsh-siyuan — 思源笔记（SiYuan）集成：宿主半场。
 *
 * 职责：
 *  1. 维护插件配置（$DSH_HOME/storages/siyuan/config.json）：思源地址、默认笔记本、
 *     工具分组开关；
 *  2. 把 API token 存进 dsh 凭据库（credential ref `SIYUAN_TOKEN`），配置页只说
 *     “是否已配置 / 来源 / 可写”，永不回显值；
 *  3. 注册 /siyuan/api/* 路由，供 Web 客户端设置页读写配置与测试连接；
 *  4. 按配置动态注册模型可调用的 `siyuan_*` 工具。
 *
 * 思源接口约定（实测 3.8.3）：全部 POST，一律返回 HTTP 200，成败只看响应体
 * `code` 字段（0 成功，非 0 失败，原因在 `msg`）；鉴权头为
 * `Authorization: Token <TOKEN>`。
 *
 * 本文件只依赖 node 内建模块：宿主进程提供 ctx.tools / ctx.webServer / ctx.credentials。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'siyuan'

/** 配置页与客户端调用的路由前缀。 */
const API_PREFIX = '/siyuan/api'
/** 存 token 的凭据引用（POSIX 环境变量名风格，兼容已有的 SIYUAN_TOKEN 环境变量）。 */
const TOKEN_REF = 'SIYUAN_TOKEN'
const DEFAULT_BASE_URL = 'http://127.0.0.1:6806'
const REQUEST_TIMEOUT_MS = 20000
/** 设置页打开时的可达性探测：短超时，思源没开也不让页面干等。 */
const PROBE_TIMEOUT_MS = 4000
/** 「测试连接」每一项的探测超时。 */
const CONNECT_TEST_TIMEOUT_MS = 8000
const MAX_BODY_BYTES = 2 * 1024 * 1024

const TOOL_GROUPS = ['read', 'write', 'daily', 'danger']

const DEFAULT_CONFIG = {
  baseUrl: DEFAULT_BASE_URL,
  defaultNotebook: '',
  tools: { read: true, write: false, daily: true, danger: false },
}

// ── 配置持久化 ──────────────────────────────────────────────────────────────

function dshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? env : path.join(os.homedir(), '.dsh')
}

function configPath() {
  return path.join(dshHome(), 'storages', 'siyuan', 'config.json')
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const groups = source.tools !== null && typeof source.tools === 'object' ? source.tools : {}
  const tools = {}
  for (const key of TOOL_GROUPS) {
    tools[key] = typeof groups[key] === 'boolean' ? groups[key] : DEFAULT_CONFIG.tools[key]
  }
  const baseUrl = typeof source.baseUrl === 'string' && source.baseUrl.trim() !== '' ? source.baseUrl.trim() : DEFAULT_BASE_URL
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    defaultNotebook: typeof source.defaultNotebook === 'string' ? source.defaultNotebook : '',
    tools,
  }
}

/**
 * 配置损坏时的告警出口。mount() 会用 ctx.logger.warn 接上；这里用回调而不是把 ctx
 * 一路透传进 readConfig，是为了让配置读写这两个纯逻辑保持可单测。
 * 同一份坏文件只提醒一次，避免每次工具调用都刷日志。
 */
let onConfigCorrupt = null
let warnedCorruptFile = ''

/** 记录一次“配置文件存在但读不出来”；同一份文件只提醒一次。 */
function reportConfigCorrupt(file, reason) {
  if (warnedCorruptFile === file) return
  warnedCorruptFile = file
  if (onConfigCorrupt === null) return
  try {
    onConfigCorrupt(file, reason)
  } catch {
    // 告警本身不得影响功能
  }
}

/**
 * 读配置。区分三种情况，不再一律静默回退默认值：
 *  - 文件不存在 → 首次运行的正常状态，直接返回默认值；
 *  - 文件存在但坏了 → 仍返回默认值保证插件可用，但必须留下明确告警（否则用户只会
 *    发现“开关全变回去了”而查不到原因）；
 *  - 其他读取错误（权限等）→ 同样告警，不伪装成没有配置。
 */
function readConfig() {
  const file = configPath()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeConfig(undefined)
    reportConfigCorrupt(file, `读取失败：${error?.message ?? String(error)}`)
    return normalizeConfig(undefined)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    reportConfigCorrupt(file, `不是合法 JSON：${error?.message ?? String(error)}`)
    return normalizeConfig(undefined)
  }
  warnedCorruptFile = '' // 内容恢复可解析，下次再坏要重新提醒
  return normalizeConfig(parsed)
}

/**
 * 原子写入配置：同目录写临时文件 → fsync → rename 覆盖。
 * 直接 writeFileSync 覆盖目标文件时，写到一半被打断会留下半个 JSON，
 * 而 readConfig 对坏文件只能回退默认值 —— 用户会静默丢掉全部设置。
 */
function writeConfig(config) {
  const target = configPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}`
  try {
    const handle = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(handle, JSON.stringify(config, null, 2) + '\n', 'utf8')
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, target)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // 临时文件没建起来或已被清掉都无所谓
    }
    throw error
  }
}

// ── 凭据 ────────────────────────────────────────────────────────────────────

/**
 * 读取 token 与它的来源信息（永不回显值）。
 * @returns {Promise<{value: string, configured: boolean, source: string, writable: boolean}>}
 */
async function tokenState(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    const ambient = process.env[TOKEN_REF]
    return {
      value: typeof ambient === 'string' ? ambient : '',
      configured: typeof ambient === 'string' && ambient !== '',
      source: typeof ambient === 'string' && ambient !== '' ? 'env' : '',
      writable: false,
    }
  }
  let source = ''
  let writable = true
  let configured = false
  try {
    const info = await credentials.describe(TOKEN_REF)
    configured = info !== undefined && info.configured === true
    source = info !== undefined && typeof info.source === 'string' ? info.source : ''
    writable = info === undefined || info.writable !== false
  } catch {
    // describe 失败时退化为直接 resolve
  }
  let value = ''
  try {
    const hit = await credentials.resolve(TOKEN_REF)
    if (hit !== undefined && typeof hit.value === 'string') {
      value = hit.value
      configured = value !== ''
      if (source === '' && typeof hit.source === 'string') source = hit.source
    }
  } catch {
    // 未配置即视为空
  }
  return { value, configured, source, writable }
}

// ── 思源 HTTP 客户端 ────────────────────────────────────────────────────────

class SiYuanError extends Error {}

/**
 * 调用思源接口。思源一律返回 HTTP 200，成功判定只看响应体 `code`。
 * @param {{baseUrl: string}} config - 已归一化的插件配置
 * @param {string} token - API token（可为空，仅公开接口可用）
 * @param {string} apiPath - 形如 /api/notebook/lsNotebooks
 * @param {object} [payload] - 请求体 JSON
 * @param {number} [timeoutMs] - 单次请求超时；设置页的探测用更短的值，避免页面干等
 * @returns {Promise<any>} 响应体的 data 字段
 */
async function siyuanFetch(config, token, apiPath, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  const url = config.baseUrl.replace(/\/+$/, '') + apiPath
  const headers = { 'Content-Type': 'application/json' }
  if (token !== '') headers.Authorization = 'Token ' + token
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new SiYuanError(`连接思源失败（${url}）：${error?.message ?? String(error)}`)
  }
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new SiYuanError(`思源 ${apiPath} 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (body === null || typeof body !== 'object' || body.code !== 0) {
    const code = body !== null && typeof body === 'object' ? body.code : '?'
    const msg = body !== null && typeof body === 'object' && typeof body.msg === 'string' ? body.msg : text.slice(0, 200)
    throw new SiYuanError(`思源接口 ${apiPath} 失败：code=${String(code)} msg=${msg}`)
  }
  return body.data
}

/** 面向工具调用的包装：每次调用现取配置与 token。 */
function createApi(ctx) {
  return async (apiPath, payload) => {
    const config = readConfig()
    const token = await tokenState(ctx)
    return siyuanFetch(config, token.value, apiPath, payload)
  }
}

// ── HTML DOM → 纯文本 ──────────────────────────────────────────────────────

/** 把思源 getDoc 返回的 DOM 转成保留段落/标题/列表结构的纯文本。 */
function domToText(dom) {
  if (typeof dom !== 'string') return ''
  let text = dom.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>\s*/gi, '\n')
  text = text.replace(/<li[^>]*>/gi, '- ')
  text = text.replace(/<h([1-6])[^>]*>/gi, (_match, level) => '#'.repeat(Number(level)) + ' ')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/** 统一去掉思源检索结果里的高亮标记。 */
function stripMarks(value) {
  return typeof value === 'string' ? value.replace(/<\/?mark>/g, '') : ''
}

// ── 日记路径 ────────────────────────────────────────────────────────────────

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 用常见的 Go 日期 layout 片段渲染一个 Date。 */
function goLayout(date, layout) {
  const values = {
    2006: String(date.getFullYear()),
    '01': pad2(date.getMonth() + 1),
    '02': pad2(date.getDate()),
    15: pad2(date.getHours()),
    '04': pad2(date.getMinutes()),
    '05': pad2(date.getSeconds()),
    Jan: date.toLocaleString('en-US', { month: 'short' }),
    Mon: date.toLocaleString('en-US', { weekday: 'short' }),
  }
  // 单趟替换：顺序替换会让 '02' 命中已替换出来的 '2026'（2026 → 2126）。
  // 备选顺序把 2006 放在 01/02 之前，保证最长的 token 先匹配。
  return layout.replace(/2006|01|02|15|04|05|Jan|Mon/g, (token) => values[token])
}

/** 把 notebook conf 的 dailyNoteSavePath 渲染成实际人类路径。 */
function renderDailyPath(template, date) {
  return template.replace(/\{\{\s*now\s*\|\s*date\s+"([^"]*)"\s*\}\}/g, (_match, layout) => goLayout(date, layout))
}

/**
 * 解析工具的 date 参数。
 *
 * 只有「没传 / 传空」才回退到 `now`；传了但解析不出来一律抛错。
 * 不能沿用 `Date` 的宽松解析：`new Date(2026, 12, 45)` 不报错而是滚到 2027-02-14，
 * `new Date(2026, 1, 30)` 滚到 3 月 2 日——日记工具 append 会把内容静默写进错误的那一天。
 *
 * @param {unknown} value - `YYYY-MM-DD`，空值表示用 now
 * @param {Date} [now] - 参考日期，仅测试用
 * @returns {Date} 当地零点的日期
 */
function parseDateArg(value, now = new Date()) {
  if (value === undefined || value === null) return startOfDay(now)
  if (typeof value !== 'string') throw new Error(`date 必须是 YYYY-MM-DD 字符串，收到 ${typeof value}`)
  const text = value.trim()
  if (text === '') return startOfDay(now)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) throw new Error(`date 格式不合法：「${text}」。请用 YYYY-MM-DD（例如 2026-09-12），或省略 date 用今天。`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  // Date 会把越界值向上翻滚（2026-02-30 → 03-02、2026-13-45 → 2027-02-14），
  // 回读三个字段不相等即说明原值不是真实存在的日期。
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`date 不是真实存在的日期：「${text}」（会翻滚成 ${formatDate(date)}）。请核对年月日。`)
  }
  return date
}

/** 当地零点的同一天；日记与 `{{now | date}}` 模板都只用到年月日。 */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 把 Date 格式化成 YYYY-MM-DD，只用于错误文案。 */
function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

// ── 工具定义辅助 ────────────────────────────────────────────────────────────

function stringProp(description) {
  return { type: 'string', description }
}

/** 构造一个只回一个文本字段的工具定义（官方 tools 注册表接受的 JSON Schema 子集）。 */
function defineTextTool(spec) {
  const properties = spec.parameters ?? {}
  const required = Array.isArray(spec.required) ? spec.required.filter((key) => Object.hasOwn(properties, key)) : []
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted === true) throw new Error('aborted')
      return { result: await spec.execute(args) }
    },
  }
}

function assertNotebook(config, explicit) {
  const notebook = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : config.defaultNotebook
  if (notebook === '') {
    throw new Error('未指定笔记本，且设置页里也没有配置默认笔记本。请传 notebook 参数，或先在 设置 → 思源笔记 里选择默认笔记本。')
  }
  return notebook
}

async function loadNotebookConf(api, notebook) {
  const data = await api('/api/notebook/getNotebookConf', { notebook })
  const conf = data !== null && typeof data === 'object' && data.conf !== null && typeof data.conf === 'object' ? data.conf : {}
  return conf
}

/** 查一个块的类型；不存在返回空串。思源里文档块的 type 是 'd'。 */
async function blockTypeOf(api, id) {
  const escaped = String(id).replace(/'/g, "''")
  const rows = await api('/api/query/sql', { stmt: `SELECT type FROM blocks WHERE id = '${escaped}'` })
  return Array.isArray(rows) && rows.length > 0 && typeof rows[0].type === 'string' ? rows[0].type : ''
}

/**
 * 删除后用 SQL 复核块是否还在。
 * 实测（思源 3.8.3）：`/api/block/deleteBlock` 传文档 id 会返回 code 0 但**什么都不删**，
 * 所以任何删除都必须复核，不能只信返回码。
 */
async function blockStillExists(api, id) {
  return (await blockTypeOf(api, id)) !== ''
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 删除复核的默认预算：15 次探测、指数退避、总等待上限约 6 秒。 */
const DELETE_VERIFY_PROBE_LIMIT = 15
const DELETE_VERIFY_FIRST_DELAY_MS = 150
const DELETE_VERIFY_MAX_DELAY_MS = 1200
const DELETE_VERIFY_TOTAL_MS = 6000
/** 退避区间内就确认删除，也会顺手告知用户“这次复核等了一会儿”。 */
const DELETE_VERIFY_SLOW_HINT_MS = 1500

/**
 * 轮询等待块真的消失。
 *
 * 思源的删除是**异步落库**的：`removeDocByID` 返回成功的那一刻 blocks 行还在，
 * 稍后才消失（实测同一进程内紧接的 SQL 能看到、下一秒再查就没了）。所以必须复核。
 * 但窗口不能太短：早先用固定 `8 × 250ms`（2 秒），大文档或库忙时会把**已成功**的
 * 删除报成「删除未生效」。这里改成指数退避、总预算约 6 秒——很快确认的情况仍然
 * 立刻返回，只有真的慢才多等。
 *
 * @returns {Promise<{gone: boolean, missed: boolean, waitedMs: number}>}
 *   `gone` 块是否已消失；`missed` 是否“慢到值得提醒用户复核”；`waitedMs` 实际等了多久。
 */
async function waitUntilBlockGone(api, id, options = {}) {
  const probeLimit = options.probeLimit ?? DELETE_VERIFY_PROBE_LIMIT
  const totalMs = options.totalMs ?? DELETE_VERIFY_TOTAL_MS
  const maxDelayMs = options.maxDelayMs ?? DELETE_VERIFY_MAX_DELAY_MS
  let delayMs = options.firstDelayMs ?? DELETE_VERIFY_FIRST_DELAY_MS
  let waitedMs = 0
  for (let attempt = 0; attempt < probeLimit; attempt += 1) {
    if (!(await blockStillExists(api, id))) {
      return { gone: true, missed: waitedMs >= DELETE_VERIFY_SLOW_HINT_MS, waitedMs }
    }
    if (attempt === probeLimit - 1 || waitedMs >= totalMs) break
    const wait = Math.min(delayMs, Math.max(0, totalMs - waitedMs))
    if (wait > 0) {
      await sleep(wait)
      waitedMs += wait
    }
    delayMs = Math.min(delayMs * 2, maxDelayMs)
  }
  const gone = !(await blockStillExists(api, id))
  return { gone, missed: gone && waitedMs >= DELETE_VERIFY_SLOW_HINT_MS, waitedMs }
}

/**
 * 删除复核失败时的统一文案。
 * 重点：思源返回成功、但 blocks 行还在，既可能是真的没删掉，也可能是异步落库还没轮到。
 * 不能直接断言“没删”，要告诉用户怎么自己确认。
 */
function deletionNotVerifiedMessage(kind, id, waitedMs) {
  return `思源已接受删除，但等待 ${waitedMs}ms 后 ${kind} ${id} 仍能查到（思源删除是异步落库，可能只是还没轮到）。请稍后用 siyuan_sql 复核："SELECT id FROM blocks WHERE id = '${id}'"；若确实还在，再重试删除。`
}

/** 解析（必要时创建）某一天的日记文档 id。 */
async function resolveDailyDoc(api, config, notebook, date, create) {
  const conf = await loadNotebookConf(api, notebook)
  const template = typeof conf.dailyNoteSavePath === 'string' && conf.dailyNoteSavePath.trim() !== '' ? conf.dailyNoteSavePath : '/daily note/{{now | date "2006/01/02"}}'
  const hpath = renderDailyPath(template, date)
  const ids = await api('/api/filetree/getIDsByHPath', { notebook, path: hpath })
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id !== '') : []
  if (list.length > 0) return { id: list[0], hpath, created: false }
  if (!create) return { id: '', hpath, created: false }
  const created = await api('/api/filetree/createDocWithMd', { notebook, path: hpath, markdown: '' })
  return { id: typeof created === 'string' ? created : String(created ?? ''), hpath, created: true }
}

// ── 工具集 ──────────────────────────────────────────────────────────────────

/**
 * 构造全部工具定义。
 * @param {object} ctx - 宿主插件上下文
 * @param {() => Promise<any>} api - 已经绑定配置与 token 的接口调用器
 */
function buildTools(ctx, api) {
  const notebookArg = { notebook: stringProp('笔记本 id（省略则用设置页配置的默认笔记本）') }

  return [
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_list_notebooks',
        description: '列出思源笔记的所有笔记本及其 id。写入或检索前用它确认真实笔记本 id。',
        parameters: {},
        execute: async () => {
          const data = await api('/api/notebook/lsNotebooks', {})
          const notebooks = Array.isArray(data?.notebooks) ? data.notebooks : []
          if (notebooks.length === 0) return '（没有笔记本）'
          return notebooks
            .map((nb) => `${nb.closed === true ? '[已关闭] ' : ''}${nb.name ?? '(无名)'} | id=${nb.id ?? ''}`)
            .join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_search',
        description: '全文检索思源笔记，返回命中的块。每条给出文档 id（rootID，用它去读文档）、块 id、人类路径与带高亮的片段。',
        parameters: {
          query: stringProp('检索关键词'),
          limit: { type: 'integer', description: '返回条数上限，默认 20' },
        },
        required: ['query'],
        execute: async (args) => {
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20
          const data = await api('/api/search/fullTextSearchBlock', { query: args.query, limit })
          const blocks = Array.isArray(data?.blocks) ? data.blocks : []
          if (blocks.length === 0) return `没有命中「${args.query}」的块。`
          return blocks
            .map((block, index) => {
              const head = `${index + 1}. ${block.hPath ?? ''} | 文档id=${block.rootID ?? ''} | 块id=${block.id ?? ''} | 类型=${block.type ?? ''}`
              const snippet = stripMarks(block.content).replace(/\s+/g, ' ').slice(0, 200)
              return `${head}\n   ${snippet}`
            })
            .join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_sql',
        description: '对思源块数据库执行只读 SQL（SELECT）。取正文用 blocks 表的 markdown 列；content 列对带格式的段落常为空，不要据此判断块为空。',
        parameters: { stmt: stringProp('SQL 语句，只能是 SELECT') },
        required: ['stmt'],
        execute: async (args) => {
          const stmt = String(args.stmt ?? '').trim()
          if (!/^select\b/i.test(stmt)) throw new Error('只允许 SELECT 查询')
          const rows = await api('/api/query/sql', { stmt })
          if (!Array.isArray(rows) || rows.length === 0) return '（没有结果）'
          const capped = rows.slice(0, 200)
          const suffix = rows.length > capped.length ? `\n…（共 ${rows.length} 行，已截断到 ${capped.length} 行）` : ''
          return JSON.stringify(capped, null, 2) + suffix
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_read_doc',
        description: '按文档 id 读取思源文档。format=text 返回纯文本；format=markdown 走导出接口返回 Markdown；format=dom 返回原始 DOM。注意：折叠的标题块不会出现在 getDoc 的 DOM 里，需要看全结构请配合 siyuan_get_child_blocks。',
        parameters: {
          id: stringProp('文档 id'),
          format: { type: 'string', enum: ['text', 'markdown', 'dom'], description: '默认 text' },
        },
        required: ['id'],
        execute: async (args) => {
          const format = args.format === 'markdown' || args.format === 'dom' ? args.format : 'text'
          if (format === 'markdown') {
            const data = await api('/api/export/exportMdContent', { id: args.id })
            const content = typeof data?.content === 'string' ? data.content : ''
            if (content === '') throw new Error(`文档 ${args.id} 没有导出到内容：该 id 可能是块 id，请改用文档 id（检索结果里的 rootID）。`)
            return content
          }
          const data = await api('/api/filetree/getDoc', { id: args.id })
          const content = typeof data?.content === 'string' ? data.content : ''
          if (content === '') throw new Error(`文档 ${args.id} 没有取到内容：可能该 id 是块 id（请用文档 id / rootID），或文档为空。`)
          return format === 'dom' ? content : domToText(content)
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_list_docs',
        description: '列出某个笔记本中某个路径下的子文档。path 用存储路径（如 /20260723165907-3zj91ge.sy）或文档 id；列根目录用 "/"。',
        parameters: {
          ...notebookArg,
          path: stringProp('存储路径或文档 id，根目录为 "/"'),
        },
        required: ['path'],
        execute: async (args) => {
          const config = readConfig()
          const notebook = assertNotebook(config, args.notebook)
          const data = await api('/api/filetree/listDocsByPath', { notebook, path: args.path })
          const files = Array.isArray(data?.files) ? data.files : []
          if (files.length === 0) return `（${args.path} 下没有子文档）`
          return files
            .map((file) => `${file.name ?? '(无名)'} | id=${file.id ?? ''} | 子文档=${file.subFileCount ?? 0}`)
            .join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_get_child_blocks',
        description: '列出文档/块的直接子块（有序，含每块的 id、类型与内容）。判断某个章节是否为空、或读取折叠内容时用它，而不是靠 getDoc 的 DOM。',
        parameters: { id: stringProp('文档 id 或块 id') },
        required: ['id'],
        execute: async (args) => {
          const blocks = await api('/api/block/getChildBlocks', { id: args.id })
          if (!Array.isArray(blocks) || blocks.length === 0) return '（没有子块）'
          // getChildBlocks 只返回 id/type/subType，正文另经 SQL 的 markdown 列补齐。
          const ids = blocks.map((block) => block.id).filter((id) => typeof id === 'string' && id !== '')
          const contentById = new Map()
          if (ids.length > 0) {
            const quoted = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')
            try {
              const rows = await api('/api/query/sql', { stmt: `SELECT id, markdown FROM blocks WHERE id IN (${quoted})` })
              if (Array.isArray(rows)) for (const row of rows) contentById.set(row.id, row.markdown ?? '')
            } catch {
              // 正文补齐失败不影响结构输出
            }
          }
          return blocks
            .map((block, index) => {
              const sub = block.subType === undefined || block.subType === '' ? '' : `/${block.subType}`
              const text = String(contentById.get(block.id) ?? block.content ?? block.markdown ?? '').replace(/\s+/g, ' ').slice(0, 200)
              return `${index + 1}. 类型=${block.type ?? ''}${sub} id=${block.id ?? ''}\n   ${text === '' ? '(无正文)' : text}`
            })
            .join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_get_block_attrs',
        description: '读取块的属性（含自定义属性 custom-*）。',
        parameters: { id: stringProp('块 id') },
        required: ['id'],
        execute: async (args) => {
          const attrs = await api('/api/attr/getBlockAttrs', { id: args.id })
          if (attrs === null || typeof attrs !== 'object') return '（没有属性）'
          return JSON.stringify(attrs, null, 2)
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_create_doc',
        description: '用 Markdown 在指定笔记本的指定人类路径下新建文档（path 形如 /目录/文档名，以 / 开头）。该接口非幂等：同一 path 重复调用会新建同名文档，因此默认先查重，已存在则返回已有文档 id 而不新建；确实要再建一份时传 allowDuplicate=true。',
        parameters: {
          ...notebookArg,
          path: stringProp('人类路径，以 / 开头，如 /收件箱/会议记录'),
          markdown: stringProp('文档正文 Markdown'),
          allowDuplicate: { type: 'boolean', description: '已存在同名文档时仍然新建，默认 false' },
        },
        required: ['path', 'markdown'],
        execute: async (args) => {
          const config = readConfig()
          const notebook = assertNotebook(config, args.notebook)
          const existing = await api('/api/filetree/getIDsByHPath', { notebook, path: args.path })
          const list = Array.isArray(existing) ? existing.filter((id) => typeof id === 'string' && id !== '') : []
          if (list.length > 0 && args.allowDuplicate !== true) {
            return `已存在同路径文档，未新建（createDocWithMd 非幂等，重复调用会堆出同名文档）。\n文档 id: ${list.join(', ')}\n要追加内容请用 siyuan_append_block；确实要另建一份请传 allowDuplicate=true。`
          }
          const id = await api('/api/filetree/createDocWithMd', { notebook, path: args.path, markdown: args.markdown })
          return `已创建文档：id=${typeof id === 'string' ? id : JSON.stringify(id)}\n笔记本=${notebook} 路径=${args.path}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_append_block',
        description: '把 Markdown 追加到某文档末尾。更新已有文档应优先用它，而不是重复 create。',
        parameters: {
          docId: stringProp('文档 id'),
          markdown: stringProp('要追加的 Markdown'),
        },
        required: ['docId', 'markdown'],
        execute: async (args) => {
          await api('/api/block/appendBlock', { dataType: 'markdown', data: args.markdown, parentID: args.docId })
          return `已追加到文档 ${args.docId}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_insert_block',
        description: '在某个块之后插入 Markdown。标题是叶子块，不能当 parentID：往标题下插入要传 previousID=该标题 id（或该标题下最后一个块的 id）。',
        parameters: {
          previousId: stringProp('前一个块的 id；插到文档开头时改传 parentId'),
          parentId: stringProp('父块 id（与 previousId 二选一）'),
          markdown: stringProp('要插入的 Markdown'),
        },
        required: ['markdown'],
        execute: async (args) => {
          if ((args.previousId === undefined || args.previousId === '') && (args.parentId === undefined || args.parentId === '')) {
            throw new Error('必须提供 previousId 或 parentId 之一')
          }
          const payload = { dataType: 'markdown', data: args.markdown }
          if (args.previousId !== undefined && args.previousId !== '') payload.previousID = args.previousId
          else payload.parentID = args.parentId
          await api('/api/block/insertBlock', payload)
          return '已插入块'
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_update_block',
        description: '用 Markdown 覆盖某个块的内容。注意：实测传多段 Markdown 时只保留第一段，其余会被静默丢弃；要加多段内容请用 siyuan_insert_block 逐段插入。',
        parameters: {
          blockId: stringProp('块 id'),
          markdown: stringProp('新的 Markdown 内容（单段）'),
        },
        required: ['blockId', 'markdown'],
        execute: async (args) => {
          await api('/api/block/updateBlock', { id: args.blockId, dataType: 'markdown', data: args.markdown })
          return `已更新块 ${args.blockId}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_set_block_attrs',
        description: '设置块属性（含 custom-* 自定义属性）。attrs 是属性名到值的对象。',
        parameters: {
          id: stringProp('块 id'),
          attrs: { type: 'object', additionalProperties: true, description: '属性对象，如 {"custom-status":"done"}' },
        },
        required: ['id', 'attrs'],
        execute: async (args) => {
          if (args.attrs === null || typeof args.attrs !== 'object' || Array.isArray(args.attrs)) {
            throw new Error('attrs 必须是对象')
          }
          await api('/api/attr/setBlockAttrs', { id: args.id, attrs: args.attrs })
          return `已设置 ${args.id} 的 ${Object.keys(args.attrs).length} 个属性`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_move_doc',
        description: '移动整篇文档到另一个父文档或笔记本下：toId 传目标父文档 id，或传目标笔记本 id（移到该笔记本根）。注意移动的是整篇文档；移动单个块请用 siyuan_insert_block / siyuan_delete_block。',
        parameters: {
          docIds: { type: 'array', items: { type: 'string' }, description: '要移动的文档 id 列表（至少一个）' },
          toId: stringProp('目标父文档 id 或目标笔记本 id'),
        },
        required: ['docIds', 'toId'],
        execute: async (args) => {
          const docIds = Array.isArray(args.docIds) ? args.docIds.filter((id) => typeof id === 'string' && id !== '') : []
          if (docIds.length === 0) throw new Error('docIds 至少要有一个文档 id')
          const toId = typeof args.toId === 'string' ? args.toId.trim() : ''
          if (toId === '') throw new Error('必须提供 toId（目标父文档 id 或目标笔记本 id）')
          await api('/api/filetree/moveDocsByID', { fromIDs: docIds, toID: toId })
          return `已移动 ${docIds.length} 篇文档到 ${toId}：${docIds.join(', ')}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_rename_doc',
        description: '重命名文档（改标题）。',
        parameters: {
          docId: stringProp('文档 id'),
          title: stringProp('新标题'),
        },
        required: ['docId', 'title'],
        execute: async (args) => {
          const title = String(args.title ?? '').trim()
          if (title === '') throw new Error('title 不能为空')
          await api('/api/filetree/renameDocByID', { id: args.docId, title })
          return `已把 ${args.docId} 重命名为「${title}」`
        },
      }),
    },
    {
      group: 'daily',
      definition: defineTextTool({
        name: 'siyuan_daily_note',
        description: '读写思源日记。action=read 读取指定日期（默认今天）的日记；action=append 把 Markdown 追加到该日记，日记不存在时按笔记本的 dailyNoteSavePath 自动创建。',
        parameters: {
          action: { type: 'string', enum: ['read', 'append'], description: 'read 或 append' },
          date: stringProp('日期 YYYY-MM-DD，默认今天'),
          markdown: stringProp('action=append 时要写入的 Markdown'),
          ...notebookArg,
        },
        required: ['action'],
        execute: async (args) => {
          const config = readConfig()
          const notebook = assertNotebook(config, args.notebook)
          const date = parseDateArg(args.date)
          const action = args.action === 'append' ? 'append' : 'read'
          if (action === 'append' && (typeof args.markdown !== 'string' || args.markdown.trim() === '')) {
            throw new Error('action=append 时必须提供 markdown')
          }
          if (action === 'append') {
            const resolved = await resolveDailyDoc(api, config, notebook, date, false)
            let docId = resolved.id
            if (docId === '') {
              const createdId = await api('/api/filetree/createDocWithMd', { notebook, path: resolved.hpath, markdown: args.markdown })
              docId = typeof createdId === 'string' ? createdId : String(createdId ?? '')
              return `日记原不存在，已创建并写入：${resolved.hpath}\n文档 id=${docId}`
            }
            await api('/api/block/appendBlock', { dataType: 'markdown', data: args.markdown, parentID: docId })
            return `已追加到日记 ${resolved.hpath}\n文档 id=${docId}`
          }
          const resolved = await resolveDailyDoc(api, config, notebook, date, false)
          if (resolved.id === '') return `${resolved.hpath} 的日记还不存在。`
          const data = await api('/api/filetree/getDoc', { id: resolved.id })
          const content = typeof data?.content === 'string' ? data.content : ''
          const text = domToText(content)
          return `# ${resolved.hpath}（文档 id=${resolved.id}）\n\n${text === '' ? '（日记为空，或内容都在折叠块里，可用 siyuan_get_child_blocks 查看结构）' : text}`
        },
      }),
    },
    {
      group: 'danger',
      definition: defineTextTool({
        name: 'siyuan_delete_block',
        description: '删除一个内容块。删除标题块会连同其下内容一起删除，且必须先删子块再删父块。这是破坏性操作：只有用户明确要求删除时才调用，并传 confirm=true。整篇文档请用 siyuan_remove_doc——文档块走这个接口只“报成功不删”。',
        parameters: {
          blockId: stringProp('要删除的块 id'),
          confirm: { type: 'boolean', description: '必须显式传 true 才会执行删除' },
        },
        required: ['blockId', 'confirm'],
        execute: async (args) => {
          if (args.confirm !== true) throw new Error('删除是破坏性操作，需要在用户明确要求后传 confirm=true')
          const type = await blockTypeOf(api, args.blockId)
          if (type === '') throw new Error(`块 ${args.blockId} 不存在，请核对 id`)
          if (type === 'd') {
            throw new Error(`块 ${args.blockId} 是文档块：思源对文档走 /api/block/deleteBlock 会返回成功但不删除。删除整篇文档请用 siyuan_remove_doc。`)
          }
          await api('/api/block/deleteBlock', { id: args.blockId })
          const verified = await waitUntilBlockGone(api, args.blockId)
          if (!verified.gone) throw new Error(deletionNotVerifiedMessage('块', args.blockId, verified.waitedMs))
          return verified.missed
            ? `已删除块 ${args.blockId}（复核用了 ${verified.waitedMs}ms：思源删除是异步落库的）`
            : `已删除块 ${args.blockId}`
        },
      }),
    },
    {
      group: 'danger',
      definition: defineTextTool({
        name: 'siyuan_remove_doc',
        description: '删除整篇文档（走 /api/filetree/removeDocByID，之后可在思源回收站找回）。这是破坏性操作：只有用户明确要求删除整篇文档时才调用，并传 confirm=true。删除单个内容块请用 siyuan_delete_block。',
        parameters: {
          docId: stringProp('要删除的文档 id'),
          confirm: { type: 'boolean', description: '必须显式传 true 才会执行删除' },
        },
        required: ['docId', 'confirm'],
        execute: async (args) => {
          if (args.confirm !== true) throw new Error('删除是破坏性操作，需要在用户明确要求后传 confirm=true')
          await api('/api/filetree/removeDocByID', { id: args.docId })
          const verified = await waitUntilBlockGone(api, args.docId)
          if (!verified.gone) throw new Error(deletionNotVerifiedMessage('文档', args.docId, verified.waitedMs))
          return verified.missed
            ? `已删除文档 ${args.docId}（复核用了 ${verified.waitedMs}ms：思源删除是异步落库的）`
            : `已删除文档 ${args.docId}`
        },
      }),
    },
  ]
}

// ── 请求信任围栏与 JSON 响应 ────────────────────────────────────────────────

function headerValue(headers, key) {
  const value = headers[key]
  return Array.isArray(value) ? value[0] : value
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/**
 * 只接受本机或部署声明的受信 authority 发起的、同源的浏览器请求。
 * 与 dsh-better-sidebar 的围栏同一判据。
 */
function isTrustedRequest(req, trustedHosts) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const trusted = Array.isArray(trustedHosts) ? trustedHosts : []
  const isTrustedAuthority = trusted.some((candidate) => {
    if (typeof candidate === 'string') return candidate === host || candidate === hostUrl.host
    return false
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority) return false
  if (headerValue(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

function mount(ctx) {
    onConfigCorrupt = (file, reason) => ctx.logger?.warn?.(`[dsh-siyuan] 配置文件损坏，已回退默认值：${file}（${reason}）`)
    const api = createApi(ctx)
    const allTools = buildTools(ctx, api)

    // ── 工具动态注册（按设置页的分组开关） ──
    let toolDisposers = []
    const disposeTools = () => {
      for (const dispose of toolDisposers) {
        try {
          dispose()
        } catch {
          // 已随插件树卸载时忽略
        }
      }
      toolDisposers = []
    }
    const syncTools = () => {
      disposeTools()
      const config = readConfig()
      for (const entry of allTools) {
        if (config.tools[entry.group] !== true) continue
        toolDisposers.push(ctx.tools.register(entry.definition))
      }
      ctx.logger?.info?.(`[dsh-siyuan] 已注册工具：${allTools.filter((entry) => config.tools[entry.group] === true).map((entry) => entry.definition.name).join(', ') || '(无)'}`)
    }
    syncTools()
    ctx.effect(() => disposeTools, 'dsh-siyuan: tools')

    // ── 设置页路由 ──
    const statePayload = async () => {
      const config = readConfig()
      const token = await tokenState(ctx)
      let version = ''
      let reachable = false
      try {
        version = String((await siyuanFetch(config, token.value, '/api/system/version', {}, PROBE_TIMEOUT_MS)) ?? '')
        reachable = true
      } catch {
        reachable = false
      }
      return {
        config,
        token: { configured: token.configured, source: token.source, writable: token.writable },
        reachable,
        version,
        toolGroups: TOOL_GROUPS,
        toolNames: allTools.map((entry) => ({ name: entry.definition.name, group: entry.group })),
      }
    }

    const handlers = {
      async getState() {
        return statePayload()
      },
      async updateConfig(body) {
        const config = readConfig()
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '') config.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
        if (typeof body.defaultNotebook === 'string') config.defaultNotebook = body.defaultNotebook
        if (body.tools !== null && typeof body.tools === 'object') {
          for (const key of TOOL_GROUPS) {
            if (typeof body.tools[key] === 'boolean') config.tools[key] = body.tools[key]
          }
        }
        writeConfig(config)
        syncTools()
        return statePayload()
      },
      async setToken(body) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) throw new Error('宿主的凭据服务不可用，无法保存 token')
        const token = typeof body.token === 'string' ? body.token.trim() : ''
        if (token === '') throw new Error('token 不能为空')
        await credentials.set(TOKEN_REF, token)
        return statePayload()
      },
      async clearToken() {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) throw new Error('宿主的凭据服务不可用')
        try {
          await credentials.unset(TOKEN_REF)
        } catch (error) {
          throw new Error(`清除失败：${error?.message ?? String(error)}`)
        }
        return statePayload()
      },
      async listNotebooks() {
        const config = readConfig()
        const token = await tokenState(ctx)
        const data = await siyuanFetch(config, token.value, '/api/notebook/lsNotebooks', {}, CONNECT_TEST_TIMEOUT_MS)
        const notebooks = Array.isArray(data?.notebooks) ? data.notebooks : []
        return {
          notebooks: notebooks.map((nb) => ({ id: nb.id ?? '', name: nb.name ?? '', closed: nb.closed === true })),
        }
      },
      async testConnection() {
        const config = readConfig()
        const token = await tokenState(ctx)
        const probes = []
        const run = async (label, apiPath, payload) => {
          try {
            const data = await siyuanFetch(config, token.value, apiPath, payload, CONNECT_TEST_TIMEOUT_MS)
            probes.push({ label, ok: true, detail: typeof data === 'string' ? data : JSON.stringify(data).slice(0, 300) })
            return data
          } catch (error) {
            probes.push({ label, ok: false, detail: error?.message ?? String(error) })
            return undefined
          }
        }
        const version = await run('系统版本 /api/system/version', '/api/system/version', {})
        await run('列出笔记本 /api/notebook/lsNotebooks', '/api/notebook/lsNotebooks', {})
        await run('SQL 查询 /api/query/sql', '/api/query/sql', { stmt: 'SELECT 1 AS ok' })
        const ok = probes.every((probe) => probe.ok === true)
        return {
          ok,
          version: version === undefined ? '' : String(version),
          tokenConfigured: token.configured,
          probes,
        }
      },
    }

    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            const trustedHosts = ctx.get('webRuntime')?.trustedHosts
            if (!isTrustedRequest(req, trustedHosts)) {
              writeJson(res, 403, { ok: false, error: { message: 'forbidden' } })
              return
            }
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
              return
            }
            const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
            const method = pathname.startsWith(API_PREFIX + '/') ? pathname.slice(API_PREFIX.length + 1) : ''
            const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
            if (handler === undefined) {
              writeJson(res, 404, { ok: false, error: { message: `unknown siyuan api method "${method}"` } })
              return
            }
            try {
              const body = await readJsonBody(req)
              const value = await handler(body)
              writeJson(res, 200, { ok: true, value })
            } catch (error) {
              writeJson(res, 200, { ok: false, error: { message: error?.message ?? String(error) } })
            }
          },
        }),
      'dsh-siyuan: settings routes',
    )

    // 配置变更后工具集需要重新同步：watch 文件不必要，设置页写入时已同步。
}

export function apply(ctx) {
  // cordis 规定：没有声明 inject 的上下文读取 ctx.tools / ctx.webServer 会抛
  // "cannot get property ... without inject"，因此所有服务访问都走注入后的子上下文。
  // 挂载期的失败不做额外兜底：宿主日志会带上栈，静默吞掉只会更难定位。
  ctx.inject(['tools', 'webServer'], (sctx) => {
    mount(sctx)
  })
}

/**
 * 纯函数导出，仅用于单元测试（宿主按名字加载插件，多出的命名导出无副作用）。
 */
export const internals = { parseDateArg, startOfDay, goLayout, renderDailyPath, domToText, stripMarks, readConfig, writeConfig, configPath }
