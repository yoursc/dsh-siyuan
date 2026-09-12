/**
 * dsh-siyuan 工具端到端测试：对着本地思源替身（test/mock-siyuan.mjs）跑通全部 14 个
 * 工具，包括写入与日记路径解析，因此不需要真实 token、也不动真实笔记库。
 *
 * 用法：node test/tools-e2e.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMockSiYuan } from './mock-siyuan.mjs'

// 每次跑用独立临时目录：并行执行（或同机多个 CI job）不会互相删配置。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-tools-'))
process.env.DSH_HOME = TEST_HOME

const failures = []
/** 成功时清掉临时 home（含删除复核/取消/请求中取消三个用例的变体 home）；失败时保留，便于取证。 */
function cleanupHome() {
  if (failures.length === 0) {
    for (const home of [TEST_HOME, `${TEST_HOME}-slow`, `${TEST_HOME}-abort`, `${TEST_HOME}-stalled`]) {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
}

function check(label, condition, detail) {
  if (condition === true) console.log(`  ok   ${label}`)
  else {
    // detail 要留在失败清单里，否则末尾的汇总只有标签、没有定位信息。
    failures.push(label + (detail === undefined ? '' : ` — ${detail}`))
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

// 每次加载都带一个新 query，绕开 ESM 模块缓存：插件有模块级状态（配置告警去重），
// 测试需要拿到互不干扰的新实例。
let pluginLoadCount = 0
const loadPlugin = () => import(`../lib/index.js?case=${(pluginLoadCount += 1)}`)

const plugin = await loadPlugin()

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
// B4 回归：只判首词会放过以 select 开头的多语句。
const multiSql = await callTool('siyuan_sql', { stmt: 'SELECT 1 AS ok; DELETE FROM blocks' })
check('sql 拒绝分号分隔的多语句', multiSql.ok === false && /单条 SELECT/.test(multiSql.text), multiSql.text)
const trailingSql = await callTool('siyuan_sql', { stmt: 'SELECT 1 AS ok;' })
check('sql 允许结尾单个分号', trailingSql.ok && /"ok": 1/.test(trailingSql.text), trailingSql.text)
const emptySql = await callTool('siyuan_sql', { stmt: '   ' })
check('sql 拒绝空语句', emptySql.ok === false && /不能为空/.test(emptySql.text), emptySql.text)
const onlySemicolonSql = await callTool('siyuan_sql', { stmt: ';;' })
check('sql 拒绝只有分号的语句', onlySemicolonSql.ok === false && /不能只有分号/.test(onlySemicolonSql.text), onlySemicolonSql.text)

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

// C4 回归：思源对不存在 id 的 setBlockAttrs 会静默 no-op（仍回 code 0），
// 改前工具照样回「已设置」——假成功，与 update_block/delete_block 的标准不一致。
const attrsMissing = await callTool('siyuan_set_block_attrs', { id: 'blk-nope', attrs: { 'custom-x': '1' } })
check('set_block_attrs 目标不存在时报错而不是回成功', attrsMissing.ok === false && /不存在/.test(attrsMissing.text), attrsMissing.text)
check('目标不存在时不发 setBlockAttrs 请求', mock.requestsTo('/api/attr/setBlockAttrs').every((entry) => entry.payload.id !== 'blk-nope'), JSON.stringify(mock.requestsTo('/api/attr/setBlockAttrs').map((entry) => entry.payload.id)))
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

// C4 回归：替身自己（也就是"真实思源"这一侧）必须拒绝不存在的笔记本。
// 走原始 HTTP，绕开插件的 B5 预检，单独验证替身的行为与真实思源一致。
{
  const raw = await fetch(`${mock.baseUrl}/api/filetree/createDocWithMd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Token ${mock.token}` },
    body: JSON.stringify({ notebook: 'nb-nope', path: '/收件箱/糟糕', markdown: 'x' }),
  }).then((response) => response.json())
  check('替身对不存在的笔记本返回非 0 code', raw.code !== 0 && /notebook not found/.test(String(raw.msg)), JSON.stringify(raw))
}

// B5 回归：笔记本必须存在且已打开。改前 assertNotebook 只看"有没有填"，
// 往不存在的笔记本写会漏到思源那里，报错文案不可读（替身里甚至不会报错）。
const beforeBadNotebook = mock.requestsTo('/api/filetree/createDocWithMd').length
const badNotebook = await callTool('siyuan_create_doc', { notebook: 'nb-nope', path: '/收件箱/糟糕', markdown: 'x' })
check('create_doc 拒绝不存在的笔记本', badNotebook.ok === false && /不存在/.test(badNotebook.text), badNotebook.text)
check('笔记本不存在时不发 createDocWithMd 请求', mock.requestsTo('/api/filetree/createDocWithMd').length === beforeBadNotebook, String(mock.requestsTo('/api/filetree/createDocWithMd').length - beforeBadNotebook))

const badNotebookDaily = await callTool('siyuan_daily_note', { action: 'append', notebook: 'nb-nope', date: '2026-09-12', markdown: 'x' })
check('daily_note 也拒绝不存在的笔记本', badNotebookDaily.ok === false && /不存在/.test(badNotebookDaily.text), badNotebookDaily.text)

mock.setNotebookClosed('nb-proj')
const closedNotebook = await callTool('siyuan_create_doc', { notebook: 'nb-proj', path: '/项目/糟糕', markdown: 'x' })
check('create_doc 拒绝已关闭的笔记本', closedNotebook.ok === false && /关闭状态/.test(closedNotebook.text), closedNotebook.text)
mock.setNotebookClosed('nb-proj', false)
const reopenedNotebook = await callTool('siyuan_create_doc', { notebook: 'nb-proj', path: '/项目/正常', markdown: '# ok' })
check('笔记本重新打开后可正常创建', reopenedNotebook.ok && /已创建文档/.test(reopenedNotebook.text), reopenedNotebook.text)

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
// H6：单段不该出现多段警告
check('单段更新不带多段警告', updated.ok && !/只写入了第一段/.test(updated.text), updated.text)

// H6 回归：思源 updateBlock 对多段 Markdown 只保留第一段、其余静默丢弃。
// 改前工具一律回「已更新块」，模型以为多段都写进去了。
const multiParagraph = await callTool('siyuan_update_block', { blockId: firstBlockId, markdown: '第一段。\n\n第二段。\n\n第三段。' })
check('多段更新会明确警告只写入第一段', multiParagraph.ok && /只写入了第一段/.test(multiParagraph.text) && /siyuan_insert_block/.test(multiParagraph.text), multiParagraph.text)
check('多段更新后替身里确实只剩第一段', mock.state.blocks.get(firstBlockId).markdown === '第一段。', mock.state.blocks.get(firstBlockId).markdown)

const updateMissing = await callTool('siyuan_update_block', { blockId: 'blk-nope', markdown: 'x' })
check('update_block 目标不存在时报错而不是回成功', updateMissing.ok === false && /不存在/.test(updateMissing.text), updateMissing.text)
// 走的是工具自己的存在性预检，不该把请求打到思源
check('目标不存在时不发 updateBlock 请求', mock.requestsTo('/api/block/updateBlock').every((entry) => entry.payload.id !== 'blk-nope'), JSON.stringify(mock.requestsTo('/api/block/updateBlock').map((entry) => entry.payload.id)))

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

// 只断言「没有写入类请求」：新增的"笔记本必须存在且已打开"预检（B5）会先发一次
// lsNotebooks，那是设计内行为，不该被这条用例当成违规。
const writePaths = new Set(['/api/filetree/createDocWithMd', '/api/block/appendBlock', '/api/block/insertBlock', '/api/block/updateBlock'])
const beforeBadDate = mock.state.requests.filter((entry) => writePaths.has(entry.path)).length
for (const value of ['abc', '2026-13-45', '2026-02-30']) {
  const bad = await callTool('siyuan_daily_note', { action: 'append', date: value, markdown: '不该写进去' })
  check(`daily_note 非法 date=${value} 时拒绝写入`, bad.ok === false && /date/.test(bad.text), bad.text)
}
const writesAfterBadDate = mock.state.requests.filter((entry) => writePaths.has(entry.path)).length
check('非法 date 不产生任何写入请求', writesAfterBadDate === beforeBadDate, String(writesAfterBadDate - beforeBadDate))

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

// ── 删除复核窗口 ────────────────────────────────────────────────────────────

// H5 回归：思源的删除是异步落库的，复核窗口不能太短。
// 这里用「删除 3 秒后才落库」的替身——它超过旧实现的固定窗口（8 × 250ms = 2 秒），
// 旧实现会把这次**成功**的删除报成「删除未生效」。
console.log('— 删除复核窗口 —')
{
  const slowMock = await startMockSiYuan({ deleteDelayMs: 3000 })
  const slowHome = TEST_HOME + '-slow'
  fs.mkdirSync(`${slowHome}/storages/siyuan`, { recursive: true })
  fs.writeFileSync(
    `${slowHome}/storages/siyuan/config.json`,
    JSON.stringify({ baseUrl: slowMock.baseUrl, defaultNotebook: 'nb-inbox', tools: { read: true, write: true, daily: true, danger: true } }),
  )
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = slowHome

  const slowRegistered = new Map()
  const slowInject = {
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: slowMock.token, source: 'store' }), describe: async () => ({ configured: true, writable: true }) } : undefined),
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
    tools: { register: (definition) => { slowRegistered.set(definition.name, definition); return () => slowRegistered.delete(definition.name) } },
    webServer: { register: () => () => {} },
  }
  const slowOuter = {
    get: slowInject.get,
    effect: slowInject.effect,
    logger: slowInject.logger,
    inject: (_deps, callback) => callback(slowInject),
    get tools() { throw new Error('cannot get property "tools" without inject') },
    get webServer() { throw new Error('cannot get property "webServer" without inject') },
  }
  const fresh = await loadPlugin()
  fresh.apply(slowOuter)

  const slowDocId = slowMock.seedDoc()
  const startedAt = Date.now()
  const slowDelete = await (async () => {
    try {
      const value = await slowRegistered.get('siyuan_remove_doc').execute({ docId: slowDocId, confirm: true }, {})
      return { ok: true, text: value.result }
    } catch (error) {
      return { ok: false, text: error?.message ?? String(error) }
    }
  })()
  const elapsed = Date.now() - startedAt

  check('落库延迟 3 秒时删除仍判定为成功（旧 2 秒窗口会误报失败）', slowDelete.ok === true, slowDelete.text)
  check('慢删除会告知复核耗时', slowDelete.ok === true && /复核用了 \d+ms/.test(slowDelete.text), slowDelete.text)
  check('实际等待超过旧的 2 秒窗口', elapsed > 2000, `${elapsed}ms`)
  check('删除确实落库（替身里已查不到）', slowMock.state.docs.has(slowDocId) === false, slowDocId)

  process.env.DSH_HOME = previousHome
  await slowMock.close()
}

