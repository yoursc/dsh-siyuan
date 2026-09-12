/**
 * dsh-siyuan 干跑测试：用假的 ctx 调用插件 apply()，校验
 *  1. 工具定义通过官方 dsh-tools 的 JSON Schema 子集校验；
 *  2. 设置页路由（getState / updateConfig / setToken / listNotebooks /
 *     testConnection）的信封与错误面；
 *  3. 信任围栏与方法/方法名错误分支。
 *
 * 用法：
 *   node test/harness.mjs          默认对着本地思源替身跑，不需要真实思源、不联网
 *   node test/harness.mjs --live   改成探测真实实例（http://127.0.0.1:6806）；
 *                                  实例没起或没开鉴权时报失败，属预期
 *
 * schema 校验需要 @deepseek-ai/dsh-tools（devDependency）。解析不到时**判失败**而非跳过，
 * 否则这一层校验会静默消失、套件仍然全绿。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMockSiYuan } from './mock-siyuan.mjs'

const LIVE = process.argv.includes('--live')
// 真实部署的 token 常来自环境变量；显式清掉，避免凭据回退路径污染「未配置」断言。
delete process.env.SIYUAN_TOKEN

// 配置写入隔离到临时 DSH_HOME，测试不动真实 ~/.dsh。
// 每次跑用独立临时目录：并行执行（或同机多个 CI job）不会互相删配置。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-harness-'))
process.env.DSH_HOME = TEST_HOME
// 目录先建好：下面的「损坏配置」用例要直接写这个文件，两种模式下都得存在。
fs.mkdirSync(TEST_HOME + '/storages/siyuan', { recursive: true })

const mock = LIVE ? null : await startMockSiYuan()
const DEFAULT_BASE = LIVE ? 'http://127.0.0.1:6806' : mock.baseUrl
// 替身的 token 走凭据假件提供；未配置分支在「凭据路径」段落里用独立实例覆盖。
if (mock !== null) {
  fs.writeFileSync(
    TEST_HOME + '/storages/siyuan/config.json',
    JSON.stringify({ baseUrl: mock.baseUrl, defaultNotebook: '', tools: { read: true, daily: true } }),
  )
}
console.log(LIVE ? '模式：--live（探测真实实例 127.0.0.1:6806）' : '模式：本地替身（不依赖真实思源）')

// 插件有模块级状态（配置损坏告警的去重标记），需要干净状态的用例用 loadPlugin() 取新实例。
let pluginLoadCount = 0
const loadPlugin = () => import(`../lib/index.js?case=${(pluginLoadCount += 1)}`)
const plugin = await loadPlugin()

const failures = []
/** 成功时清掉临时 home；失败时保留，便于取证（路径会随失败清单一起打印）。 */
function cleanupHome() {
  if (failures.length === 0) fs.rmSync(TEST_HOME, { recursive: true, force: true })
}

