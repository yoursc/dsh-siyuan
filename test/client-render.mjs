/**
 * dsh-siyuan 设置页渲染断言：用共享 hook 运行时把设置页挂到「已加载」分支，遍历元素树
 * 断言四张卡、逐工具开关与初始（干净）状态。
 *
 * 覆盖不到的部分：真实 React 语义、CSS、浏览器事件（这些等 dsh web 挂载后在页面上确认）。
 * 本文件只证明渲染分支不会崩、结构正确；点击类行为在 `client-interactive.mjs`。
 *
 * 夹具来自宿主真实产出：`buildHostState()`（见 test/client-harness-lib.mjs）先把四组全开拿到
 * 全部 17 个工具定义，再按用例的开关状态让宿主自己解析 `tools[].enabled`——不再手抄字段形状，
 * 也不再按 hook 顺序注入状态（旧写法在 hook 增删时会静默错位）。
 *
 * 用法：node test/client-render.mjs
 */

import {
  buildHostState,
  cardHeaderText,
  createHooks,
  findButton,
  findByClass,
  findSwitch,
  flattenText,
  loadClientModule,
  renderOnce,
  switches,
} from './client-harness-lib.mjs'

const failures = []
function check(label, condition, detail) {
  if (condition === true) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}`)
  }
}

// ── 夹具：宿主真实产出 + 只覆盖"展示用"的场景值 ────────────────────────────

const { payload } = await buildHostState({ toolState: { read: true, daily: true } })
const hostState = {
  ...payload,
  // 本机没有思源可探测，宿主产出会是 reachable:false / version:''；这两个字段只影响徽标文案，
  // 按"已连上思源"的场景覆盖。其余（含 tools[].enabled、config、toolCount）全部来自宿主。
  reachable: true,
  version: '3.8.3',
  token: { configured: true, source: 'credentials', writable: true },
}

const SAVED_NOTEBOOK = '20260723165907-3zj91ge'
/** 替身返回的笔记本列表：默认含"已保存的那一本"（模拟"列表里有它"的正常情形）。 */
const NOTEBOOK_LIST = [
  { id: SAVED_NOTEBOOK, name: '收件箱', closed: false },
  { id: 'nb-b', name: '另一个笔记本', closed: false },
]

/**
 * 渲染套件的 fetch 替身：答 getState 与 listNotebooks（打开设置页会静默自动拉列表）。
 * `notebooks: 'fail'` 模拟拉不到（不可达/无 token）——此时不该有错误消息冒出来。
 */
function stubFetch(getStateValue, { notebooks = NOTEBOOK_LIST } = {}) {
  return async (url) => {
    const method = String(url).replace('/siyuan/api/', '')
    if (method === 'getState') return Response.json({ ok: true, value: getStateValue })
    if (method === 'listNotebooks') {
      if (notebooks === 'fail') throw new TypeError('fetch failed')
      return Response.json({ ok: true, value: { baseUrl: getStateValue.config.baseUrl, notebooks } })
    }
    throw new Error(`渲染套件不该调用 ${method}`)
  }
}

// ── 加载 bundle（hooks 从当前渲染的 runtime 取，与 client-interactive 同一套替身）──────

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
      return noop
    },
  },
})
const Section = registered.component

function noop() {}

/** 卡内消息（`.dsy-msg`）的文本；用来断言"哪种情形下不该冒消息"。 */
function messagesOf(elements) {
  return elements
    .filter((element) => typeof element.props?.className === 'string' && element.props.className.startsWith('dsy-msg'))
    .map((element) => flattenText([element]))
    .join(' || ')
}

/** 挂载并等 effect 里的 getState 跑完。 */
/**
 * 挂载并跑完 effect。跑**两轮**：替身的 `useEffect` 不看依赖数组，每次渲染都会重新登记，
 * 所以"state 到了之后重跑 effect"这一步要另一轮渲染才能发生——宿主返回配置后自动拉笔记本
 * 列表就走这一步（真实 React 里由状态更新自动触发）。
 */
async function mount(getStateValue = hostState, options) {
  runtime = createHooks()
  globalThis.fetch = stubFetch(getStateValue, options)
  renderingRuntime = runtime
  renderOnce(Section, {}, runtime)
  await runtime.flushEffects()
  renderingRuntime = runtime
  renderOnce(Section, {}, runtime)
  await runtime.flushEffects()
}

// ── 加载态 ─────────────────────────────────────────────────────────────────

console.log('— 加载态 —')
{
  runtime = createHooks()
  globalThis.fetch = stubFetch(hostState)
  renderingRuntime = runtime
  const pendingTree = renderOnce(Section, {}, runtime)
  check('未取到配置时渲染加载态', /正在读取配置/.test(flattenText(pendingTree.elements)), flattenText(pendingTree.elements).slice(0, 120))
  check('加载态不带页内标题与简介（分区名由外壳负责）', !pendingTree.elements.some((element) => element.type === 'h2') && !flattenText(pendingTree.elements).includes('把思源笔记接入'))
}

// ── 已加载 ─────────────────────────────────────────────────────────────────

console.log('— 连接卡片 —')
await mount()
const loaded = renderOnce(Section, {}, runtime, { ignoreEffects: true })
const text = loaded.text
const elements = loaded.elements
const inputs = elements.filter((element) => element.type === 'input')
const buttons = elements.filter((element) => element.type === 'button' && element.props.role !== 'switch')

check('已加载分支渲染出四张卡', ['连接', 'API token', '默认笔记本', '工具开关'].every((title) => elements.some((element) => element.type === 'h3' && element.children?.[0] === title)))
check('顶部不渲染页内标题（没有 h2）', !elements.some((element) => element.type === 'h2'))
check('顶部不渲染简介段落', !text.includes('把思源笔记接入 dsh'))
check('可达与版本徽标', /可达 · v3\.8\.3/.test(text), text.slice(0, 200))
check('连接卡标题行只讲连接（可达徽标）', /可达 · v3\.8\.3/.test(cardHeaderText(elements, '连接')) && !/token/.test(cardHeaderText(elements, '连接')), cardHeaderText(elements, '连接'))
check('token 徽标住在 API token 卡，且写明来源与可否修改', cardHeaderText(elements, 'API token') === 'API token | token 已配置 · 存在 dsh 凭据库 · 可在页面修改', cardHeaderText(elements, 'API token'))
check('徽标不回显 token 值', !text.includes('stored-token'))
check('地址输入框带当前 baseUrl', inputs.some((element) => element.props.type === 'text' && element.props.value === 'http://127.0.0.1:6806'))
check('地址 label 与输入框用 for/id 关联', elements.some((element) => element.type === 'label' && element.props.htmlFor === 'dsy-base-url' && element.props.id === undefined) && inputs.some((element) => element.props.id === 'dsy-base-url'))
check('token 是 password 输入且值为空（不回显）', inputs.some((element) => element.props.type === 'password' && element.props.value === ''))
check('token 可写时不显示只读提示', !/只读来源/.test(text))
check('干净状态下「保存地址」禁用（没改动就没什么可存）', findButton(elements, '保存地址')?.props.disabled === true)
check('干净状态下不显示「撤销」', findButton(elements, '撤销') === undefined)

console.log('— 默认笔记本卡片（打开页面就自动拉回列表）—')
{
  const select = elements.find((element) => element.type === 'select')
  check('下拉框存在且选中宿主里的默认笔记本', select?.props.value === SAVED_NOTEBOOK, String(select?.props.value))
  const optionTexts = elements.filter((element) => element.type === 'option').map((option) => String(option.children?.[0]))
  check('直接显示笔记本名字与 id（不必先点按钮）', optionTexts.includes('收件箱 · ' + SAVED_NOTEBOOK), JSON.stringify(optionTexts))
  check('列表里有的笔记本不标"不在当前列表中"', !optionTexts.some((text) => text.includes('不在当前列表中')), JSON.stringify(optionTexts))
  check('自动拉取是静默的（不刷"已加载 N 个"）', messagesOf(elements) === '', messagesOf(elements))
  check('按钮此时是「刷新笔记本」', findButton(elements, '刷新笔记本') !== undefined)
  check('「保存笔记本」初始禁用（没有改动）', findButton(elements, '保存笔记本')?.props.disabled === true)
}

console.log('— 默认笔记本：几种尚未知/已失效的情形 —')
{
  // 列表拉回来了，但里面没有保存的那一本：这时说"不在当前列表中"才是**真话**。
  await mount(hostState, { notebooks: [{ id: 'nb-b', name: '另一个笔记本', closed: false }] })
  const missingList = renderOnce(Section, {}, runtime, { ignoreEffects: true })
  const optionTexts = missingList.elements.filter((element) => element.type === 'option').map((option) => String(option.children?.[0]))
  check('列表里确实没有保存的那本时才标注「不在当前列表中」', optionTexts.includes(SAVED_NOTEBOOK + '（不在当前列表中）'), JSON.stringify(optionTexts))
}
{
  // 列表压根没拉回来（不可达/无 token）：不能说"不在列表中"，也不该冒错误消息。
  await mount(hostState, { notebooks: 'fail' })
  const failed = renderOnce(Section, {}, runtime, { ignoreEffects: true })
  const optionTexts = failed.elements.filter((element) => element.type === 'option').map((option) => String(option.children?.[0]))
  check('拉不到列表时不谎称「不在当前列表中」', !optionTexts.some((text) => text.includes('不在当前列表中')), JSON.stringify(optionTexts))
  check('改为提示「已保存 · 点加载显示名称」', optionTexts.includes(SAVED_NOTEBOOK + '（已保存 · 点「加载笔记本」显示名称）'), JSON.stringify(optionTexts))
  check('自动拉取失败不写错误消息（用户没点按钮）', messagesOf(failed.elements) === '', messagesOf(failed.elements))
  check('保存的笔记本仍在选中状态', failed.elements.find((element) => element.type === 'select')?.props.value === SAVED_NOTEBOOK)
}

console.log('— 工具开关卡片（逐个工具）—')
{
  const toolRows = elements.filter((element) => typeof element.props?.className === 'string' && element.props.className === 'dsy-tool')
  const groupHeads = elements.filter((element) => typeof element.props?.className === 'string' && element.props.className === 'dsy-group-head')
  const all = switches(elements)
  check('17 个工具各一行', toolRows.length === 17, String(toolRows.length))
  check('四个分组头（只读/写入/日记/危险）', groupHeads.length === 4 && ['只读', '写入', '日记', '危险'].every((label) => text.includes(label)), JSON.stringify(groupHeads.length))
  check('21 个可切换目标（17 个工具行 + 4 个组开关）', all.length === 21 && all.filter((element) => element.props.className === 'dsy-tool').length === 17, String(all.length))
  check('每行都显示工具名与中文说明', toolRows.every((row) => flattenText([row]).includes('siyuan_')))
  // 展示层对没收录的工具会回落到显示原名（不会空白），但新增工具时应该来补一条中文说明。
  const missingLabels = payload.tools.filter((entry) => typeof exportsObject.internals.TOOL_LABELS[entry.name] !== 'string')
  check('每个工具都有中文短标签（新增工具要来补一条）', missingLabels.length === 0, JSON.stringify(missingLabels.map((entry) => entry.name)))
  // enabled 由宿主解析（read + daily 开、write + danger 关），开关必须与它一致。
  const mismatched = payload.tools.filter((entry) => findSwitch(elements, entry.name)?.props['aria-checked'] !== entry.enabled)
  check('每个开关的 aria-checked 与宿主 enabled 一致', mismatched.length === 0, JSON.stringify(mismatched.map((entry) => entry.name)))
  check('关闭的工具也看得见（不是只列启用的）', findSwitch(elements, 'siyuan_delete_block') !== undefined && findSwitch(elements, 'siyuan_delete_block').props['aria-checked'] === false)
  const searchRow = elements.find((element) => typeof element.props?.className === 'string' && element.props.className === 'dsy-tool' && flattenText([element]).includes('siyuan_search'))
  check('工具行层级：中文在上（主）、工具名在下（次）', flattenText([searchRow]) === '全文检索 | siyuan_search', flattenText([searchRow]))
  check('开关在行的最前面（左）：槽位（内为展示轨道）→ 文字块', (() => {
    const slot = searchRow.children?.[0]
    const rest = searchRow.children?.[1]
    return slot?.props?.className === 'dsy-switch-slot' && typeof slot?.children?.[0]?.type === 'function' && rest?.props?.className === 'dsy-tool-text'
  })(), JSON.stringify(searchRow.children?.map((child) => child?.props?.className)))
  check('整行就是开关：role=switch / aria-checked / 可聚焦都在行上，轨道本身不可交互', searchRow.props.role === 'switch' && searchRow.props['aria-checked'] === true && searchRow.props.tabIndex === 0 && searchRow.children?.[0]?.children?.[0]?.props?.role === undefined, JSON.stringify({ role: searchRow.props.role, checked: searchRow.props['aria-checked'], tabIndex: searchRow.props.tabIndex }))
  check('行的 aria-label 写明中文与工具名（读屏可用）', String(searchRow.props['aria-label']).includes('siyuan_search') && String(searchRow.props['aria-label']).includes('全文检索'), String(searchRow.props['aria-label']))
  check('组标题行：开关在最前，组名次之，「整组 n/m」并到右侧一簇', (() => {
    const head = elements.find((element) => typeof element.props?.className === 'string' && element.props.className === 'dsy-group-head')
    const kids = head?.children ?? []
    return (
      kids[0]?.props?.className === 'dsy-switch-slot' &&
      kids[0]?.children?.[0]?.props?.master === true &&
      kids[1]?.type === 'h4' &&
      kids[2]?.props?.className === 'dsy-group-meta' &&
      /^整组 \| \d+\/\d+$/.test(flattenText([kids[2]]))
    )
  })(), JSON.stringify((elements.find((element) => typeof element.props?.className === 'string' && element.props.className === 'dsy-group-head')?.children ?? []).map((child) => child?.props?.className ?? child?.type)))
  check('组说明行用 group-hint（缩进到文字列，不与开关同列）', findByClass(elements, 'dsy-group-hint') !== undefined)
  const trackNodes = elements.filter((element) => typeof element.props?.className === 'string' && /(^|\s)dsy-switch(\s|$)/.test(element.props.className))
  const tonedSwitches = switches(elements).filter((element) => String(element.props.className).includes('dsy-tone-danger'))
  check('只有危险组的组开关带 danger 色调（琥珀），且仍是 master', tonedSwitches.length === 1 && tonedSwitches[0].props['aria-label'] === '危险整组开关' && String(tonedSwitches[0].props.className).includes('master'), JSON.stringify(tonedSwitches.map((element) => ({ label: element.props['aria-label'], className: element.props.className }))))
  check('组总开关用 master 变体（4 个），逐工具轨道不沾（17 个）', trackNodes.filter((element) => element.props.className.includes('master')).length === 4 && trackNodes.filter((element) => element.props.className.includes('master') === false).length === 17, JSON.stringify(trackNodes.map((element) => element.props.className).slice(0, 6)))
  check('组标题行写了「整组」字样（4 个组各一处）', (text.match(/整组/g) ?? []).length === 4, String((text.match(/整组/g) ?? []).length))
  check('组开关在全开/全关时是明确状态（不是 mixed）', findSwitch(elements, '只读整组开关')?.props['aria-checked'] === true && findSwitch(elements, '写入整组开关')?.props['aria-checked'] === false)
  check('危险组标题有警示样式', findByClass(elements, 'dsy-danger') !== undefined)
  check('「保存开关」初始禁用', findButton(elements, '保存开关')?.props.disabled === true)
  check('「全部停用」可用（一键收回所有权限）', findButton(elements, '全部停用')?.props.disabled === false)
  check('没有「全部开启」（不该一键打开危险组）', findButton(elements, '全部开启') === undefined && findButton(elements, '全开') === undefined)
  check('已启用计数来自宿主 enabled（8 = read 7 + daily 1）', /已启用 8 \/ 共 17 个/.test(text), text.slice(-200))
}

console.log('— 页脚 —')
check('干净状态提示已保存', /所有改动都已保存/.test(text), text.slice(-120))
check('有「重新读取」入口', findButton(elements, '重新读取') !== undefined)

console.log('— 只读来源的 token（env）—')
{
  // token 来自环境变量：徽标要写清"页面不可改"，卡里要给一句可执行的下一步。
  await mount({ ...hostState, token: { configured: true, source: 'env', writable: false } })
  const roElements = renderOnce(Section, {}, runtime, { ignoreEffects: true }).elements
  const roText = flattenText(roElements)
  check('env 来源写成「来自环境变量」', cardHeaderText(roElements, 'API token') === 'API token | token 已配置 · 来自环境变量 · 页面不可改', cardHeaderText(roElements, 'API token'))
  check('给出"去掉环境变量后重启"的下一步', /去掉 dsh web 的 SIYUAN_TOKEN 环境变量后重启/.test(roText), roText.slice(-200))
  check('只读时输入框与按钮禁用', roElements.some((element) => element.type === 'input' && element.props.id === 'dsy-token' && element.props.disabled === true) && findButton(roElements, '保存 token').props.disabled === true)
}

console.log('— 旧宿主（没重启）时的降级 —')
{
  // 升级插件后忘了重启 dsh web：宿主还是旧 payload（没有 tools 数组）。这时应该给一句
  // 可执行的提示，而不是一张空卡。
  const stale = { ...hostState }
  delete stale.tools
  await mount(stale)
  const staleText = renderOnce(Section, {}, runtime, { ignoreEffects: true }).text
  check('工具清单缺失时提示重启 dsh web', /请重启 dsh web/.test(staleText), staleText.slice(-200))
  check('其余卡片照常渲染', /连接/.test(staleText) && /默认笔记本/.test(staleText), staleText.slice(0, 120))
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
}
console.log(`${failures.length} 项失败：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