// ── 取消（abort）────────────────────────────────────────────────────────────

// B1 回归：工具被取消时必须及时中断。改前 signal 只在入口检查一次、sleep 不可取消，
// 所以取消发生在删除复核轮询期间时毫无作用——工具会把整个复核预算（最长 6 秒）跑完
// 再返回「已删除」。
console.log('— 取消（abort）—')
{
  const abortMock = await startMockSiYuan({ deleteDelayMs: 3000 })
  const abortHome = TEST_HOME + '-abort'
  fs.mkdirSync(`${abortHome}/storages/siyuan`, { recursive: true })
  fs.writeFileSync(
    `${abortHome}/storages/siyuan/config.json`,
    JSON.stringify({ baseUrl: abortMock.baseUrl, defaultNotebook: 'nb-inbox', tools: { read: true, write: true, daily: true, danger: true } }),
  )
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = abortHome

  const abortRegistered = new Map()
  const abortInject = {
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: abortMock.token, source: 'store' }), describe: async () => ({ configured: true, writable: true }) } : undefined),
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
    tools: { register: (definition) => { abortRegistered.set(definition.name, definition); return () => abortRegistered.delete(definition.name) } },
    webServer: { register: () => () => {} },
  }
  const abortOuter = {
    get: abortInject.get,
    effect: abortInject.effect,
    logger: abortInject.logger,
    inject: (_deps, callback) => callback(abortInject),
    get tools() { throw new Error('cannot get property "tools" without inject') },
    get webServer() { throw new Error('cannot get property "webServer" without inject') },
  }
  const abortPlugin = await loadPlugin()
  abortPlugin.apply(abortOuter)

  const abortDocId = abortMock.seedDoc()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const abortStartedAt = Date.now()
  const abortedCall = await (async () => {
    try {
      const value = await abortRegistered.get('siyuan_remove_doc').execute({ docId: abortDocId, confirm: true }, { signal: controller.signal })
      return { ok: true, text: value.result, name: '' }
    } catch (error) {
      return { ok: false, text: error?.message ?? String(error), name: error?.name ?? '' }
    }
  })()
  const abortElapsed = Date.now() - abortStartedAt

  check('取消后删除工具立刻抛错', abortedCall.ok === false, abortedCall.text)
  check('取消抛出的是 AbortError（官方包装成 ABORTED 的契约）', abortedCall.name === 'AbortError', abortedCall.name || '(空)')
  check('取消后不等复核预算跑完（< 1 秒）', abortElapsed < 1000, `${abortElapsed}ms`)

  const freshAbortPlugins = await loadPlugin()
  const preAborted = new AbortController()
  preAborted.abort()
  let entryError = null
  try {
    await abortRegistered.get('siyuan_list_notebooks').execute({}, { signal: preAborted.signal })
  } catch (error) {
    entryError = error
  }
  check('入口即已取消时也抛 AbortError', entryError !== null && entryError.name === 'AbortError', entryError === null ? '未抛错' : entryError.name)
  check('入口取消不发出任何请求', abortMock.requestsTo('/api/notebook/lsNotebooks').length === 0, String(abortMock.requestsTo('/api/notebook/lsNotebooks').length))

  const sleepAbort = new AbortController()
  setTimeout(() => sleepAbort.abort(), 50)
  const sleepStartedAt = Date.now()
  let sleepRejected = ''
  try {
    await freshAbortPlugins.internals.sleepAbortable(5000, sleepAbort.signal)
  } catch (error) {
    sleepRejected = error?.name ?? String(error)
  }
  check('可中断 sleep 在取消时立刻结束', sleepRejected === 'AbortError' && Date.now() - sleepStartedAt < 1000, `${sleepRejected} / ${Date.now() - sleepStartedAt}ms`)

  // 取消发生在「一次请求正在路上」时：只有请求本身带上取消信号才能立刻结束，
  // 否则要等这次响应回来（下面配的是 3 秒）才能轮询到下一个检查点。
  const stalledHome = TEST_HOME + '-stalled'
  fs.rmSync(stalledHome, { recursive: true, force: true })
  fs.mkdirSync(`${stalledHome}/storages/siyuan`, { recursive: true })
  const stalledMock = await startMockSiYuan({ responseDelayMs: 3000 })
  fs.writeFileSync(
    `${stalledHome}/storages/siyuan/config.json`,
    JSON.stringify({ baseUrl: stalledMock.baseUrl, defaultNotebook: 'nb-inbox', tools: { read: true, write: true, daily: true, danger: true } }),
  )
  process.env.DSH_HOME = stalledHome
  const stalledRegistered = new Map()
  const stalledInject = {
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: stalledMock.token, source: 'store' }), describe: async () => ({ configured: true, writable: true }) } : undefined),
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
    tools: { register: (definition) => { stalledRegistered.set(definition.name, definition); return () => stalledRegistered.delete(definition.name) } },
    webServer: { register: () => () => {} },
  }
  const stalledPlugin = await loadPlugin()
  stalledPlugin.apply({
    get: stalledInject.get,
    effect: stalledInject.effect,
    logger: stalledInject.logger,
    inject: (_deps, callback) => callback(stalledInject),
    get tools() { throw new Error('cannot get property "tools" without inject') },
    get webServer() { throw new Error('cannot get property "webServer" without inject') },
  })

  const stalledController = new AbortController()
  setTimeout(() => stalledController.abort(), 300)
  const stalledStartedAt = Date.now()
  let stalledName = ''
  try {
    await stalledRegistered.get('siyuan_list_notebooks').execute({}, { signal: stalledController.signal })
  } catch (error) {
    stalledName = error?.name ?? ''
  }
  const stalledElapsed = Date.now() - stalledStartedAt
  check('请求进行中取消会立刻中止该请求', stalledName === 'AbortError' && stalledElapsed < 1500, `${stalledName} / ${stalledElapsed}ms（请求响应延迟 3000ms）`)
  process.env.DSH_HOME = previousHome
  await stalledMock.close()

  process.env.DSH_HOME = previousHome
  await abortMock.close()
}

