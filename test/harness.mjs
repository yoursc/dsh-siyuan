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
import { startMockSiYuan } from './mock-siyuan.mjs'

const LIVE = process.argv.includes('--live')
// 真实部署的 token 常来自环境变量；显式清掉，避免凭据回退路径污染「未配置」断言。
delete process.env.SIYUAN_TOKEN

// 配置写入隔离到临时 DSH_HOME，测试不动真实 ~/.dsh。
const TEST_HOME = '/tmp/sy-harness-home'
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

const mock = LIVE ? null : await startMockSiYuan()
const DEFAULT_BASE = LIVE ? 'http://127.0.0.1:6806' : mock.baseUrl
// 替身的 token 走凭据假件提供；未配置分支在「凭据路径」段落里用独立实例覆盖。
if (mock !== null) {
  fs.mkdirSync(TEST_HOME + '/storages/siyuan', { recursive: true })
  fs.writeFileSync(
    TEST_HOME + '/storages/siyuan/config.json',
    JSON.stringify({ baseUrl: mock.baseUrl, defaultNotebook: '', tools: { read: true, daily: true } }),
  )
}
console.log(LIVE ? '模式：--live（探测真实实例 127.0.0.1:6806）' : '模式：本地替身（不依赖真实思源）')

const plugin = await import('../lib/index.js')

const failures = []
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

const ctx = {
  get: () => undefined,
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  logger: { info: () => {} },
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

function makeRequest({ method = 'POST', url = '/siyuan/api/getState', headers = { host: '127.0.0.1:3080' }, body = {} } = {}) {
  const payload = Buffer.from(JSON.stringify(body))
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

  const wrongMethod = await call('getState', {}, { method: 'GET' })
  check('非 POST 返回 405', wrongMethod.status === 405)

  const unknown = await call('nope', {})
  check('未知方法返回 404', unknown.status === 404)
}

console.log('— 路由：getState / updateConfig —')
{
  const state = await call('getState', {})
  check('getState ok', state.status === 200 && state.payload?.ok === true, JSON.stringify(state.payload).slice(0, 200))
  check('默认 baseUrl 是设置里的值', state.payload?.value?.config?.baseUrl === DEFAULT_BASE, state.payload?.value?.config?.baseUrl)
  check('默认 read=true / write=false / danger=false', state.payload?.value?.config?.tools?.read === true && state.payload?.value?.config?.tools?.write === false && state.payload?.value?.config?.tools?.danger === false)
  check('思源可达且版本已读取', state.payload?.value?.reachable === true && /^\d+\.\d+/.test(String(state.payload?.value?.version)), JSON.stringify({ reachable: state.payload?.value?.reachable, version: state.payload?.value?.version }))
  check('token 未配置', state.payload?.value?.token?.configured === false, JSON.stringify(state.payload?.value?.token))
  check('预置的 config.json 被读入（baseUrl 来自文件而非默认值）', state.payload?.value?.config?.baseUrl === DEFAULT_BASE, state.payload?.value?.config?.baseUrl)

  const before = tools.length
  const updated = await call('updateConfig', { baseUrl: DEFAULT_BASE + '/', defaultNotebook: '20260723165907-3zj91ge', tools: { write: true, danger: true } })
  check('updateConfig ok', updated.status === 200 && updated.payload?.ok === true, JSON.stringify(updated.payload).slice(0, 200))
  check('baseUrl 去掉了尾部斜杠', updated.payload?.value?.config?.baseUrl === DEFAULT_BASE, updated.payload?.value?.config?.baseUrl)
  check('默认笔记本已保存', updated.payload?.value?.config?.defaultNotebook === '20260723165907-3zj91ge')
  check('工具随开关重新注册（8 → 17）', tools.length === 17 && before === 8, `before=${before} after=${tools.length}`)
  check('旧注册被释放', disposeCount === 8, `disposeCount=${disposeCount}`)
  check('config.json 落盘', fs.existsSync(TEST_HOME + '/storages/siyuan/config.json') === true)

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

console.log('')
if (mock !== null) await mock.close()
if (failures.length === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
}
console.log(`${failures.length} 项失败：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
