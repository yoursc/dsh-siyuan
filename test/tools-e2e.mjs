/**
 * dsh-siyuan 工具端到端测试：对着本地思源替身（test/mock-siyuan.mjs）跑通全部 14 个
 * 工具，包括写入与日记路径解析，因此不需要真实 token、也不动真实笔记库。
 *
 * 用法：node test/tools-e2e.mjs
 */

import fs from 'node:fs'
import { startMockSiYuan } from './mock-siyuan.mjs'

const TEST_HOME = '/tmp/sy-tools-home'
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

const failures = []
function check(label, condition, detail) {
  if (condition === true) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}`)
  }
}

// 让替身也模拟「删除异步落库」：删除请求返回后行还会短暂存在，插件必须轮询复核。
const mock = await startMockSiYuan({ deleteDelayMs: 250 })

// 插件配置指向替身，并打开全部工具分组。
fs.mkdirSync(`${TEST_HOME}/storages/siyuan`, { recursive: true })
fs.writeFileSync(
  `${TEST_HOME}/storages/siyuan/config.json`,
  JSON.stringify({ baseUrl: mock.baseUrl, defaultNotebook: 'nb-inbox', tools: { read: true, write: true, daily: true, danger: true } })
)

const plugin = await import('../lib/index.js')

const registered = new Map()
const credentials = {
  async describe() {
    return { configured: true, source: 'store', writable: true }
  },
  async resolve() {
    return { value: mock.token, source: 'store' }
  },
  async set() {},
  async unset() {},
}
const injectable = {
  get: (name) => (name === 'credentials' ? credentials : undefined),
  effect: (callback) => {
    callback()
    return () => {}
  },
  logger: { info: () => {} },
  tools: {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  webServer: { register: () => () => {} },
}
const outer = {
  get: injectable.get,
  effect: injectable.effect,
  logger: injectable.logger,
  inject: (_deps, callback) => callback(injectable),
  get tools() {
    throw new Error('cannot get property "tools" without inject')
  },
  get webServer() {
    throw new Error('cannot get property "webServer" without inject')
  },
}
plugin.apply(outer)

async function callTool(name, args) {
  const definition = registered.get(name)
  if (definition === undefined) throw new Error(`tool not registered: ${name}`)
  try {
    const value = await definition.execute(args ?? {}, {})
    return { ok: true, text: value.result }
  } catch (error) {
    return { ok: false, text: error?.message ?? String(error) }
  }
}

check('全部 17 个工具已注册', registered.size === 17, String(registered.size))

// ── 只读工具 ────────────────────────────────────────────────────────────────

console.log('— 读取组 —')
const notebooks = await callTool('siyuan_list_notebooks', {})
check('list_notebooks 列出笔记本', notebooks.ok && /收件箱 \| id=nb-inbox/.test(notebooks.text) && /项目 \| id=nb-proj/.test(notebooks.text), notebooks.text)

const docId = mock.seedDoc()
const search = await callTool('siyuan_search', { query: '排期' })
check('search 命中并给出文档 id/hPath/块 id', search.ok && search.text.includes(docId) && search.text.includes('/收件箱/会议纪要') && /块id=blk-/.test(search.text), search.text)
check('search 去掉 <mark> 高亮标记', search.ok && !search.text.includes('<mark>') && search.text.includes('排期'), search.text)

const sql = await callTool('siyuan_sql', { stmt: 'SELECT 1 AS ok' })
check('sql 执行 SELECT 并回 JSON', sql.ok && /"ok": 1/.test(sql.text), sql.text)
const badSql = await callTool('siyuan_sql', { stmt: 'DELETE FROM blocks' })
check('sql 拒绝非 SELECT', badSql.ok === false && /只允许 SELECT/.test(badSql.text), badSql.text)

const readText = await callTool('siyuan_read_doc', { id: docId, format: 'text' })
check('read_doc(text) 把 DOM 转成保留结构的纯文本', readText.ok && readText.text.includes('# 会议纪要') && readText.text.includes('讨论了排期与预算。') && readText.text.includes('- 第一项') && !readText.text.includes('<'), readText.text)

const readMd = await callTool('siyuan_read_doc', { id: docId, format: 'markdown' })
check('read_doc(markdown) 走导出接口', readMd.ok && readMd.text.includes('# 会议纪要') && readMd.text.includes('第二项'), readMd.text)

const readDom = await callTool('siyuan_read_doc', { id: docId, format: 'dom' })
check('read_doc(dom) 返回原始 DOM', readDom.ok && readDom.text.includes('<h1'), readDom.text.slice(0, 80))

const listDocs = await callTool('siyuan_list_docs', { path: '/' })
check('list_docs 列出根目录文档', listDocs.ok && listDocs.text.includes(docId) && listDocs.text.includes('会议纪要'), listDocs.text)

const children = await callTool('siyuan_get_child_blocks', { id: docId })
check('get_child_blocks 回结构并用 SQL 补正文', children.ok && /类型=h\/h2/.test(children.text) && children.text.includes('会议纪要') && children.text.includes('第一项'), children.text)

const attrsEmpty = await callTool('siyuan_get_block_attrs', { id: docId })
check('get_block_attrs 初始为空', attrsEmpty.ok && attrsEmpty.text.includes('"id"'), attrsEmpty.text)

const missingDoc = await callTool('siyuan_read_doc', { id: 'nope' })
check('read_doc 对不存在的 id 给出可读错误', missingDoc.ok === false && /没有取到内容/.test(missingDoc.text), missingDoc.text)

// ── 写入工具 ────────────────────────────────────────────────────────────────

console.log('— 写入组 —')
const setAttrs = await callTool('siyuan_set_block_attrs', { id: docId, attrs: { 'custom-status': 'done' } })
check('set_block_attrs 写属性', setAttrs.ok && /已设置/.test(setAttrs.text), setAttrs.text)
const attrsAfter = await callTool('siyuan_get_block_attrs', { id: docId })
check('属性可读回（含 custom-*）', attrsAfter.ok && attrsAfter.text.includes('"custom-status": "done"'), attrsAfter.text)

const created = await callTool('siyuan_create_doc', { path: '/收件箱/新文档', markdown: '# 新文档\n\n正文一' })
check('create_doc 新建文档', created.ok && /已创建文档：id=doc-/.test(created.text), created.text)
const createdAgain = await callTool('siyuan_create_doc', { path: '/收件箱/新文档', markdown: '# 又一份' })
check('create_doc 查重后不重复创建', createdAgain.ok && /已存在同路径文档，未新建/.test(createdAgain.text) && /allowDuplicate=true/.test(createdAgain.text), createdAgain.text)
const duplicate = await callTool('siyuan_create_doc', { path: '/收件箱/新文档', markdown: '# 真重复', allowDuplicate: true })
check('allowDuplicate=true 时才重复创建', duplicate.ok && /已创建文档/.test(duplicate.text), duplicate.text)
const samePathCount = [...mock.state.docs.values()].filter((doc) => doc.hpath === '/收件箱/新文档').length
check('同路径确实存在两份（模拟 createDocWithMd 非幂等）', samePathCount === 2, String(samePathCount))

const appended = await callTool('siyuan_append_block', { docId, markdown: '追加的结论。' })
check('append_block 追加到文档末尾', appended.ok && /已追加到文档/.test(appended.text), appended.text)
const afterAppend = await callTool('siyuan_read_doc', { id: docId, format: 'markdown' })
check('追加内容可读回', afterAppend.ok && afterAppend.text.includes('追加的结论。'), afterAppend.text)

const firstBlockId = [...mock.state.blocks.values()].find((block) => block.docId === docId).id
const inserted = await callTool('siyuan_insert_block', { previousId: firstBlockId, markdown: '插在标题后的一段。' })
check('insert_block 按 previousId 插入', inserted.ok && /已插入块/.test(inserted.text), inserted.text)
const insertMissingAnchor = await callTool('siyuan_insert_block', { markdown: 'x' })
check('insert_block 缺少锚点时拒绝', insertMissingAnchor.ok === false && /previousId 或 parentId/.test(insertMissingAnchor.text), insertMissingAnchor.text)

const updated = await callTool('siyuan_update_block', { blockId: firstBlockId, markdown: '# 会议纪要（改）' })
check('update_block 覆盖块内容', updated.ok && /已更新块/.test(updated.text), updated.text)
check('改写后 mock 里的块内容已变', mock.state.blocks.get(firstBlockId).markdown === '# 会议纪要（改）', mock.state.blocks.get(firstBlockId).markdown)

const delRefused = await callTool('siyuan_delete_block', { blockId: firstBlockId, confirm: false })
check('delete_block 未确认时拒绝', delRefused.ok === false && /confirm=true/.test(delRefused.text), delRefused.text)
const delOk = await callTool('siyuan_delete_block', { blockId: firstBlockId, confirm: true })
check('delete_block 确认后真删除', delOk.ok && mock.state.blocks.has(firstBlockId) === false, delOk.text)

const delMissing = await callTool('siyuan_delete_block', { blockId: 'blk-nope', confirm: true })
check('delete_block 对不存在的 id 报错', delMissing.ok === false && /不存在/.test(delMissing.text), delMissing.text)

const delDocViaBlock = await callTool('siyuan_delete_block', { blockId: docId, confirm: true })
check('delete_block 拒绝文档块并指向 siyuan_remove_doc', delDocViaBlock.ok === false && /是文档块/.test(delDocViaBlock.text) && /siyuan_remove_doc/.test(delDocViaBlock.text), delDocViaBlock.text)
check('拒绝后文档仍在（没有假成功）', mock.state.docs.has(docId), String(mock.state.docs.has(docId)))

const rmRefused = await callTool('siyuan_remove_doc', { docId, confirm: false })
check('remove_doc 未确认时拒绝', rmRefused.ok === false && /confirm=true/.test(rmRefused.text), rmRefused.text)

await callTool('siyuan_create_doc', { path: '/收件箱/待删除的文档', markdown: '# 待删除' })
const disposable = [...mock.state.docs.values()].find((doc) => doc.hpath === '/收件箱/待删除的文档')
const disposableBlocks = [...mock.state.blocks.values()].filter((block) => block.docId === disposable.id).map((block) => block.id)
const rmOk = await callTool('siyuan_remove_doc', { docId: disposable.id, confirm: true })
check('remove_doc 真删除整篇文档（含块）', rmOk.ok && !mock.state.docs.has(disposable.id) && disposableBlocks.every((id) => !mock.state.blocks.has(id)), rmOk.text)
check('删除的文档不再出现在列表里', mock.requestsTo('/api/filetree/removeDocByID').length === 1, String(mock.requestsTo('/api/filetree/removeDocByID').length))

const rmMissing = await callTool('siyuan_remove_doc', { docId: 'doc-nope', confirm: true })
check('remove_doc 对不存在的 id 报错', rmMissing.ok === false && /思源接口/.test(rmMissing.text), rmMissing.text)

// ── 文档移动与重命名 ────────────────────────────────────────────────────────

console.log('— 移动 / 重命名 —')
await callTool('siyuan_create_doc', { path: '/收件箱/待移动', markdown: '# 待移动' })
const movable = [...mock.state.docs.values()].find((doc) => doc.hpath === '/收件箱/待移动')
check('测试前置：待移动文档已建好', movable !== undefined)

const moved = await callTool('siyuan_move_doc', { docIds: [movable.id], toId: 'nb-proj' })
check('move_doc 移到目标笔记本', moved.ok && /已移动 1 篇文档到 nb-proj/.test(moved.text), moved.text)
check('mock 里笔记本与路径已变', movable.notebook === 'nb-proj' && movable.hpath === '/待移动', JSON.stringify({ notebook: movable.notebook, hpath: movable.hpath }))

const renamed = await callTool('siyuan_rename_doc', { docId: movable.id, title: '改名后的文档' })
check('rename_doc 改标题', renamed.ok && /已把 .* 重命名为「改名后的文档」/.test(renamed.text), renamed.text)
check('mock 里路径叶子已变', movable.hpath === '/改名后的文档', movable.hpath)

const movedUnderDoc = await callTool('siyuan_move_doc', { docIds: [movable.id], toId: docId })
check('move_doc 支持移到某文档之下', movedUnderDoc.ok && movable.hpath === '/收件箱/会议纪要/改名后的文档', movable.hpath)

const movedEmpty = await callTool('siyuan_move_doc', { docIds: [], toId: 'nb-proj' })
check('move_doc 空列表被拒', movedEmpty.ok === false && /至少要有一个文档 id/.test(movedEmpty.text), movedEmpty.text)
const movedBadTarget = await callTool('siyuan_move_doc', { docIds: [movable.id], toId: 'nb-nope' })
check('move_doc 目标不存在时报思源错误', movedBadTarget.ok === false && /target not found/.test(movedBadTarget.text), movedBadTarget.text)
const renamedEmpty = await callTool('siyuan_rename_doc', { docId: movable.id, title: '   ' })
check('rename_doc 空标题被拒', renamedEmpty.ok === false && /title 不能为空/.test(renamedEmpty.text), renamedEmpty.text)

const moveRequests = mock.requestsTo('/api/filetree/moveDocsByID')
check('move_doc 请求体用 fromIDs/toID', moveRequests.length > 0 && moveRequests.every((entry) => Array.isArray(entry.payload.fromIDs) && typeof entry.payload.toID === 'string'), JSON.stringify(moveRequests[0]?.payload))

// ── 日记 ────────────────────────────────────────────────────────────────────

console.log('— 日记 —')

// H1 回归：非法 date 必须被拒绝，且不得发出任何思源请求。
// 修复前 parseDateArg 对非法输入静默回退「今天」、对越界日期让 Date 翻滚
// （2026-13-45 → 2027-02-14），append 会把内容写进错误的那一天。
const { parseDateArg } = plugin.internals
const dateArgCases = [
  ['abc', '非日期字符串'],
  ['2026-9-12', '未补零'],
  ['2026-09-12T00:00:00Z', 'ISO 时间戳'],
  ['2026-02-30', '不存在的日期'],
  ['2026-13-45', '越界月份与日期'],
  ['12/09/2026', '其他格式'],
]
for (const [value, label] of dateArgCases) {
  let threw = false
  let message = ''
  try {
    parseDateArg(value)
  } catch (error) {
    threw = true
    message = error?.message ?? ''
  }
  check(`parseDateArg 拒绝非法 date：${label}（${value}）`, threw && message.includes('date'), message || '未抛错')
}
const reference = new Date(2026, 8, 12, 23, 30)
check('parseDateArg 省略 date 时用参考日期的当地零点', parseDateArg(undefined, reference).getTime() === new Date(2026, 8, 12).getTime(), String(parseDateArg(undefined, reference)))
check('parseDateArg 空串回退到参考日期', parseDateArg('   ', reference).getTime() === new Date(2026, 8, 12).getTime())
check('parseDateArg 接受合法日期', parseDateArg('2026-09-12').getTime() === new Date(2026, 8, 12).getTime())

const beforeBadDate = mock.state.requests.length
for (const value of ['abc', '2026-13-45', '2026-02-30']) {
  const bad = await callTool('siyuan_daily_note', { action: 'append', date: value, markdown: '不该写进去' })
  check(`daily_note 非法 date=${value} 时拒绝写入`, bad.ok === false && /date/.test(bad.text), bad.text)
}
check('非法 date 不产生任何思源请求', mock.state.requests.length === beforeBadDate, String(mock.state.requests.length - beforeBadDate))

const dailyBefore = await callTool('siyuan_daily_note', { action: 'read', date: '2026-09-12' })
check('日记不存在时给出路径', dailyBefore.ok && /\/daily note\/2026\/09\/2026-09-12 的日记还不存在/.test(dailyBefore.text), dailyBefore.text)

const dailyAppend = await callTool('siyuan_daily_note', { action: 'append', date: '2026-09-12', markdown: '## 今日结论\n\n思源插件跑通了。' })
check('日记不存在时按 dailyNoteSavePath 创建', dailyAppend.ok && /已创建并写入：\/daily note\/2026\/09\/2026-09-12/.test(dailyAppend.text), dailyAppend.text)

const dailyRead = await callTool('siyuan_daily_note', { action: 'read', date: '2026-09-12' })
check('日记可读回（标题按 DOM→文本还原）', dailyRead.ok && dailyRead.text.includes('今日结论') && dailyRead.text.includes('思源插件跑通了。'), dailyRead.text)

const dailyAppendAgain = await callTool('siyuan_daily_note', { action: 'append', date: '2026-09-12', markdown: '补充一句。' })
check('已存在的日记走追加而不是重复创建', dailyAppendAgain.ok && /已追加到日记/.test(dailyAppendAgain.text), dailyAppendAgain.text)

const dailyMissingMarkdown = await callTool('siyuan_daily_note', { action: 'append', date: '2026-09-12' })
check('append 缺 markdown 时拒绝', dailyMissingMarkdown.ok === false && /必须提供 markdown/.test(dailyMissingMarkdown.text), dailyMissingMarkdown.text)

// ── 鉴权与请求体 ────────────────────────────────────────────────────────────

console.log('— 请求面 —')
const unauthenticated = mock.state.requests.filter((entry) => entry.path !== '/api/system/version' && entry.authorized !== true)
check('除公开接口外每个请求都带 Token 头', unauthenticated.length === 0, JSON.stringify(unauthenticated.slice(0, 2)))

const getDocRequests = mock.requestsTo('/api/filetree/getDoc')
check('read_doc 走的是 /api/filetree/getDoc', getDocRequests.length > 0, String(getDocRequests.length))

const createRequests = mock.requestsTo('/api/filetree/createDocWithMd')
check('create_doc 的请求体字段正确', createRequests.every((entry) => typeof entry.payload.notebook === 'string' && typeof entry.payload.path === 'string' && typeof entry.payload.markdown === 'string'), JSON.stringify(createRequests[0]?.payload))

const appendRequests = mock.requestsTo('/api/block/appendBlock')
check('append_block 用 dataType=markdown + parentID', appendRequests.length > 0 && appendRequests.every((entry) => entry.payload.dataType === 'markdown' && typeof entry.payload.parentID === 'string' && typeof entry.payload.data === 'string'), JSON.stringify(appendRequests[0]?.payload))

const dailyConfRequests = mock.requestsTo('/api/notebook/getNotebookConf').filter((entry) => entry.payload.notebook === 'nb-inbox')
check('日记路径读的是默认笔记本的 conf', dailyConfRequests.length > 0, String(dailyConfRequests.length))

await mock.close()

console.log('')
if (failures.length === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
}
console.log(`${failures.length} 项失败：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