// ── 工具分支缺口（C6）──────────────────────────────────────────────────────

console.log('— 工具分支缺口 —')
{
  // 未配置默认笔记本且未显式传 notebook：三个工具都要给出可读错误，而不是发请求。
  const savedConfig = JSON.parse(fs.readFileSync(`${TEST_HOME}/storages/siyuan/config.json`, 'utf8'))
  fs.writeFileSync(`${TEST_HOME}/storages/siyuan/config.json`, JSON.stringify({ ...savedConfig, defaultNotebook: '' }))
  const noNotebook = await callTool('siyuan_list_docs', { path: '/' })
  check('list_docs 缺 notebook 时报可读错误', noNotebook.ok === false && /未指定笔记本/.test(noNotebook.text), noNotebook.text)
  const noNotebookDaily = await callTool('siyuan_daily_note', { action: 'read' })
  check('daily_note 缺 notebook 时报可读错误', noNotebookDaily.ok === false && /未指定笔记本/.test(noNotebookDaily.text), noNotebookDaily.text)
  const noNotebookCreate = await callTool('siyuan_create_doc', { path: '/x', markdown: 'x' })
  check('create_doc 缺 notebook 时报可读错误', noNotebookCreate.ok === false && /未指定笔记本/.test(noNotebookCreate.text), noNotebookCreate.text)
  fs.writeFileSync(`${TEST_HOME}/storages/siyuan/config.json`, JSON.stringify(savedConfig))

  // insert_block 的 parentId 分支（此前只覆盖了 previousId）
  const parentDoc = mock.seedDoc({ hpath: '/收件箱/父块用例' })
  const parentBlockId = [...mock.state.blocks.values()].find((block) => block.docId === parentDoc).id
  const insertedByParent = await callTool('siyuan_insert_block', { parentId: parentBlockId, markdown: '挂在父块下。' })
  check('insert_block 支持 parentId 分支', insertedByParent.ok && /已插入块/.test(insertedByParent.text), insertedByParent.text)
  const parentRequests = mock.requestsTo('/api/block/insertBlock').filter((entry) => entry.payload.parentID === parentBlockId)
  check('parentId 走的是 parentID 字段', parentRequests.length > 0 && parentRequests.every((entry) => entry.payload.previousID === undefined), JSON.stringify(parentRequests[0]?.payload))

  // set_block_attrs 的 attrs 非对象拒绝
  const badAttrs = await callTool('siyuan_set_block_attrs', { id: docId, attrs: ['not-an-object'] })
  check('set_block_attrs 拒绝非对象 attrs', badAttrs.ok === false && /attrs 必须是对象/.test(badAttrs.text), badAttrs.text)

  // move_doc 的 toId 空串（此前只覆盖了 docIds 为空）
  const emptyToId = await callTool('siyuan_move_doc', { docIds: [parentDoc], toId: '   ' })
  check('move_doc 拒绝空 toId', emptyToId.ok === false && /必须提供 toId/.test(emptyToId.text), emptyToId.text)

  // read_doc 的 format 非法回落 text
  // 目标块的标题段在前面被改写/删除了，这里断言正文，避免依赖测试执行顺序。
  const fallbackFormat = await callTool('siyuan_read_doc', { id: docId, format: 'html' })
  check('read_doc 非法 format 回落为 text', fallbackFormat.ok && /追加的结论/.test(fallbackFormat.text) && !fallbackFormat.text.includes('<'), fallbackFormat.text.slice(0, 120))

  // search 无命中
  const noHit = await callTool('siyuan_search', { query: '绝对不存在的关键词zzz' })
  check('search 无命中时给出可读提示', noHit.ok && /没有命中/.test(noHit.text), noHit.text)

  // sql 空结果
  const emptySql = await callTool('siyuan_sql', { stmt: "SELECT type FROM blocks WHERE id = 'blk-none'" })
  check('sql 无结果时提示（没有结果）', emptySql.ok && /没有结果/.test(emptySql.text), emptySql.text)

  // get_child_blocks 空结构
  const emptyChildren = await callTool('siyuan_get_child_blocks', { id: 'blk-nope' })
  check('get_child_blocks 空结构时给出提示', emptyChildren.ok && /没有子块/.test(emptyChildren.text), emptyChildren.text)

  // list_docs 空目录
  const emptyDir = await callTool('siyuan_list_docs', { path: '/根本不存在的目录' })
  check('list_docs 空目录时给出提示', emptyDir.ok && /没有子文档/.test(emptyDir.text), emptyDir.text)
}

