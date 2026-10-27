/**
 * 计量本插件 17 个 siyuan_* 工具的「提示词字数」：
 *   - description（工具级说明书）
 *   - parameters 里每个属性的 description（参数级说明书）
 *
 * 用法（仓库根目录下跑）：
 *   node docs/research/count-plugin-descriptions.mjs
 *
 * 复用 test/tools-e2e.mjs 的 mock ctx 手法，真跑一遍 mount 拿注册表；
 * 写死绝对路径会漏，从脚本自身位置推仓库根。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-count-'))
process.env.DSH_HOME = TEST_HOME
fs.mkdirSync(`${TEST_HOME}/storages/siyuan`, { recursive: true })
fs.writeFileSync(
  `${TEST_HOME}/storages/siyuan/config.json`,
  JSON.stringify({ baseUrl: 'http://127.0.0.1:6806', defaultNotebook: 'nb', tools: { read: true, write: true, daily: true, danger: true } })
)

const plugin = await import(path.join(REPO_ROOT, 'lib/index.js') + '?count=1')
const registered = new Map()
const injectable = {
  get: () => undefined,
  effect: (cb) => { cb(); return () => {} },
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name) } },
  webServer: { register: () => () => {} },
  credentials: { async describe() { return {} }, async resolve() { return { value: 'x' } } },
}
plugin.apply({
  get: injectable.get,
  effect: injectable.effect,
  logger: injectable.logger,
  inject: (_d, cb) => cb(injectable),
  get tools() { throw new Error('no') },
  get webServer() { throw new Error('no') },
})

// 收集参数级 description
function paramDescs(schema, acc = []) {
  for (const v of Object.values(schema?.properties ?? {})) {
    if (v.description) acc.push(String(v.description))
    if (v.items?.description) acc.push(String(v.items.description))
    if (v.items?.properties) paramDescs(v.items, acc)
  }
  return acc
}

const rows = []
for (const [name, d] of registered) {
  const desc = String(d.description ?? '')
  const pd = paramDescs(d.parameters)
  rows.push({
    name,
    group: d.group ?? '-',
    descChars: desc.length,
    paramProps: Object.keys(d.parameters?.properties ?? {}).length,
    paramChars: pd.reduce((s, x) => s + x.length, 0),
    paramCount: pd.length,
  })
}
rows.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))

const sum = (k) => rows.reduce((s, r) => s + r[k], 0)
console.log('| 工具 | 分组 | 工具描述 | 参数数 | 参数描述 | 小计 |')
console.log('| --- | --- | ---: | ---: | ---: | ---: |')
for (const r of rows) {
  console.log(`| \`${r.name}\` | ${r.group} | ${r.descChars} | ${r.paramProps} | ${r.paramChars} | ${r.descChars + r.paramChars} |`)
}
console.log(`| **合计（${rows.length} 个）** | | **${sum('descChars')}** | **${sum('paramProps')}** | **${sum('paramChars')}** | **${sum('descChars') + sum('paramChars')}** |`)
console.log()
console.log('单工具均值：', Math.round((sum('descChars') + sum('paramChars')) / rows.length), '字符')
fs.rmSync(TEST_HOME, { recursive: true, force: true })
