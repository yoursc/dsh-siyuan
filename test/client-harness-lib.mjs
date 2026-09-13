/**
 * 客户端测试的共享支持：bundle 加载 + 宿主夹具 + 一套「真的会更新状态」的 React 替身 + 元素查找。
 *
 * 为什么需要它：`client-harness.mjs` / `client-render.mjs` 用的替身把 `useEffect` 设成 no-op、
 * 也不提供 setter，所以 `lib/client.js` 的交互路径（api() / run() / 保存开关）一行都跑不到。
 * 这里给出一套最小但真实的 hooks 实现：`useState` 返回可用的 setter，`useEffect` 在挂载后执行
 * （可用 disableEffects 关掉以模拟"未加载"分支）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fixtureCount = 0

/**
 * 用**宿主真实产出**生成设置页夹具（`internals.buildStatePayload`），不手抄字段形状。
 *
 * 两步是必要的：`buildStatePayload` 的工具清单来自 `buildTools()` 的返回值，而测试里的假
 * `tools.register` 只看得见**已启用**的工具。所以先把四组全开跑一次 mount 拿到全部 17 个定义，
 * 再按 toolState 改写配置文件，然后才生成 payload —— 这样 `tools[].enabled` 是宿主自己算的，
 * 客户端测试里的开关断言跟线上同一套判据。
 *
 * @param {object} options
 * @param {object} options.toolState - 写进配置文件的 tools 字段（逐工具键或旧版组名键都行）
 * @returns {Promise<{home: string, payload: object, registered: object[]}>}
 */
export async function buildHostState({ toolState = { read: true, daily: true } } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-client-fixture-'))
  const configDir = path.join(home, 'storages', 'siyuan')
  fs.mkdirSync(configDir, { recursive: true })
  const configFile = path.join(configDir, 'config.json')
  const writeConfigFile = (tools) =>
    fs.writeFileSync(configFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:6806', defaultNotebook: '20260723165907-3zj91ge', tools }))
  process.env.DSH_HOME = home

  // 第一次：四组全开，只为拿全 17 个工具定义。
  writeConfigFile({ read: true, write: true, daily: true, danger: true })
  const host = await import(`../lib/index.js?fixture=${(fixtureCount += 1)}`)
  const registered = []
  const logger = { info: () => {}, warn: () => {} }
  const inject = {
    get: () => undefined,
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger,
    tools: {
      register: (definition) => {
        registered.push({ group: definition.group, definition })
        return () => {}
      },
    },
    webServer: { register: () => () => {} },
  }
  host.apply({
    ...inject,
    inject: (_deps, callback) => callback(inject),
    get tools() {
      throw new Error('cannot get property "tools" without inject')
    },
    get webServer() {
      throw new Error('cannot get property "webServer" without inject')
    },
  })

  // 第二次：换成用例要的开关状态，再让宿主自己解析 enabled。
  writeConfigFile(toolState)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new TypeError('probe disabled by test')
  }
  const payload = await host.internals.buildStatePayload({ get: () => undefined, logger }, registered)
  globalThis.fetch = realFetch
  return { home, payload, registered }
}

/** 加载客户端 bundle，返回它导出的 apply / inject。 */
export async function loadClientModule(makeReact) {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (module) => (captured = module) } }
  await import(path.join(import.meta.dirname, '..', 'lib', 'client.js'))
  if (captured === null) throw new Error('client bundle 没有调用 __ModuleLoader__.load')
  const reactStub = makeReact === undefined ? { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) } : makeReact()
  const exportsObject = captured.factory((name) => {
    if (name === 'react') return reactStub
    return {}
  })
  return { exportsObject, bundleId: captured.id }
}

/**
 * 可执行的 hooks 替身。
 *
 * - `useState` 的值存在内部数组里，**索引即 hook 顺序**（该顺序由 lib/client.js 决定；
 *   改组件里 hook 的数量或次序会让这里错位，`assertHookShape()` 专门把这件事变得可见）。
 * - `useEffect` 在 `flushEffects()` 时执行；`disableEffects` 用于模拟未挂载状态。
 */