// goLayout / 日记路径渲染：单趟替换的回归（顺序替换会把 2026 变成 2126）
console.log('— 日记路径渲染 —')
{
  const { goLayout, renderDailyPath, parseDateArg } = plugin.internals
  const date = parseDateArg('2026-09-12')
  check('goLayout 渲染 2006/01/02', goLayout(date, '2006/01/02') === '2026/09/12', goLayout(date, '2006/01/02'))
  check('goLayout 渲染 2006-01-02 不会产出 2126', goLayout(date, '2006-01-02') === '2026-09-12', goLayout(date, '2006-01-02'))
  check('goLayout 渲染时间片段', goLayout(new Date(2026, 8, 12, 7, 5, 3), '15:04:05') === '07:05:03', goLayout(new Date(2026, 8, 12, 7, 5, 3), '15:04:05'))
  check('goLayout 渲染 Jan / Mon', goLayout(date, 'Jan Mon') === 'Sep Sat', goLayout(date, 'Jan Mon'))
  // C2 回归：长 token 必须先于能被它截短命中的短 token。2026-09-12 是周六，
  // 改前 'Monday' 里的 'Mon' 命中前缀，渲染成 "Satday"，日记会按损坏路径"成功"创建。
  check('goLayout 渲染 Monday 不产 "Satday"', goLayout(date, '2006-01-02 Monday') === '2026-09-12 Saturday', goLayout(date, '2006-01-02 Monday'))
  check('goLayout 渲染 January 不产 "Sepuary"', goLayout(date, 'January 2006') === 'September 2026', goLayout(date, 'January 2006'))
  check('goLayout 短 token 行为不变', goLayout(date, 'Jan') === 'Sep' && goLayout(date, 'Mon') === 'Sat', goLayout(date, 'Jan Mon'))
  check('renderDailyPath 展开 Monday 模板', renderDailyPath('/日记/{{now | date "2006-01-02 Monday"}}', date) === '/日记/2026-09-12 Saturday', renderDailyPath('/日记/{{now | date "2006-01-02 Monday"}}', date))
  check('renderDailyPath 展开 {{now | date}}', renderDailyPath('/daily note/{{now | date "2006/01/02"}}', date) === '/daily note/2026/09/12', renderDailyPath('/daily note/{{now | date "2006/01/02"}}', date))
  check('renderDailyPath 支持多个占位符', renderDailyPath('/{{now | date "2006"}}/{{now | date "01"}}', date) === '/2026/09', renderDailyPath('/{{now | date "2006"}}/{{now | date "01"}}', date))
  check('renderDailyPath 原样保留无占位符模板', renderDailyPath('/固定路径', date) === '/固定路径')
}

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
  cleanupHome()
  process.exit(0)
}
console.log(`${failures.length} 项失败（临时 home 保留在 ${TEST_HOME}）：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
