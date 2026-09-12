/**
 * dsh-siyuan 客户端交互层测试。
 *
 * 与 client-render.mjs 的分工：那边只断言「渲染出来的静态结构」，这边真的**执行**设置页的
 * 交互路径 —— `api()` 的信封处理、`run()` 的错误态、保存 token/清除/加载笔记本/
 * 连接测试/保存设置，以及全开全关与复选框。
 *
 * 夹具来自宿主真实产出（`internals.buildStatePayload`），不是手抄的形状。
 *
 * 用法：node test/client-interactive.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHooks, loadClientModule, renderOnce, findButton, flattenText } from './client-harness-lib.mjs'

const failures = []
/** 成功时清掉临时 home；失败时保留，便于取证（路径会随失败清单一起打印）。 */
function cleanupHome() {
  if (failures.length === 0) fs.rmSync(TEST_HOME, { recursive: true, force: true })
}

function check(label, condition, detail) {
  if (condition === true) console.log(`  ok   ${label}`)
  else {
    failures.push(label + (detail === undefined ? '' : ` — ${detail}`))
    console.log(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}`)
  }
}

// ── 宿主真实产出（夹具来源） ────────────────────────────────────────────────

// 每次跑用独立临时目录：并行执行（或同机多个 CI job）不会互相删配置。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-client-interactive-'))
fs.mkdirSync(`${TEST_HOME}/storages/siyuan`, { recursive: true })
process.env.DSH_HOME = TEST_HOME
fs.writeFileSync(
  `${TEST_HOME}/storages/siyuan/config.json`,
  JSON.stringify({
    baseUrl: 'http://127.0.0.1:6806',
    defaultNotebook: '20260723165907-3zj91ge',
    tools: { read: true, write: true, daily: true, danger: false },
  }),
)

const host = await import('../lib/index.js')
const credentials = {
  async describe() {
    return { configured: true, source: 'credentials', writable: true }
  },
  async resolve() {
    return { value: 'stored-token', source: 'credentials' }
  },
}
const stateCtx = { get: (name) => (name === 'credentials' ? credentials : undefined), logger: { info: () => {}, warn: () => {} } }

// 让真实插件注册工具，再取它真实的 getState 产出——夹具与线上同源。
const registeredTools = []
// 全部 17 个定义（含默认关闭的 danger 两个）：工具总数与开关无关，夹具要按真实情况给。
const ALL_TOOL_SHAPE = [
  ...Array.from({ length: 7 }, (_, i) => ({ name: `siyuan_read_${i}`, group: 'read' })),
  ...Array.from({ length: 7 }, (_, i) => ({ name: `siyuan_write_${i}`, group: 'write' })),
  ...Array.from({ length: 1 }, (_, i) => ({ name: `siyuan_daily_${i}`, group: 'daily' })),
  ...Array.from({ length: 2 }, (_, i) => ({ name: `siyuan_danger_${i}`, group: 'danger' })),
]
const fakeInject = {
  get: () => undefined,
  effect: (callback) => {
    callback()
    return () => {}
  },
  logger: { info: () => {}, warn: () => {} },
  tools: {
    register: (definition) => {
      registeredTools.push({ group: definition.group, definition })
      return () => {}
    },
  },
  webServer: { register: () => () => {} },
}
host.apply({
  ...fakeInject,
  inject: (_deps, callback) => callback(fakeInject),
  get tools() {
    throw new Error('cannot get property "tools" without inject')
  },
  get webServer() {
    throw new Error('cannot get property "webServer" without inject')
  },
})

// 夹具来自宿主真实产出（internals.buildStatePayload）。C5：buildStatePayload 会真实
// 探测 config.baseUrl（本文件写的是 127.0.0.1:6806），本机恰好跑着思源时测试会打到
// **真实实例**。生成夹具前临时换成必败 fetch，让探测不出网；计数器断言探测被替身接住。
const realFetch = globalThis.fetch
let probeHits = 0
globalThis.fetch = async () => {
  probeHits += 1
  throw new TypeError('probe disabled by test')
}
const realState = await host.internals.buildStatePayload(stateCtx, registeredTools)
globalThis.fetch = realFetch
check('夹具生成未探测真实实例（探测被必败 fetch 替身接住）', probeHits >= 1, String(probeHits))
const realGroups = [...new Set(realState.toolNames.map((entry) => entry.group))].sort()
// 注册的只有默认开启的三组（15 个）；工具总数由全部定义决定，与开关无关。
check('工具定义含分组信息（read/write 各 7、daily 1）', realGroups.join(',') === 'daily,read,write' && realState.toolNames.length === 15, `${realState.toolNames.length} / ${JSON.stringify(realGroups)}`)
// getState 返回的是全部定义（17 个），与注册表里已开启的数量无关。
const stateForClient = { ...realState, toolNames: ALL_TOOL_SHAPE }
check('真实产出不回显 token 值', !JSON.stringify(realState).includes('stored-token'))

// ── 可编程 fetch 替身 ───────────────────────────────────────────────────────

let stateForFetch = realState

/**
 * 用真实的 Response 对象，让 `response.json()` 的行为与线上一致。
 * `overrides[method]` 支持：`{ok:false,message}`（宿主错误信封）、`{rawText}`（非 JSON）、
 * `{value}`（自定义成功值）、`{httpStatus}`（HTTP 层失败）。
 * `network`：fetch 直接网络失败；`timeout`：抛 TimeoutError（模拟 AbortSignal.timeout
 * 超时，C11）。每个调用记录 `hasSignal`（C11 守卫：api() 必须给 fetch 挂超时 signal）。
 */
function createFetchStub({ overrides = {}, network = false, timeout = false } = {}) {
  const calls = []
  const stub = async (url, init) => {
    const method = String(url).replace('/siyuan/api/', '')
    calls.push({
      method,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
      hasSignal: init?.signal instanceof AbortSignal,
    })
    if (network) throw new TypeError('fetch failed')
    if (timeout) {
      const timeoutError = new Error('The operation was aborted due to timeout')
      timeoutError.name = 'TimeoutError'
      throw timeoutError
    }
    const override = overrides[method]
    if (override !== undefined) {
      if (override.rawText !== undefined) return new Response(override.rawText, { status: override.status ?? 200 })
      if (override.httpStatus !== undefined) return new Response('{}', { status: override.httpStatus })
      if (override.ok === false) return Response.json({ ok: false, error: { message: override.message ?? 'boom' } })
      return Response.json({ ok: true, value: override.value ?? null })
    }
    if (method === 'getState') return Response.json({ ok: true, value: stateForFetch })
    if (method === 'updateConfig') {
      const body = JSON.parse(init.body)
      stateForFetch = { ...stateForFetch, config: { ...stateForFetch.config, ...body } }
      return Response.json({ ok: true, value: stateForFetch })
    }
    if (method === 'testConnection') {
      return Response.json({
        ok: true,
        value: {
          ok: false,
          version: '3.8.3',
          tokenConfigured: true,
          probes: [
            { label: '系统版本', ok: true, detail: '3.8.3' },
            { label: '列出笔记本', ok: false, detail: '思源接口 /api/notebook/lsNotebooks 失败：code=-1 msg=Auth failed' },
            { label: 'SQL 查询', ok: true, detail: '[]' },
          ],
        },
      })
    }
    if (method === 'listNotebooks') return Response.json({ ok: true, value: { notebooks: [{ id: 'nb-a', name: '收件箱', closed: false }] } })
    if (method === 'setToken') return Response.json({ ok: true, value: stateForFetch })
    if (method === 'clearToken') {
      stateForFetch = { ...stateForFetch, token: { configured: false, source: '', writable: true } }
      return Response.json({ ok: true, value: stateForFetch })
    }
    return Response.json({ ok: true, value: null })
  }
  return { stub, calls }
}

// ── 加载客户端 bundle ───────────────────────────────────────────────────────

let runtime = createHooks()
// 注意：factory 只在加载时执行一次，不能用模块级 runtime（它会被每个用例替换）。
// 组件的 props 里带着本次渲染的 runtime，hook 实现从那里取。
const { exportsObject } = await loadClientModule(() => ({
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => currentHooks().useState(initial),
  useCallback: (fn) => currentHooks().useCallback(fn),
  useEffect: (fn) => currentHooks().useEffect(fn),
}))
/** 当前渲染的 hook 运行时由 render() 设置。 */
let renderingRuntime = null
function currentHooks() {
  if (renderingRuntime === null) throw new Error('组件在 render() 之外被渲染，拿不到 hook 运行时')
  return renderingRuntime.hooks
}
let registered = null
exportsObject.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register: (contract, component) => {
      registered = { contract, component }
      return () => {}
    },
  },
})
const Section = registered.component

/** 每个用例一套干净的 hook 运行时与 fetch 替身。 */
function startCase(options) {
  runtime = createHooks()
  stateForFetch = stateForClient
  const fetchStub = createFetchStub(options)
  globalThis.fetch = fetchStub.stub
  return fetchStub
}

const render = () => {
  renderingRuntime = runtime
  return renderOnce(Section, { close: () => {} }, runtime, { ignoreEffects: true })
}
/** 挂载并等待组件内部的 load() 完成（useEffect 里调用的那一次）。 */
const mountRender = () => {
  renderingRuntime = runtime
  return renderOnce(Section, { close: () => {} }, runtime)
}
const textOf = () => render().text
const statusOf = () => {
  const message = render().elements.find((element) => typeof element.props?.className === 'string' && element.props.className.startsWith('dsy-msg'))
  return message === undefined ? '' : flattenText([message])
}
const button = (label) => {
  const hit = findButton(render().elements, label)
  if (hit === undefined) throw new Error(`找不到按钮：${label}`)
  return hit
}
const checkboxes = () => render().elements.filter((element) => element.type === 'input' && element.props.type === 'checkbox')
const tokenInput = () => render().elements.find((element) => element.type === 'input' && element.props.type === 'password')
const callsOf = (stub, method) => stub.calls.filter((call) => call.method === method)
async function mount() {
  mountRender()
  await runtime.flushEffects()
}

console.log('— 加载路径 —')
{
  const stub = startCase()
  // 挂载渲染：这一步注册 useEffect（组件内部的 load）；此时尚未执行，所以还是加载态。
  mountRender()
  check('未加载时渲染加载态', /正在读取配置/.test(textOf()), textOf())
  await runtime.flushEffects()
  // C8 守卫：effect 的返回值必须是 undefined。React 契约只允许 effect 返回清理函数
  // 或 undefined，返回 promise 会在 dev 构建触发控制台报错、生产行为未定义。
  check('挂载 effect 返回 undefined（不得返回 promise）', runtime.lastEffectReturn === undefined, String(runtime.lastEffectReturn))
  // C11 守卫：api() 必须给 fetch 挂超时 signal（兜底超时的前提）。
  check('api() 的 fetch 带超时取消信号', callsOf(stub, 'getState')[0]?.hasSignal === true, JSON.stringify(callsOf(stub, 'getState')[0]))
  const loaded = textOf()
  check('挂载时自动调用宿主 getState 一次', callsOf(stub, 'getState').length === 1, JSON.stringify(stub.calls))
  check('请求体是空对象', JSON.stringify(callsOf(stub, 'getState')[0]?.body) === '{}', JSON.stringify(callsOf(stub, 'getState')[0]?.body))
  check('加载成功后渲染已加载分支', /工具开关/.test(loaded) && !/正在读取配置/.test(loaded), loaded.slice(0, 140))
  check('初始 draft 来自宿主 config（15 = read7+write7+daily1）', /已启用 15 \/ 共 17/.test(loaded), loaded.slice(-160))
  check('加载成功不显示错误', statusOf() === '', statusOf())
}

console.log('— 错误态 —')
{
  startCase({ overrides: { getState: { ok: false, message: '凭据服务不可用' } } })
  await mount()
  check('宿主 ok:false 时显示错误文案', /读取配置失败：凭据服务不可用/.test(textOf()), textOf().slice(0, 160))
  check('错误态用 err 样式', render().elements.some((element) => element.props?.className === 'dsy-msg err'))
  check('错误时仍停在加载分支（state 为 null）', /正在读取配置/.test(textOf()) && !/工具开关/.test(textOf()), textOf().slice(0, 120))
}
{
  startCase({ overrides: { getState: { rawText: '<html>nope</html>' } } })
  await mount()
  check('宿主返回非 JSON 时显示错误而不是崩', /读取配置失败/.test(textOf()), textOf().slice(0, 160))
}
{
  startCase({ overrides: { getState: { httpStatus: 500 } } })
  await mount()
  check('宿主 HTTP 失败时显示错误', /读取配置失败/.test(textOf()), textOf().slice(0, 160))
}
{
  startCase({ network: true })
  await mount()
  check('网络失败时显示错误而不是崩', /读取配置失败/.test(textOf()), textOf().slice(0, 160))
}
{
  // C11：AbortSignal.timeout 超时抛 TimeoutError，api() 要映射成可读文案，
  // 不能把浏览器原文（"The operation was aborted…"）直接怼给用户。
  startCase({ timeout: true })
  await mount()
  check('请求超时时显示可读文案而不是崩', /请求超时/.test(textOf()), textOf().slice(0, 160))
}

console.log('— 保存设置 —')
{
  const stub = startCase()
  await mount()
  checkboxes()[3].props.onChange({ target: { checked: true } })
  check('勾选后计数即时更新（未保存也生效）', /已启用 17 \/ 共 17/.test(textOf()), textOf().slice(-160))
  await button('保存设置').props.onClick()
  const update = callsOf(stub, 'updateConfig')
  check('保存设置调用 updateConfig', update.length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('请求体是表单 draft（含刚勾选的 danger）', update[0]?.body?.tools?.danger === true && update[0]?.body?.baseUrl === 'http://127.0.0.1:6806', JSON.stringify(update[0]?.body))
  check('保存成功后提示已保存', /已保存。/.test(statusOf()), statusOf())
  check('保存后勾选框仍与 draft 一致', checkboxes()[3].props.checked === true)
}
{
  startCase({ overrides: { updateConfig: { ok: false, message: '宿主的凭据服务不可用' } } })
  await mount()
  await button('保存设置').props.onClick()
  check('保存失败显示"保存失败："+ 宿主原因', /保存失败：宿主的凭据服务不可用/.test(statusOf()), statusOf())
}

console.log('— 工具开关按钮 —')
{
  startCase()
  await mount()
  await button('全关').props.onClick()
  check('点「全关」后计数为 0', /已启用 0 \/ 共 17/.test(textOf()), textOf().slice(-160))
  check('点「全关」后四个复选框都未勾选', checkboxes().every((element) => element.props.checked === false), JSON.stringify(checkboxes().map((element) => element.props.checked)))
  await button('全开').props.onClick()
  check('点「全开」后计数为 17', /已启用 17 \/ 共 17/.test(textOf()), textOf().slice(-160))
}

console.log('— token 路径 —')
{
  const stub = startCase()
  await mount()
  await button('保存 token').props.onClick()
  check('空 token 本地拒绝且不发请求', callsOf(stub, 'setToken').length === 0 && /token 为空/.test(statusOf()), `${JSON.stringify(stub.calls.map((call) => call.method))} / ${statusOf()}`)

  tokenInput().props.onChange({ target: { value: '  new-token  ' } })
  await button('保存 token').props.onClick()
  const setTokenCall = callsOf(stub, 'setToken')[0]
  check('保存 token 调用 setToken 并原样传值（trim 由宿主负责）', setTokenCall?.body?.token === '  new-token  ', JSON.stringify(setTokenCall?.body))
  check('保存成功后清空输入框（不回显）', tokenInput().props.value === '', JSON.stringify(tokenInput().props.value))
  check('保存成功后提示写入凭据库', /token 已存入宿主凭据库。/.test(statusOf()), statusOf())

  await button('清除').props.onClick()
  check('清除调用 clearToken', callsOf(stub, 'clearToken').length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('清除后提示已清除', /已清除 token。/.test(statusOf()), statusOf())
}

console.log('— 笔记本与连接测试 —')
{
  const stub = startCase()
  await mount()
  await button('加载笔记本').props.onClick()
  check('加载笔记本调用 listNotebooks', callsOf(stub, 'listNotebooks').length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('加载后下拉出现新笔记本', render().elements.some((element) => element.type === 'option' && element.props.value === 'nb-a'), textOf().slice(-160))
  check('加载后提示数量', /已加载 1 个笔记本。/.test(statusOf()), statusOf())

  await button('测试连接').props.onClick()
  check('测试连接调用 testConnection', callsOf(stub, 'testConnection').length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('有失败项时给出错误提示', /有探测项失败，详见下方。/.test(statusOf()), statusOf())
  check('失败项渲染出思源的 msg', /Auth failed/.test(textOf()))
}
{
  startCase({ overrides: { testConnection: { value: { ok: true, version: '3.8.3', tokenConfigured: true, probes: [{ label: '系统版本', ok: true, detail: '3.8.3' }] } } } })
  await mount()
  await button('测试连接').props.onClick()
  check('全部探测通过时提示连接正常与版本', /连接正常，思源版本 3\.8\.3。/.test(statusOf()), statusOf())
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过 ✅')
  cleanupHome()
  process.exit(0)
}
console.log(`${failures.length} 项失败（临时 home 保留在 ${TEST_HOME}）：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