export function createHooks({ disableEffects = false } = {}) {
  const states = []
  const setters = []
  const effects = []
  const pendingEffects = []
  let cursor = 0
  let renderCount = 0

  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      if (setters[index] === undefined) {
        setters[index] = (next) => {
          states[index] = typeof next === 'function' ? next(states[index]) : next
        }
      }
      return [states[index], setters[index]]
    },
    useCallback(fn) {
      cursor += 1 // 占一个 hook 槽位，保持与真实 React 的顺序一致
      return fn
    },
    useEffect(fn) {
      cursor += 1
      effects.push(fn)
    },
  }

  /** 每次渲染前调用：重置 hook 游标并计数。 */
  function beginRender() {
    cursor = 0
    renderCount += 1
  }

  /**
   * 渲染阶段结束后调用：把本次渲染注册的 effect 搬进待执行队列。
   *
   * 不能放进 `beginRender`，因为 `useEffect` 是在**渲染阶段**（组件函数体执行时）被调用的，
   * 而 element 树的遍历（渲染嵌套组件）发生在其后；顺序反了 effect 就永远排不进队列。
   */
  function markEffectsPending() {
    for (const effect of effects.splice(0)) pendingEffects.push(effect)
  }

  /** 丢弃本次渲染注册的 effect（只为查看 UI 的重渲用）。 */
  function discardEffects() {
    effects.splice(0)
  }

  /**
   * 挂载后执行待提交的 effect 并等异步链跑完。
   *
   * C8：effect 按 React 契约不再返回 promise，这里改为排干微任务——组件里的
   * load → fetch → setState 全是微任务链（fetch 替身是 async 函数 / Response.json），
   * 一次 macrotask 间隙内必然完成，setImmediate 两轮即充分。
   * `lastEffectReturn` 记录最近一个 effect 的返回值，供「不得返回 promise」的守卫断言。
   */
  let lastEffectReturn
  async function flushEffects() {
    if (disableEffects) return
    for (const effect of pendingEffects.splice(0)) {
      lastEffectReturn = effect()
    }
    for (let round = 0; round < 2; round += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  return {
    hooks,
    states,
    setters,
    effects,
    beginRender,
    markEffectsPending,
    discardEffects,
    flushEffects,
    get lastEffectReturn() {
      return lastEffectReturn
    },
    get renderCount() {
      return renderCount
    },
    get hookCount() {
      return cursor
    },
  }
}

/** 渲染一次组件并把元素树摊平成 {text, elements}。props 会传给组件。 */
export function renderOnce(Component, props, runtime, { ignoreEffects = false } = {}) {
  runtime.beginRender()
  const tree = Component(props)
  // effect 是「渲染阶段」注册的（useEffect 在组件函数体里被调用），必须在 walk 之前
  // 搬进待执行队列——walk 还会递归渲染嵌套组件，那时 cursor 已不对应本次渲染。
  // ignoreEffects：只为查看当前 UI 的重渲不排 effect，否则每次断言都会重复触发挂载加载。
  if (!ignoreEffects) runtime.markEffectsPending()
  else runtime.discardEffects()
  const elements = []
  const textParts = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      textParts.push(String(node))
      return
    }
    if (typeof node !== 'object' || node.type === undefined) return
    elements.push(node)
    if (typeof node.type === 'function') {
      // React 会把子节点塞进 props.children；替身本来只存在元素上，这里补齐，
      // 否则 Card/Note 这类「读 props.children」的组件在测试里渲染成空。
      walk(node.type({ ...(node.props ?? {}), children: node.children }))
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return { tree, elements, text: textParts.join(' | ') }
}

/** 摊平文本，便于断言。 */
export function flattenText(elements) {
  const parts = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node))
      return
    }
    if (typeof node !== 'object' || node.type === undefined) return
    if (typeof node.type === 'function') {
      // React 会把子节点塞进 props.children；替身本来只存在元素上，这里补齐，
      // 否则 Card/Note 这类「读 props.children」的组件在测试里渲染成空。
      walk(node.type({ ...(node.props ?? {}), children: node.children }))
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(elements)
  return parts.join(' | ')
}

/** React 元素树里按条件找节点。 */
export function findAll(elements, predicate) {
  return elements.filter(predicate)
}

/** 按按钮文案找按钮（文案可能嵌在 span 里）。 */
export function findButton(elements, label) {
  return elements.find((element) => {
    if (element.type !== 'button') return false
    const children = element.children ?? []
    const text = children.map((child) => (typeof child === 'string' ? child : '')).join('')
    return text.includes(label)
  })
}

/** 按 className 片段找节点。 */
export function findByClass(elements, className) {
  return elements.find((element) => typeof element.props?.className === 'string' && element.props.className.includes(className))
}

/** 所有椭圆开关（`button[role=switch]`）。 */
export function switches(elements) {
  return elements.filter((element) => element.props?.role === 'switch')
}

/** 按 aria-label 找开关：`label` 用包含匹配，工具开关的 aria-label 是「中文（siyuan_xxx）」。 */
export function findSwitch(elements, label) {
  return switches(elements).find((element) => String(element.props['aria-label']).includes(label))
}

/** 取某张卡片元素（按卡内文本包含 title 判定；标题是卡里的第一段文本）。 */
export function cardOf(elements, title) {
  return elements.find((element) => element.props?.className === 'dsy-card' && flattenText([element]).startsWith(title))
}

/**
 * 卡片标题行（卡元素第一个子节点）的文本。用来断言"哪个徽标在哪张卡里"——
 * 例如 token 状态徽标必须住在 API token 卡，而不是挨着"可达"待在连接卡。
 */
export function cardHeaderText(elements, title) {
  const card = cardOf(elements, title)
  if (card === undefined) throw new Error(`找不到卡片：${title}`)
  return flattenText([card.children?.[0]])
}
