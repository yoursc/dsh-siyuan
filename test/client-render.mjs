/**
 * dsh-siyuan 设置页渲染干跑：用最小 React 替身驱动 SiYuanSection 的「已加载」
 * 分支（hooks 状态由替身注入，不跑 useEffect/fetch），遍历 createElement 元素树
 * 断言设置页真正渲染出了连接状态、笔记本选择与四个工具开关。
 *
 * 覆盖不到的部分：真实 React 语义、CSS、浏览器事件（这些等 dsh web 挂载后在
 * 页面上确认）。本文件只证明渲染逻辑分支不会崩、内容正确。
 *
 * 用法：node test/client-render.mjs
 */

import path from 'node:path'

const failures = []
function check(label, condition, detail) {
  if (condition === true) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}`)
  }
}

let captured = null
globalThis.window = { __ModuleLoader__: { load: (module) => (captured = module) } }

// 组件真正被渲染之前，模块作用域只用 e()/createElement；状态注入在 renderComponent 里配置。
let stateOverrides = []
let stateIndex = 0
const noop = () => {}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = stateIndex++
    const override = index < stateOverrides.length ? stateOverrides[index] : undefined
    const value = override !== undefined ? override : typeof initial === 'function' ? initial() : initial
    return [value, noop]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
}

await import(path.join(import.meta.dirname, '..', 'lib', 'client.js'))
const exportsObject = captured.factory((name) => (name === 'react' ? reactStub : {}))

let registered = null
exportsObject.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register: (contract, component) => {
      registered = { contract, component }
      return noop
    },
  },
})

// ── 宿主 getState 的真实形状 ───────────────────────────────────────────────

const hostState = {
  config: {
    baseUrl: 'http://127.0.0.1:6806',
    defaultNotebook: '20260723165907-3zj91ge',
    tools: { read: true, write: true, daily: true, danger: false },
  },
  token: { configured: true, source: 'credentials', writable: true },
  reachable: true,
  version: '3.8.3',
  toolGroups: ['read', 'write', 'daily', 'danger'],
  toolNames: ['siyuan_list_notebooks', 'siyuan_search', 'siyuan_sql', 'siyuan_read_doc', 'siyuan_list_docs', 'siyuan_get_child_blocks', 'siyuan_get_block_attrs', 'siyuan_create_doc', 'siyuan_append_block', 'siyuan_insert_block', 'siyuan_update_block', 'siyuan_set_block_attrs', 'siyuan_move_doc', 'siyuan_rename_doc', 'siyuan_daily_note', 'siyuan_delete_block', 'siyuan_remove_doc'].map((name) => ({ name, group: 'read' })),
}
const draftState = {
  baseUrl: hostState.config.baseUrl,
  defaultNotebook: hostState.config.defaultNotebook,
  tools: { ...hostState.config.tools },
}
const notebooks = [
  { id: '20260723165907-3zj91ge', name: '收件箱', closed: false },
  { id: '20260723173043-icrnx4t', name: '项目', closed: false },
]
const probeState = {
  ok: false,
  version: '3.8.3',
  tokenConfigured: true,
  probes: [
    { label: '系统版本 /api/system/version', ok: true, detail: '3.8.3' },
    { label: '列出笔记本 /api/notebook/lsNotebooks', ok: true, detail: '{"notebooks":[]}' },
    { label: 'SQL 查询 /api/query/sql', ok: false, detail: '思源接口 /api/query/sql 失败：code=-1 msg=Auth failed' },
  ],
}

stateOverrides = [hostState, draftState, notebooks, '', null, probeState, false]
stateIndex = 0

// ── 元素树遍历 ─────────────────────────────────────────────────────────────

const textParts = []
const elements = []

function walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    textParts.push(String(node))
    return
  }
  if (typeof node !== 'object') return
  if (node.type === undefined) return
  elements.push(node)
  if (typeof node.type === 'function') {
    // 函数组件：用同一套替身递归渲染（Message 这类无状态组件）
    walk(node.type(node.props))
    return
  }
  for (const child of node.children ?? []) walk(child)
}

let tree
try {
  tree = registered.component({ close: noop })
  walk(tree)
  check('已加载状态渲染不抛错', true)
} catch (error) {
  check('已加载状态渲染不抛错', false, error.message)
}

const text = textParts.join(' | ')
const inputs = elements.filter((element) => element.type === 'input')
const checkboxes = inputs.filter((element) => element.props.type === 'checkbox')
const selects = elements.filter((element) => element.type === 'select')
const buttons = elements.filter((element) => element.type === 'button')
const optionTexts = elements.filter((element) => element.type === 'option').map((element) => String(element.props.value))

console.log('— 连接卡片 —')
check('标题渲染', /思源笔记/.test(text))
check('可达与版本徽标', /可达 · v3\.8\.3/.test(text), text.slice(0, 200))
check('token 已配置徽标（来源可见、不回显值）', /已配置（credentials）/.test(text), text.slice(0, 300))
check('地址输入框带当前 baseUrl', inputs.some((element) => element.props.type === 'text' && element.props.value === 'http://127.0.0.1:6806'))
check('token 是 password 输入且值为空（不回显）', inputs.some((element) => element.props.type === 'password' && element.props.value === ''))
check('token 可写时不显示只读提示', !/只读来源/.test(text))

console.log('— 笔记本 —')
check('默认笔记本下拉渲染', selects.length >= 1)
check('已加载的笔记本 id 出现在选项里', optionTexts.includes('20260723165907-3zj91ge') && optionTexts.includes('20260723173043-icrnx4t'), optionTexts.join(','))
check('选项文本含名称与 id', /收件箱 · 20260723165907-3zj91ge/.test(text))
check('下拉当前值为默认笔记本', selects.some((element) => element.props.value === '20260723165907-3zj91ge'))

console.log('— 工具开关 —')
check('四个分组各一个复选框', checkboxes.length === 4, String(checkboxes.length))
check('read/write/daily 勾选、danger 未勾选', (() => {
  const checked = checkboxes.map((element) => element.props.checked === true)
  return checked.filter(Boolean).length === 3 && checked[3] === false
})(), JSON.stringify(checkboxes.map((element) => element.props.checked)))
check('全开/全关按钮存在', buttons.some((element) => /全关/.test(String(element.children?.[0]))) && buttons.some((element) => /全开/.test(String(element.children?.[0]))))
check('显示工具总数 17', /当前共 17 个工具定义/.test(text), text.slice(-200))

console.log('— 连接测试结果 —')
check('三条探测都渲染', /系统版本/.test(text) && /列出笔记本/.test(text) && /SQL 查询/.test(text))
check('失败项显示思源 msg', /code=-1 msg=Auth failed/.test(text))
check('成功项带 ✓、失败项带 ✗', /✓ 系统版本/.test(text) && /✗ SQL 查询/.test(text))

console.log('')
if (failures.length === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
}
console.log(`${failures.length} 项失败：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
