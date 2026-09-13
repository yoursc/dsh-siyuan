/**
 * dsh-siyuan 客户端半场干跑：在 Node 里模拟浏览器模块加载器，执行 lib/client.js，
 * 校验 bundle 可解析、factory 返回 apply/inject、apply 注册的 settings.section
 * 契约字段与页面外壳的 list 槽位要求一致（id/order/label）。
 *
 * 浏览器渲染本身要等 dsh web 挂载后才能验证（React 由客户端模块加载器提供，
 * 本机 node_modules 里没有 React）。
 *
 * 用法：node test/client-harness.mjs
 */

import fs from 'node:fs'
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
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      captured = module
    },
  },
}

const clientPath = path.join(import.meta.dirname, '..', 'lib', 'client.js')
await import(clientPath)

console.log('— bundle 加载 —')
check('调用了 __ModuleLoader__.load', captured !== null)
const packageName = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).name
check(`模块 id 等于包名（client-modules 硬性要求）：${packageName}`, captured?.id === packageName, `bundle 里注册的是 ${String(captured?.id)}`)
check('factory 是函数', typeof captured?.factory === 'function')

// 最小 React 替身：只需模块作用域用到的 createElement；hooks 只在渲染时才会调用。
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const warnings = []
const exportsObject = captured.factory((name) => {
  if (name === 'react') return reactStub
  warnings.push(name)
  return {}
})

console.log('— 插件导出 —')
check('exports.apply 是函数', typeof exportsObject.apply === 'function')
check('exports.inject 为 ["slots"]', Array.isArray(exportsObject.inject) && exportsObject.inject.length === 1 && exportsObject.inject[0] === 'slots', JSON.stringify(exportsObject.inject))
check('只 require 了 react', warnings.length === 0, warnings.join(','))

console.log('— settings.section 注册 —')
const registrations = []
const slotsService = {
  inject(name, callback) {
    registrations.push({ kind: 'inject', name })
    callback()
  },
  register(contract, component) {
    registrations.push({ kind: 'register', contract, component })
    return () => {}
  },
}
// 模拟 cordis 注入后的客户端上下文：ctx.slots 直接可读，ctx.get('slots') 也能命中。
const ctx = {
  slots: slotsService,
  get: (name) => (name === 'slots' ? slotsService : undefined),
}
exportsObject.apply(ctx)

const injectCall = registrations.find((entry) => entry.kind === 'inject')
const registerCall = registrations.find((entry) => entry.kind === 'register')
check('向 settings.section 槽位注入', injectCall?.name === 'settings.section', JSON.stringify(injectCall))
check('注册进 settings.section', registerCall?.contract?.name === 'settings.section', JSON.stringify(registerCall?.contract))
check('注册带 id（list 槽位强制要求）', typeof registerCall?.contract?.id === 'string' && registerCall.contract.id.length > 0, String(registerCall?.contract?.id))
check('注册带 order（排序用）', typeof registerCall?.contract?.order === 'number', String(registerCall?.contract?.order))
check('label 是字符串或函数', typeof registerCall?.contract?.label === 'string' || typeof registerCall?.contract?.label === 'function', typeof registerCall?.contract?.label)
check('组件是函数组件', typeof registerCall?.component === 'function')

console.log('— 组件初次渲染（无状态分支）—')
try {
  const element = registerCall.component({ close: () => {} })
  const text = JSON.stringify(element)
  check('未取到配置时渲染加载态而不是抛错', /正在读取配置/.test(text))
  check('加载态也不带页内标题与简介（分区名由外壳负责）', !text.includes('"h2"') && !text.includes('把思源笔记接入'))
} catch (error) {
  check('未取到配置时渲染加载态而不是抛错', false, error.message)
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
}
console.log(`${failures.length} 项失败：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