function check(label, condition, detail) {
  if (condition === true) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label + (detail === undefined ? '' : ` — ${detail}`))
    console.log(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}`)
  }
}

let assertSupportedJsonSchema = null
try {
  ;({ assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools'))
} catch (error) {
  check('@deepseek-ai/dsh-tools 可解析（工具 schema 校验依赖它）', false, `${error?.code ?? error?.message ?? error}；请先 npm install`)
}
if (assertSupportedJsonSchema !== null && typeof assertSupportedJsonSchema !== 'function') {
  check('@deepseek-ai/dsh-tools 导出了 assertSupportedJsonSchema', false, typeof assertSupportedJsonSchema)
}

// ── 假 ctx ──────────────────────────────────────────────────────────────────

const tools = []
const routes = []
const disposers = []
let disposeCount = 0

const warnings = []
const ctx = {
  get: () => undefined,
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
}
// cordis 语义：只有声明了 inject 的上下文才能读服务属性。这里让「未注入的外层
// 上下文」在被读 tools/webServer 时抛错，从而复现真实约束；注入回调拿到的是
// 带服务的内层上下文。
Object.defineProperty(ctx, 'tools', {
  get() {
    throw new Error('cannot get property "tools" without inject')
  },
})
Object.defineProperty(ctx, 'webServer', {
  get() {
    throw new Error('cannot get property "webServer" without inject')
  },
})
const injectedCtx = {
  ...ctx,
  get: (name) => (name === 'credentials' ? undefined : undefined),
  tools: {
    register: (definition) => {
      tools.push(definition)
      return () => {
        disposeCount += 1
        const index = tools.indexOf(definition)
        if (index >= 0) tools.splice(index, 1)
      }
    },
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
}
ctx.inject = (deps, callback) => callback(injectedCtx)

console.log('— apply() 挂载 —')
plugin.apply(ctx)
check('注册了 webServer 前缀路由', routes.length === 1 && routes[0].path === '/siyuan/api', JSON.stringify(routes.map((r) => r.path)))
check('默认分组注册 8 个工具（read 7 + daily 1）', tools.length === 8, `实际 ${tools.length}: ${tools.map((t) => t.name).join(',')}`)

console.log('— 工具 schema 校验（官方子集）—')
for (const definition of tools) {
  if (assertSupportedJsonSchema !== null) {
    try {
      assertSupportedJsonSchema(definition.parameters)
      assertSupportedJsonSchema(definition.output.schema)
      check(`${definition.name} schema 合法`, true)
    } catch (error) {
      check(`${definition.name} schema 合法`, false, error.message)
    }
  }
  check(
    `${definition.name} 结构完整`,
    typeof definition.description === 'string' && definition.description.length > 0 && typeof definition.execute === 'function' && definition.output.render([], { result: 'x' })[0].text === 'x'
  )
}

// ── 路由干跑 ────────────────────────────────────────────────────────────────

function makeRequest({ method = 'POST', url = '/siyuan/api/getState', headers = { host: '127.0.0.1:3080' }, body = {}, rawBody = undefined } = {}) {
  const payload = Buffer.from(rawBody === undefined ? JSON.stringify(body) : rawBody)
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  }
}

function makeResponse() {
  return {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

async function call(method, body, options = {}) {
  const request = makeRequest({ url: `/siyuan/api/${method}`, body, ...options })
  const response = makeResponse()
  await routes[0].handler(request, response)
  let parsed = null
  try {
    parsed = JSON.parse(response.body)
  } catch {
    parsed = null
  }
  return { status: response.status, payload: parsed }
}

console.log('— 路由：基础分支 —')
{
  const bad = await call('getState', {}, { headers: { host: 'evil.example.com' } })
  check('外部 Host 被围栏拒绝 (403)', bad.status === 403, JSON.stringify(bad.payload))

  // C7：围栏的其余判据——跨站标记、origin 与 Host 不一致、受信 Host 白名单。
  const crossSite = await call('getState', {}, { headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } })
  check('sec-fetch-site: cross-site 被拒 (403)', crossSite.status === 403, JSON.stringify(crossSite.payload))

  const sameSite = await call('getState', {}, { headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } })
  check('sec-fetch-site: same-origin 放行', sameSite.status === 200, JSON.stringify(sameSite.payload).slice(0, 120))

  const foreignOrigin = await call('getState', {}, { headers: { host: '127.0.0.1:3080', origin: 'http://evil.example.com' } })
  check('origin 与 Host 不一致被拒 (403)', foreignOrigin.status === 403, JSON.stringify(foreignOrigin.payload))

  const sameOrigin = await call('getState', {}, { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } })
  check('origin 与 Host 一致放行', sameOrigin.status === 200, JSON.stringify(sameOrigin.payload).slice(0, 120))

  const noHost = await call('getState', {}, { headers: {} })
  check('缺少 Host 头被拒 (403)', noHost.status === 403, JSON.stringify(noHost.payload))

  // 受信 Host 白名单：非 loopback 的部署域名靠 webRuntime.trustedHosts 放行。
  const routes3 = []
  const trustedInject = {
    get: (name) => (name === 'webRuntime' ? { trustedHosts: ['dsh.example.com'] } : undefined),
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
    tools: { register: () => () => {} },
    webServer: {
      register: (route) => {
        routes3.push(route)
        return () => {}
      },
    },
  }
  plugin.apply({
    ...trustedInject,
    inject: (_deps, callback) => callback(trustedInject),
    get tools() {
      throw new Error('cannot get property "tools" without inject')
    },
    get webServer() {
      throw new Error('cannot get property "webServer" without inject')
    },
  })
  const trustedCall = async (headers) => {
    const request = makeRequest({ url: '/siyuan/api/getState', headers })
    const response = makeResponse()
    await routes3[0].handler(request, response)
    return response.status
  }
  check('受信 Host 白名单内放行', (await trustedCall({ host: 'dsh.example.com' })) === 200)
  check('受信 Host 之外的域名仍被拒', (await trustedCall({ host: 'other.example.com' })) === 403)
  check('受信 Host 带跨站标记仍被拒', (await trustedCall({ host: 'dsh.example.com', 'sec-fetch-site': 'cross-site' })) === 403)

  const wrongMethod = await call('getState', {}, { method: 'GET' })
  check('非 POST 返回 405', wrongMethod.status === 405)

  const unknown = await call('nope', {})
  check('未知方法返回 404', unknown.status === 404)
}

console.log('— 路由：请求体错误面 —')
{
  // C7：非法 JSON、超过 2MB、空请求体三种输入都要有明确行为，不能静默当成空对象。
  const badJson = await call('updateConfig', undefined, { rawBody: '{ 不是 JSON' })
  check('非法 JSON 请求体被拒且文案可读', badJson.payload?.ok === false && /不是合法 JSON/.test(badJson.payload?.error?.message ?? ''), JSON.stringify(badJson.payload))

  const tooBig = await call('updateConfig', undefined, { rawBody: JSON.stringify({ baseUrl: 'x'.repeat(2 * 1024 * 1024 + 10) }) })
  check('超过 2MB 的请求体被拒', tooBig.payload?.ok === false && /请求体过大/.test(tooBig.payload?.error?.message ?? ''), JSON.stringify(tooBig.payload).slice(0, 160))

  const empty = await call('getState', undefined, { rawBody: '' })
  check('空请求体按空对象处理', empty.status === 200 && empty.payload?.ok === true, JSON.stringify(empty.payload).slice(0, 120))

  const blank = await call('getState', undefined, { rawBody: '   ' })
  check('全空白请求体按空对象处理', blank.status === 200 && blank.payload?.ok === true, JSON.stringify(blank.payload).slice(0, 120))
}

console.log('— 路由：配置损坏不静默 —')
{
  // 用独立实例：告警去重标记是模块级的，和前面用例共用会让首条告警被吞掉。
  const corruptRoutes = []
  const corruptInject = {
    get: () => undefined,
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
    tools: { register: () => () => {} },
    webServer: {
      register: (route) => {
        corruptRoutes.push(route)
        return () => {}
      },
    },
  }
  const corruptPlugin = await loadPlugin()
  corruptPlugin.apply({
    ...corruptInject,
    inject: (_deps, callback) => callback(corruptInject),
    get tools() {
      throw new Error('cannot get property "tools" without inject')
    },
    get webServer() {
      throw new Error('cannot get property "webServer" without inject')
    },
  })
  const CONFIG_FILE = TEST_HOME + '/storages/siyuan/config.json'
  fs.writeFileSync(CONFIG_FILE, '{ 这不是 JSON', 'utf8')
  const callCorrupt = async () => {
    const request = makeRequest({ url: '/siyuan/api/getState' })
    const response = makeResponse()
    await corruptRoutes[0].handler(request, response)
    return { status: response.status, payload: JSON.parse(response.body) }
  }
  const warnedBefore = warnings.filter((line) => line.includes('配置文件损坏')).length
  const corrupted = await callCorrupt()
  check('损坏的配置不会让 getState 失败（回退默认值）', corrupted.payload?.ok === true && corrupted.payload?.value?.config?.baseUrl === 'http://127.0.0.1:6806', JSON.stringify(corrupted.payload?.value?.config))
  const corruptWarnings = warnings.filter((line) => line.includes('配置文件损坏'))
  check('损坏的配置会留下告警', corruptWarnings.length > warnedBefore && corruptWarnings.some((line) => line.includes(CONFIG_FILE)), JSON.stringify(corruptWarnings))
  await callCorrupt()
  check('同一份坏文件只告警一次', warnings.filter((line) => line.includes('配置文件损坏')).length === warnedBefore + 1, JSON.stringify(warnings.filter((line) => line.includes('配置文件损坏'))))
  fs.rmSync(CONFIG_FILE, { force: true })
}

console.log('— 配置文件里的 baseUrl 非法时不静默 —')
{
  // C3：手改坏/旧版写入的坏地址不能静默用下去。用独立插件实例：
  // 告警去重标记是模块级的，复用前一个实例会让断言被去重吞掉。
  // 直接调 internals.readConfig() 而不是走路由 getState，避免触碰真实实例的探测。
  const warnSink = []
  const badUrlInject = {
    get: () => undefined,
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { info: () => {}, warn: (message) => warnSink.push(String(message)) },
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
  }
  const badUrlPlugin = await loadPlugin()
  badUrlPlugin.apply({
    ...badUrlInject,
    inject: (_deps, callback) => callback(badUrlInject),
    get tools() {
      throw new Error('cannot get property "tools" without inject')
    },
    get webServer() {
      throw new Error('cannot get property "webServer" without inject')
    },
  })
  const CONFIG_FILE = TEST_HOME + '/storages/siyuan/config.json'
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ baseUrl: 'not a url', defaultNotebook: 'nb-x' }), 'utf8')
  const config = badUrlPlugin.internals.readConfig()
  check('坏 baseUrl 回退默认值而不是静默使用', config.baseUrl === 'http://127.0.0.1:6806' && config.defaultNotebook === 'nb-x', JSON.stringify(config))
  check('坏 baseUrl 留下告警', warnSink.some((line) => line.includes('baseUrl 不是合法') && line.includes(CONFIG_FILE)), JSON.stringify(warnSink))
  // 恢复成最初写入的合法内容，别影响后续段落（它们仍会经 readConfig 读这份文件）。
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ baseUrl: DEFAULT_BASE, defaultNotebook: '', tools: { read: true, daily: true } }), 'utf8')
}

console.log('— 路由：getState / updateConfig —')
{
  const state = await call('getState', {})
  const before = tools.length
  // C3 回归：保存入口必须拒绝非法 baseUrl，否则设置页回"已保存"的假成功，
  // 之后所有请求都失败，用户只能从"连接思源失败"反推。
  const badUrl = await call('updateConfig', { baseUrl: 'not a url' })
  check('updateConfig 拒绝非 http(s) 的 baseUrl', badUrl.payload?.ok === false && /http/.test(badUrl.payload?.error?.message ?? ''), JSON.stringify(badUrl.payload))
  const badScheme = await call('updateConfig', { baseUrl: 'javascript:alert(1)' })
  check('updateConfig 拒绝 javascript: 协议', badScheme.payload?.ok === false, JSON.stringify(badScheme.payload))
  const afterReject = await call('getState', {})
  check('拒绝后 baseUrl 仍是替身地址（配置没被写坏）', afterReject.payload?.value?.config?.baseUrl === DEFAULT_BASE, afterReject.payload?.value?.config?.baseUrl)
  const updated = await call('updateConfig', { baseUrl: DEFAULT_BASE + '/', defaultNotebook: '20260723165907-3zj91ge', tools: { write: true, danger: true } })
  check('updateConfig ok', updated.status === 200 && updated.payload?.ok === true, JSON.stringify(updated.payload).slice(0, 200))
  check('baseUrl 去掉了尾部斜杠', updated.payload?.value?.config?.baseUrl === DEFAULT_BASE, updated.payload?.value?.config?.baseUrl)
  check('默认笔记本已保存', updated.payload?.value?.config?.defaultNotebook === '20260723165907-3zj91ge')
  check('工具随开关重新注册（8 → 17）', tools.length === 17 && before === 8, `before=${before} after=${tools.length}`)
  check('旧注册被释放', disposeCount === 8, `disposeCount=${disposeCount}`)
  check('config.json 落盘', fs.existsSync(TEST_HOME + '/storages/siyuan/config.json') === true)
  // H2：原子写不能留下临时文件，且读回来的内容要和刚写的配置一致。
  const leftovers = fs.readdirSync(TEST_HOME + '/storages/siyuan').filter((name) => name.includes('.tmp-'))
  check('原子写不残留临时文件', leftovers.length === 0, JSON.stringify(leftovers))
  const onDisk = JSON.parse(fs.readFileSync(TEST_HOME + '/storages/siyuan/config.json', 'utf8'))
  check('落盘内容与 getState 返回的配置一致', onDisk.baseUrl === updated.payload?.value?.config?.baseUrl && onDisk.defaultNotebook === '20260723165907-3zj91ge' && onDisk.tools?.read === true && onDisk.tools?.danger === true, JSON.stringify(onDisk))

  // C6：把开关关回去也要正确释放（此前只覆盖了 8 → 17 的开启方向）
  const turnedOff = await call('updateConfig', { tools: { write: false, danger: false } })
  check('关闭分组后工具回落到 8 个', turnedOff.payload?.ok === true && tools.length === 8, `tools=${tools.length}`)
  check('关闭分组的释放计数继续累加', disposeCount === 25, `disposeCount=${disposeCount}`)
  check('再次开启回到 17 个', (await call('updateConfig', { tools: { write: true, danger: true } }))?.payload?.ok === true && tools.length === 17, `tools=${tools.length}`)

  const reopened = await call('getState', {})
  check('重新读取仍是 17 个工具', reopened.payload?.value?.toolNames?.length === 17, String(reopened.payload?.value?.toolNames?.length))
}


console.log('— 路由：token 与思源接口错误面 —')
{
  const setToken = await call('setToken', { token: 'x' })
  check('没有凭据服务时 setToken 报错而不是静默失败', setToken.payload?.ok === false && /凭据服务不可用/.test(setToken.payload?.error?.message ?? ''), JSON.stringify(setToken.payload))

  const notebooks = await call('listNotebooks', {})
  check('无 token 时 listNotebooks 返回思源错误', notebooks.payload?.ok === false && /思源接口/.test(notebooks.payload?.error?.message ?? ''), JSON.stringify(notebooks.payload).slice(0, 220))

  // 需要鉴权的接口在无 token 时必须给带 code/msg 的思源信封，而不是 HTTP 层面的失败。
  // 替身与真实实例都按这个契约回（真实实测：code=-1 / msg="Auth failed [session]"）。
  if (mock !== null) {
    const unauthenticated = mock.state.requests.filter((entry) => entry.path === '/api/notebook/lsNotebooks' && entry.authorized !== true)
    check('无 token 的请求确实没带 Authorization 头', unauthenticated.length > 0, String(unauthenticated.length))
  }

  const probe = await call('testConnection', {})
  const probes = probe.payload?.value?.probes ?? []
  check('testConnection 返回三条探测', probes.length === 3, JSON.stringify(probes).slice(0, 220))
  check('公开接口 /api/system/version 探测成功', probes[0]?.ok === true, JSON.stringify(probes[0]))
  check('需要鉴权的接口探测失败并带 msg', probes[1]?.ok === false && /code=/.test(probes[1]?.detail ?? ''), JSON.stringify(probes[1]))
  check('testConnection 整体判定为失败', probe.payload?.value?.ok === false)
}

console.log('— 工具执行：错误面 —')
{
  const notebooksTool = tools.find((definition) => definition.name === 'siyuan_list_notebooks')
  let message = ''
  try {
    await notebooksTool.execute({}, {})
  } catch (error) {
    message = error?.message ?? String(error)
  }
  check('无 token 调用工具抛出可读错误', /连接思源失败|思源接口/.test(message), message.slice(0, 200))

  const deleteTool = tools.find((definition) => definition.name === 'siyuan_delete_block')
  let deleteMessage = ''
  try {
    await deleteTool.execute({ blockId: 'x', confirm: false }, {})
  } catch (error) {
    deleteMessage = error?.message ?? String(error)
  }
  check('删除工具未确认时拒绝执行', /confirm=true/.test(deleteMessage), deleteMessage.slice(0, 160))
}

console.log('— 凭据路径（伪造 credentials 服务）—')
{
  const credentialCalls = []
  const store = { token: 'stored-token' }
  const credentials = {
    async describe() {
      return { configured: store.token !== '', source: 'store', writable: true }
    },
    async resolve() {
      return store.token === '' ? undefined : { value: store.token, source: 'store' }
    },
    async set(ref, value) {
      credentialCalls.push(['set', ref, value])
      store.token = value
    },
    async unset(ref) {
      credentialCalls.push(['unset', ref])
      store.token = ''
    },
  }
  const routes2 = []
  const tools2 = []
  const injectable2 = {
    get: (name) => (name === 'credentials' ? credentials : undefined),
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { info: () => {} },
    tools: {
      register: (definition) => {
        tools2.push(definition)
        return () => {}
      },
    },
    webServer: {
      register: (route) => {
        routes2.push(route)
        return () => {}
      },
    },
  }
  const outer2 = {
    get: injectable2.get,
    effect: injectable2.effect,
    logger: injectable2.logger,
    inject: (_deps, callback) => callback(injectable2),
    get tools() {
      throw new Error('cannot get property "tools" without inject')
    },
    get webServer() {
      throw new Error('cannot get property "webServer" without inject')
    },
  }
  plugin.apply(outer2)

  const call2 = async (method, body) => {
    const request = makeRequest({ url: `/siyuan/api/${method}`, body })
    const response = makeResponse()
    await routes2[0].handler(request, response)
    return { status: response.status, payload: JSON.parse(response.body) }
  }

  const stateWithToken = await call2('getState', {})
  check('已配置 token 时 getState 报告 configured/来源/可写', stateWithToken.payload?.value?.token?.configured === true && stateWithToken.payload?.value?.token?.source === 'store' && stateWithToken.payload?.value?.token?.writable === true, JSON.stringify(stateWithToken.payload?.value?.token))
  check('getState 不回显 token 值', !JSON.stringify(stateWithToken.payload).includes('stored-token'))

  const setToken = await call2('setToken', { token: '  new-token  ' })
  check('setToken 写入凭据库并去除首尾空白', setToken.payload?.ok === true && credentialCalls.some((entry) => entry[0] === 'set' && entry[1] === 'SIYUAN_TOKEN' && entry[2] === 'new-token'), JSON.stringify(credentialCalls))

  const emptyToken = await call2('setToken', { token: '   ' })
  check('空 token 被拒绝', emptyToken.payload?.ok === false, JSON.stringify(emptyToken.payload))

  const clear = await call2('clearToken', {})
  check('clearToken 调用 unset', clear.payload?.ok === true && credentialCalls.some((entry) => entry[0] === 'unset' && entry[1] === 'SIYUAN_TOKEN'), JSON.stringify(credentialCalls))
  check('清除后 token 变为未配置', clear.payload?.value?.token?.configured === false, JSON.stringify(clear.payload?.value?.token))
}

// C8：插件被卸载（ctx.effect 的 disposer）时必须把工具与路由都释放掉。改前这里从没跑过。
console.log('— 卸载路径 —')
{
  const before = tools.length
  const routesBefore = routes.length
  check('卸载前工具与路由都还在', before > 0 && routesBefore === 1, `tools=${before} routes=${routesBefore}`)
  for (const dispose of disposers.splice(0)) dispose()
  check('卸载后工具全部注销', tools.length === 0, `剩余 ${tools.length}`)
  check('卸载后路由全部注销', routes.length === 0, `剩余 ${routes.length}`)
}

console.log('')
if (mock !== null) await mock.close()
if (failures.length === 0) {
  console.log('全部通过 ✅')
  cleanupHome()
  process.exit(0)
}
console.log(`${failures.length} 项失败（临时 home 保留在 ${TEST_HOME}）：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
