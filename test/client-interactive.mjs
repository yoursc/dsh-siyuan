/**
 * dsh-siyuan 设置页交互层：用可执行的 hooks 替身 + fetch 替身驱动点击/输入，断言
 * 「每张卡各自保存」「探测用草稿」「逐工具开关」这些交互约定真正落到请求体上。
 *
 * 夹具来自宿主真实产出（`buildHostState()`），不手抄字段形状；`enabled` 由宿主自己解析。
 * 覆盖不到的部分：真实 React 语义、CSS、浏览器事件——这些要等 dsh web 挂载后在页面上确认。
 *
 * 用法：node test/client-interactive.mjs
 */

import fs from 'node:fs'
import { buildHostState, createHooks, findButton, findSwitch, flattenText, loadClientModule, renderOnce, switches } from './client-harness-lib.mjs'

const failures = []
function check(label, condition, detail) {
  if (condition === true) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}`)
  }
}

// ── 夹具（宿主真实产出） ───────────────────────────────────────────────────

// 默认场景 = 出厂默认：read + daily 开（8 个），write + danger 关。
const { home, payload } = await buildHostState({ toolState: { read: true, daily: true } })
const stateForClient = {
  ...payload,
  // 展示用场景值（本机没有思源可探测）；其余字段全部来自宿主产出。
  reachable: true,
  version: '3.8.3',
  token: { configured: true, source: 'credentials', writable: true },
}
const TOOL_COUNT = stateForClient.tools.length
const DEFAULT_ENABLED = stateForClient.tools.filter((entry) => entry.enabled).length
check('夹具含全部工具定义（与开关无关）', TOOL_COUNT === 17 && DEFAULT_ENABLED === 8, `${TOOL_COUNT} / ${DEFAULT_ENABLED}`)
check('夹具不回显 token 值', !JSON.stringify(stateForClient).includes('stored-token'))

// ── 加载 bundle ────────────────────────────────────────────────────────────

let runtime = createHooks()
let renderingRuntime = null
const { exportsObject } = await loadClientModule(() => ({
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => renderingRuntime.hooks.useState(initial),
  useCallback: (fn) => renderingRuntime.hooks.useCallback(fn),
  useEffect: (fn) => renderingRuntime.hooks.useEffect(fn),
}))
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

// ── 可编程 fetch 替身 ──────────────────────────────────────────────────────

let stateForFetch = stateForClient

/**
 * 用真实的 Response 让 `response.json()` 行为与线上一致。
 * `overrides[method]` 支持：`{ok:false,message}`（宿主错误信封）、`{rawText}`、`{value}`、
 * `{httpStatus}`；`network` 直接网络失败；`timeout` 抛 TimeoutError（模拟 AbortSignal 超时）。
 * 每个调用记录 body 与 hasSignal（api() 必须给 fetch 挂超时信号）。
 */
function createFetchStub({ overrides = {}, network = false, timeout = false, hang = [] } = {}) {
  const calls = []
  const stub = async (url, init) => {
    const method = String(url).replace('/siyuan/api/', '')
    calls.push({ method, body: init?.body === undefined ? undefined : JSON.parse(init.body), hasSignal: init?.signal instanceof AbortSignal })
    // `hang`：让某个路由永不 resolve，用来观察"请求进行中"时的界面（各卡是否互相锁死）。
    if (hang.includes(method)) return new Promise(() => {})
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
      // 宿主的语义：只覆盖 body 里出现的字段；tools 走逐工具解析（这里等价地映射 enabled）。
      const body = JSON.parse(init.body)
      const config = { ...stateForFetch.config }
      if (typeof body.baseUrl === 'string') config.baseUrl = body.baseUrl
      if (typeof body.defaultNotebook === 'string') config.defaultNotebook = body.defaultNotebook
      if (body.tools !== null && typeof body.tools === 'object') config.tools = body.tools
      const tools = stateForFetch.tools.map((entry) => (typeof body.tools?.[entry.name] === 'boolean' ? { ...entry, enabled: body.tools[entry.name] } : entry))
      stateForFetch = { ...stateForFetch, config, tools }
      return Response.json({ ok: true, value: stateForFetch })
    }
    if (method === 'setToken') {
      stateForFetch = { ...stateForFetch, token: { configured: true, source: 'credentials', writable: true } }
      return Response.json({ ok: true, value: stateForFetch })
    }
    if (method === 'clearToken') {
      stateForFetch = { ...stateForFetch, token: { configured: false, source: '', writable: true } }
      return Response.json({ ok: true, value: stateForFetch })
    }
    if (method === 'listNotebooks') {
      return Response.json({ ok: true, value: { baseUrl: 'http://127.0.0.1:6806', notebooks: [{ id: 'nb-a', name: '收件箱', closed: false }] } })
    }
    if (method === 'testConnection') {
      return Response.json({ ok: true, value: { ok: false, version: '', baseUrl: 'http://127.0.0.1:6806', tokenConfigured: false, tokenSource: '', probes: [{ label: '系统版本 /api/system/version', ok: false, detail: '思源接口失败：code=-1 msg=Auth failed' }] } })
    }
    return Response.json({ ok: true, value: null })
  }
  return { stub, calls }
}

// ── 渲染辅助 ───────────────────────────────────────────────────────────────

const render = () => {
  renderingRuntime = runtime
  return renderOnce(Section, {}, runtime, { ignoreEffects: true })
}
const mountRender = () => {
  renderingRuntime = runtime
  return renderOnce(Section, {}, runtime)
}
const textOf = () => render().text
const elementsOf = () => render().elements
const messages = () =>
  elementsOf()
    .filter((element) => typeof element.props?.className === 'string' && element.props.className.startsWith('dsy-msg'))
    .map((element) => flattenText([element]))
    .join(' || ')
const button = (label) => {
  const hit = findButton(elementsOf(), label)
  if (hit === undefined) throw new Error(`找不到按钮：${label}`)
  return hit
}
const inputOf = (id) => elementsOf().find((element) => element.type === 'input' && element.props.id === id)
const selectOf = () => elementsOf().find((element) => element.type === 'select')
const callsOf = (stub, method) => stub.calls.filter((call) => call.method === method)
/** 每个用例一套干净的 hook 运行时与 fetch 替身（并把宿主状态还原成出厂默认）。 */
function startCase(options) {
  runtime = createHooks()
  stateForFetch = stateForClient
  const fetchStub = createFetchStub(options)
  globalThis.fetch = fetchStub.stub
  return fetchStub
}
async function mount() {
  mountRender()
  await runtime.flushEffects()
}
/**
 * 再渲染一次并跑完 effect：模拟 React 在 state 更新后重跑 effect。宿主返回配置后的
 * "自动拉笔记本列表"就走这一步（替身的 useEffect 不看依赖数组，每次渲染都重新登记）。
 */
async function settle() {
  renderingRuntime = runtime
  renderOnce(Section, {}, runtime)
  await runtime.flushEffects()
}

// ── 加载路径 ───────────────────────────────────────────────────────────────

console.log('— 加载路径 —')
{
  const stub = startCase()
  mountRender()
  check('未加载时渲染加载态', /正在读取配置/.test(textOf()), textOf())
  await runtime.flushEffects()
  // React 契约：effect 只能返回清理函数或 undefined，返回 promise 会触发控制台报错。
  check('挂载 effect 返回 undefined（不得返回 promise）', runtime.lastEffectReturn === undefined, String(runtime.lastEffectReturn))
  // api() 必须给 fetch 挂超时 signal（兜底超时的前提）。
  check('api() 的 fetch 带超时取消信号', callsOf(stub, 'getState')[0]?.hasSignal === true)
  check('挂载时自动调用宿主 getState 一次', callsOf(stub, 'getState').length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('请求体是空对象', JSON.stringify(callsOf(stub, 'getState')[0]?.body) === '{}')
  const loaded = textOf()
  check('加载成功后渲染四张卡', ['连接', 'API token', '默认笔记本', '工具开关'].every((title) => loaded.includes(title)), loaded.slice(0, 160))
  check('初始计数来自宿主 enabled（8/17）', /已启用 8 \/ 共 17 个/.test(loaded), loaded.slice(-200))
  check('加载成功不显示错误', messages() === '', messages())
  check('干净状态下提示已保存', /所有改动都已保存/.test(loaded), loaded.slice(-120))
}

console.log('— 错误态 —')
{
  startCase({ overrides: { getState: { ok: false, message: '凭据服务不可用' } } })
  await mount()
  check('宿主 ok:false 时显示错误文案', /读取配置失败：凭据服务不可用/.test(messages()), messages())
  check('错误态用 err 样式', elementsOf().some((element) => element.props?.className === 'dsy-msg err'))
  check('错误时仍停在加载分支（state 为 null）', /正在读取配置/.test(textOf()) && !/工具开关/.test(textOf()), textOf().slice(0, 120))
}
{
  startCase({ overrides: { getState: { rawText: '<html>nope</html>' } } })
  await mount()
  check('宿主返回非 JSON 时显示错误而不是崩', /读取配置失败/.test(messages()), messages())
}
{
  startCase({ overrides: { getState: { httpStatus: 500 } } })
  await mount()
  check('宿主 HTTP 失败时显示错误', /读取配置失败/.test(messages()), messages())
}
{
  startCase({ network: true })
  await mount()
  check('网络失败时显示错误而不是崩', /读取配置失败/.test(messages()), messages())
}
{
  // AbortSignal.timeout 抛的是 TimeoutError，api() 要映射成可读文案，不能把浏览器原文怼给用户。
  startCase({ timeout: true })
  await mount()
  check('请求超时时显示可读文案而不是崩', /请求超时/.test(messages()), messages())
}

// ── 连接卡：各自保存 + 草稿探测 ────────────────────────────────────────────

console.log('— 连接卡：保存地址（只提交本卡字段）—')
{
  const stub = startCase()
  await mount()
  check('没改动时「保存地址」禁用', button('保存地址').props.disabled === true)
  inputOf('dsy-base-url').props.onChange({ target: { value: 'http://127.0.0.1:9999' } })
  check('改动后按钮可用', button('保存地址').props.disabled === false)
  check('出现「撤销」', findButton(elementsOf(), '撤销') !== undefined)
  check('未保存提示', /有未保存的改动/.test(textOf()), textOf().slice(-120))

  await button('保存地址').props.onClick()
  const update = callsOf(stub, 'updateConfig')
  check('保存地址调用 updateConfig', update.length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('请求体**只有 baseUrl**（不夹带笔记本/开关）', JSON.stringify(update[0]?.body) === JSON.stringify({ baseUrl: 'http://127.0.0.1:9999' }), JSON.stringify(update[0]?.body))
  check('保存后提示已保存', /地址已保存。/.test(messages()), messages())
  check('保存后按钮回到禁用（草稿已对齐宿主）', button('保存地址').props.disabled === true)
  check('保存后「撤销」消失', findButton(elementsOf(), '撤销') === undefined)
  check('保存后重新回到"都已保存"', /所有改动都已保存/.test(textOf()), textOf().slice(-120))
}
{
  startCase({ overrides: { updateConfig: { ok: false, message: 'baseUrl 不是合法的 http(s) 地址：「x」' } } })
  await mount()
  inputOf('dsy-base-url').props.onChange({ target: { value: 'x' } })
  await button('保存地址').props.onClick()
  check('保存失败显示「保存地址失败：」+ 宿主原因', /保存地址失败：baseUrl 不是合法的 http/.test(messages()), messages())
}

console.log('— 连接卡：测试连接用草稿（不必先保存）—')
{
  const stub = startCase()
  await mount()
  inputOf('dsy-base-url').props.onChange({ target: { value: 'http://127.0.0.1:7777' } })
  inputOf('dsy-token').props.onChange({ target: { value: 'draft-token' } })
  await button('测试连接').props.onClick()
  const probeCall = callsOf(stub, 'testConnection')[0]
  check('测试连接发的是页面里正在编辑的地址与 token', probeCall?.body?.baseUrl === 'http://127.0.0.1:7777' && probeCall?.body?.token === 'draft-token', JSON.stringify(probeCall?.body))
  check('探测没有顺手保存配置', callsOf(stub, 'updateConfig').length === 0, JSON.stringify(stub.calls.map((call) => call.method)))
  check('有失败项时给出错误提示', /有探测项失败，详见下方。/.test(messages()), messages())
  check('失败项渲染出思源的 msg', /Auth failed/.test(textOf()), textOf().slice(-200))
  check('探测明细显示实际探测的地址', /探测地址：http:\/\/127\.0\.0\.1:6806/.test(textOf()), textOf().slice(-200))
}
{
  startCase({ overrides: { testConnection: { value: { ok: true, version: '3.8.3', baseUrl: 'http://127.0.0.1:6806', tokenConfigured: true, tokenSource: 'draft', probes: [{ label: '系统版本', ok: true, detail: '3.8.3' }] } } } })
  await mount()
  await button('测试连接').props.onClick()
  check('全部探测通过时提示连接正常与版本', /连接正常，思源版本 3\.8\.3。/.test(messages()), messages())
}

// ── token 路径 ─────────────────────────────────────────────────────────────

console.log('— token 路径 —')
{
  const stub = startCase()
  await mount()
  await button('保存 token').props.onClick()
  check('空 token 本地拒绝且不发请求', callsOf(stub, 'setToken').length === 0 && /token 为空/.test(messages()), `${JSON.stringify(stub.calls.map((call) => call.method))} / ${messages()}`)

  inputOf('dsy-token').props.onChange({ target: { value: '  new-token  ' } })
  await button('保存 token').props.onClick()
  const setTokenCall = callsOf(stub, 'setToken')[0]
  check('保存 token 调用 setToken 并原样传值（trim 由宿主负责）', setTokenCall?.body?.token === '  new-token  ', JSON.stringify(setTokenCall?.body))
  check('保存成功后清空输入框（不回显）', inputOf('dsy-token').props.value === '')
  check('保存成功后提示写入凭据库', /token 已存入宿主凭据库。/.test(messages()), messages())

  await button('清除').props.onClick()
  check('清除调用 clearToken', callsOf(stub, 'clearToken').length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('清除后提示已清除', /已清除 token。/.test(messages()), messages())
}

// ── 默认笔记本 ─────────────────────────────────────────────────────────────

console.log('— 打开页面自动拉笔记本列表 —')
{
  const stub = startCase()
  await mount()
  check('挂载本身不发笔记本请求（先拿配置）', callsOf(stub, 'listNotebooks').length === 0, JSON.stringify(stub.calls.map((call) => call.method)))
  await settle()
  check('配置到手后静默拉一次列表', callsOf(stub, 'listNotebooks').length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('自动拉取带草稿地址（与手动点按钮同一套参数）', typeof callsOf(stub, 'listNotebooks')[0]?.body?.baseUrl === 'string', JSON.stringify(callsOf(stub, 'listNotebooks')[0]?.body))
  check('自动拉取不刷消息（用户没点按钮）', messages() === '', messages())
  check('列表已就位（下拉里有 nb-a）', elementsOf().some((element) => element.type === 'option' && element.props.value === 'nb-a'))
}

console.log('— 默认笔记本卡 —')
{
  const stub = startCase()
  await mount()
  await button('加载笔记本').props.onClick()
  check('加载笔记本调用 listNotebooks', callsOf(stub, 'listNotebooks').length === 1, JSON.stringify(stub.calls.map((call) => call.method)))
  check('加载笔记本带草稿地址（不必先保存）', typeof callsOf(stub, 'listNotebooks')[0]?.body?.baseUrl === 'string', JSON.stringify(callsOf(stub, 'listNotebooks')[0]?.body))
  check('加载后下拉出现新笔记本', elementsOf().some((element) => element.type === 'option' && element.props.value === 'nb-a'), textOf().slice(-200))
  check('加载后提示数量', /已加载 1 个笔记本。/.test(messages()), messages())

  selectOf().props.onChange({ target: { value: 'nb-a' } })
  check('选完笔记本后「保存笔记本」可用', button('保存笔记本').props.disabled === false)
  await button('保存笔记本').props.onClick()
  const update = callsOf(stub, 'updateConfig')
  check('保存笔记本只提交 defaultNotebook', JSON.stringify(update[0]?.body) === JSON.stringify({ defaultNotebook: 'nb-a' }), JSON.stringify(update[0]?.body))
  check('保存笔记本后按钮回到禁用', button('保存笔记本').props.disabled === true)
}

// ── 工具开关（逐个工具） ───────────────────────────────────────────────────

console.log('— 工具开关：逐工具 —')
{
  const stub = startCase()
  await mount()
  const searchSwitch = findSwitch(elementsOf(), 'siyuan_search')
  check('每个工具一个椭圆开关（21 = 17 工具 + 4 组）', switches(elementsOf()).length === 21, String(switches(elementsOf()).length))
  searchSwitch.props.onClick()
  check('关掉一个工具后计数减一（8 → 7）', /已启用 7 \/ 共 17 个/.test(textOf()), textOf().slice(-200))
  check('只动这一个工具', findSwitch(elementsOf(), 'siyuan_sql').props['aria-checked'] === true)

  await button('保存开关').props.onClick()
  const body = callsOf(stub, 'updateConfig')[0]?.body
  const toolKeys = Object.keys(body?.tools ?? {})
  check('保存开关提交**完整**的逐工具映射（17 个键，宿主整层替换）', toolKeys.length === TOOL_COUNT && toolKeys.every((key) => key.startsWith('siyuan_')), `${toolKeys.length}: ${toolKeys.slice(0, 3).join(',')}`)
  check('提交里 siyuan_search 为 false，其余保持原状', body?.tools?.siyuan_search === false && body?.tools?.siyuan_sql === true && body?.tools?.siyuan_delete_block === false, JSON.stringify({ search: body?.tools?.siyuan_search, sql: body?.tools?.siyuan_sql, del: body?.tools?.siyuan_delete_block }))
  check('保存开关不夹带地址与笔记本', body?.baseUrl === undefined && body?.defaultNotebook === undefined, JSON.stringify(body))
  check('保存后提示已生效', /工具开关已生效/.test(messages()), messages())
  check('保存后按钮回到禁用（对齐宿主返回的 enabled）', button('保存开关').props.disabled === true)
}

console.log('— 工具开关：组开关与批量 —')
{
  startCase()
  await mount()
  const writeGroup = findSwitch(elementsOf(), '写入整组开关')
  check('整组全关时组开关是关的', writeGroup.props['aria-checked'] === false)
  writeGroup.props.onClick()
  check('整组打开后计数 8 → 15', /已启用 15 \/ 共 17 个/.test(textOf()), textOf().slice(-200))
  check('组内 7 个开关全开', ['siyuan_create_doc', 'siyuan_rename_doc', 'siyuan_move_doc'].every((name) => findSwitch(elementsOf(), name).props['aria-checked'] === true))

  findSwitch(elementsOf(), 'siyuan_create_doc').props.onClick()
  check('组内只开一部分时组开关是 mixed', findSwitch(elementsOf(), '写入整组开关').props['aria-checked'] === 'mixed', String(findSwitch(elementsOf(), '写入整组开关').props['aria-checked']))

  await button('全部停用').props.onClick()
  check('「全部停用」后计数为 0', /已启用 0 \/ 共 17 个/.test(textOf()), textOf().slice(-200))
  check('「全部停用」后所有工具开关都关', switches(elementsOf()).filter((element) => !String(element.props['aria-label']).includes('整组')).every((element) => element.props['aria-checked'] === false))

  await button('撤销').props.onClick()
  check('撤销后回到"已保存"状态', /已启用 8 \/ 共 17 个/.test(textOf()) && /所有改动都已保存/.test(textOf()), textOf().slice(-200))
}

console.log('— 重新读取 —')
{
  startCase()
  await mount()
  findSwitch(elementsOf(), 'siyuan_search').props.onClick()
  check('改动后页脚提示未保存', /有未保存的改动/.test(textOf()), textOf().slice(-140))
  await button('重新读取').props.onClick()
  check('重新读取丢弃草稿（回到宿主状态）', /已启用 8 \/ 共 17 个/.test(textOf()) && /所有改动都已保存/.test(textOf()), textOf().slice(-200))
}

console.log('— 工具行：整行可点 / 键盘 / 拖选保护 —')
{
  startCase()
  await mount()
  const row = findSwitch(elementsOf(), 'siyuan_sql')
  row.props.onClick({ currentTarget: row })
  check('点行内任意位置都能切（不再只有 34×20 的小圆钮可点）', /已启用 7 \/ 共 17 个/.test(textOf()), textOf().slice(-120))
  row.props.onKeyDown({ key: ' ', preventDefault: () => {}, currentTarget: row })
  check('空格键可切', /已启用 8 \/ 共 17 个/.test(textOf()), textOf().slice(-120))
  row.props.onKeyDown({ key: 'Enter', preventDefault: () => {}, currentTarget: row })
  check('回车键可切', /已启用 7 \/ 共 17 个/.test(textOf()), textOf().slice(-120))
  row.props.onKeyDown({ key: 'a', preventDefault: () => {}, currentTarget: row })
  check('其他按键不切', /已启用 7 \/ 共 17 个/.test(textOf()), textOf().slice(-120))

  // 拖选文字：选区落在这一行里时，点击不该顺手把开关切了。
  globalThis.window.getSelection = () => ({ isCollapsed: false, containsNode: (node) => node === row })
  row.props.onClick({ currentTarget: row })
  check('拖选本行文字后点击不会误切', /已启用 7 \/ 共 17 个/.test(textOf()), textOf().slice(-120))
  globalThis.window.getSelection = () => ({ isCollapsed: false, containsNode: () => false })
  row.props.onClick({ currentTarget: row })
  check('选区不在本行时照常切换', /已启用 8 \/ 共 17 个/.test(textOf()), textOf().slice(-120))
  delete globalThis.window.getSelection
}
{
  // 保存中：整行不可点也不可聚焦（pending 期间不给误操作的机会）
  startCase({ hang: ['updateConfig'] })
  await mount()
  const row = findSwitch(elementsOf(), 'siyuan_search')
  row.props.onClick({ currentTarget: row })
  button('保存开关').props.onClick() // 不 await：updateConfig 永远挂着
  const busyRow = findSwitch(elementsOf(), 'siyuan_search')
  check('保存中：整行 aria-disabled 且移出 tab 序', busyRow.props['aria-disabled'] === true && busyRow.props.tabIndex === -1, JSON.stringify({ disabled: busyRow.props['aria-disabled'], tabIndex: busyRow.props.tabIndex }))
  const frozen = textOf()
  busyRow.props.onClick({ currentTarget: busyRow })
  check('保存中点行不会改计数', textOf() === frozen, textOf().slice(-120))
}

console.log('— 各卡互不锁定 —')
{
  startCase({ hang: ['setToken'] })
  await mount()
  inputOf('dsy-token').props.onChange({ target: { value: 'tok' } })
  button('保存 token').props.onClick() // 故意不 await：让 token 卡停在"进行中"
  check('请求进行中的那张卡自己禁用', button('保存 token').props.disabled === true)
  check('别的卡不受影响（工具开关仍可点）', findSwitch(elementsOf(), 'siyuan_search').props['aria-disabled'] !== true && findSwitch(elementsOf(), 'siyuan_search').props.tabIndex === 0, JSON.stringify({ disabled: findSwitch(elementsOf(), 'siyuan_search').props['aria-disabled'], tabIndex: findSwitch(elementsOf(), 'siyuan_search').props.tabIndex }))
  check('别的卡不受影响（测试连接仍可点）', button('测试连接').props.disabled === false)
  check('「重新读取」在有任何请求时都禁用（它会整体重载）', button('重新读取').props.disabled === true)
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过 ✅')
  fs.rmSync(home, { recursive: true, force: true })
  process.exit(0)
}
console.log(`${failures.length} 项失败（夹具目录保留在 ${home}）：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
