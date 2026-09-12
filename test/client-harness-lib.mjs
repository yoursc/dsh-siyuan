/**
 * 客户端测试的共享支持：bundle 加载 + 一套「真的会更新状态」的 React 替身 + 元素查找。
 *
 * 为什么需要它：`client-harness.mjs` / `client-render.mjs` 用的替身把 `useEffect` 设成 no-op、
 * 也不提供 setter，所以 `lib/client.js` 的交互路径（api() / run() / 保存 token / 开关按钮）
 * 一行都跑不到。这里给出一套最小但真实的 hooks 实现：`useState` 返回可用的 setter，
 * `useEffect` 在挂载后执行（可用 disableEffects 关掉以模拟"未加载"分支）。
 */

import path from 'node:path'

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

  /** 挂载后执行 effect 提交的函数，并等待它们返回的 promise（组件里的 load 是 async）。 */
  async function flushEffects() {
    if (disableEffects) return
    const pending = []
    for (const effect of pendingEffects.splice(0)) {
      const result = effect()
      pending.push(result !== undefined && typeof result.then === 'function' ? result : Promise.resolve())
    }
    await Promise.all(pending)
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
      walk(node.type(node.props))
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
      walk(node.type(node.props))
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
