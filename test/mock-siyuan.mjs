/**
 * 思源 API 的本地替身，用于在没有 token / 不动真实笔记库的前提下端到端测试
 * dsh-siyuan 的全部工具。
 *
 * 行为对齐 docs/siyuan-api-cheatsheet.md 与实测要点：
 *  - 一律 HTTP 200，成败看响应体 code（0 成功，非 0 失败）；
 *  - 除 /api/system/version 外都要求 `Authorization: Token <token>`；
 *  - createDocWithMd 非幂等（同路径重复调用会新建同名文档）；
 *  - getChildBlocks 只回 id/type/subType，正文得另查 SQL；
 *  - getDoc 回 DOM，折叠标题下的内容不在 DOM 里。
 *
 * 记录每个请求，供测试断言插件实际发出的请求体。
 */

import http from 'node:http'

export async function startMockSiYuan({ token = 'test-token', deleteDelayMs = 0 } = {}) {
  const state = {
    notebooks: [
      {
        id: 'nb-inbox',
        name: '收件箱',
        closed: false,
        dailyNoteSavePath: '/daily note/{{now | date "2006/01"}}/{{now | date "2006-01-02"}}',
      },
      { id: 'nb-proj', name: '项目', closed: false, dailyNoteSavePath: '/日记/{{now | date "2006-01-02"}}' },
    ],
    docs: new Map(),
    blocks: new Map(),
    attrs: new Map(),
    requests: [],
    sequence: 0,
  }

  const nextId = (prefix) => {
    state.sequence += 1
    return `${prefix}-${String(state.sequence).padStart(4, '0')}`
  }

  const docOf = (id) => state.docs.get(id)
  const blocksOfDoc = (docId) => [...state.blocks.values()].filter((block) => block.docId === docId)

  function addBlocks(doc, markdown) {
    const parts = String(markdown).split(/\n{2,}/).filter((part) => part.trim() !== '')
    if (parts.length === 0) parts.push('')
    for (const part of parts) {
      const text = part.trim()
      const heading = /^(#{1,6})\s+(.*)$/.exec(text)
      const block = {
        id: nextId('blk'),
        docId: doc.id,
        type: heading === null ? (text.startsWith('- ') ? 'i' : 'p') : 'h',
        markdown: text,
      }
      state.blocks.set(block.id, block)
    }
  }

  function createDoc(notebook, hpath, markdown) {
    const doc = { id: nextId('doc'), notebook, hpath, createdBy: 'createDocWithMd' }
    state.docs.set(doc.id, doc)
    addBlocks(doc, markdown)
    return doc
  }

  function domOf(docId) {
    const parts = blocksOfDoc(docId).map((block) => {
      const text = block.markdown
      const heading = /^(#{1,6})\s+(.*)$/.exec(text)
      if (heading !== null) {
        const level = heading[1].length
        // 折叠标题：DOM 里只给标题本身，子块内容不出现（对齐实测行为）
        const folded = state.blocks.get(block.id)?.folded === true ? ' fold="1"' : ''
        return `<h${level} data-node-id="${block.id}"${folded}>${heading[2]}</h${level}>`
      }
      if (text.startsWith('- ')) return `<li data-node-id="${block.id}">${text.slice(2)}</li>`
      if (text === '') return `<p data-node-id="${block.id}"></p>`
      return `<p data-node-id="${block.id}">${text}</p>`
    })
    return parts.join('')
  }

  function markdownOf(docId) {
    return blocksOfDoc(docId)
      .map((block) => block.markdown)
      .join('\n\n')
  }

  // ── 路由 ────────────────────────────────────────────────────────────────

  const handlers = {
    '/api/system/version': () => '3.8.3',
    '/api/system/bootProgress': () => ({ progress: 100, details: 'mock' }),

    '/api/notebook/lsNotebooks': () => ({
      notebooks: state.notebooks.map(({ id, name, closed }) => ({ id, name, closed, icon: '', sort: 0 })),
    }),
    '/api/notebook/getNotebookConf': (payload) => {
      const notebook = state.notebooks.find((item) => item.id === payload.notebook)
      if (notebook === undefined) throw new MockError(`notebook not found: ${String(payload.notebook)}`)
      return { box: notebook.id, name: notebook.name, conf: { ...notebook } }
    },

    '/api/filetree/getIDsByHPath': (payload) =>
      [...state.docs.values()].filter((doc) => doc.notebook === payload.notebook && doc.hpath === payload.path).map((doc) => doc.id),
    '/api/filetree/createDocWithMd': (payload) => {
      if (typeof payload.path !== 'string' || !payload.path.startsWith('/')) throw new MockError('path must start with /')
      const doc = createDoc(payload.notebook, payload.path, payload.markdown ?? '')
      return doc.id
    },
    '/api/filetree/listDocsByPath': (payload) => {
      const prefix = payload.path === '/' ? '/' : String(payload.path)
      const files = [...state.docs.values()]
        .filter((doc) => doc.notebook === payload.notebook && doc.hpath.startsWith(prefix))
        .map((doc) => ({ id: doc.id, name: doc.hpath.split('/').pop(), subFileCount: 0 }))
      return { path: payload.path, files }
    },
    '/api/filetree/getDoc': (payload) => {
      const doc = docOf(payload.id)
      if (doc === undefined) return { id: payload.id, content: '' }
      return { id: doc.id, content: domOf(doc.id) }
    },
    '/api/export/exportMdContent': (payload) => {
      const doc = docOf(payload.id)
      if (doc === undefined) throw new MockError(`doc not found: ${String(payload.id)}`)
      return { hPath: doc.hpath, content: markdownOf(doc.id) }
    },

    '/api/filetree/renameDocByID': (payload) => {
      const doc = docOf(payload.id)
      if (doc === undefined) throw new MockError(`doc not found: ${String(payload.id)}`)
      const title = String(payload.title ?? '').trim()
      if (title === '') throw new MockError('title must not be empty')
      const parent = doc.hpath.split('/').slice(0, -1).join('/')
      doc.hpath = `${parent}/${title}`
      return null
    },
    '/api/filetree/moveDocsByID': (payload) => {
      const fromIDs = Array.isArray(payload.fromIDs) ? payload.fromIDs : []
      if (fromIDs.length === 0) throw new MockError('fromIDs must not be empty')
      const toID = String(payload.toID ?? '')
      const targetNotebook = state.notebooks.find((item) => item.id === toID)
      const targetDoc = docOf(toID)
      if (targetNotebook === undefined && targetDoc === undefined) throw new MockError(`target not found: ${toID}`)
      for (const fromID of fromIDs) {
        const doc = docOf(fromID)
        if (doc === undefined) throw new MockError(`doc not found: ${String(fromID)}`)
        const title = doc.hpath.split('/').pop()
        if (targetNotebook !== undefined) {
          doc.notebook = targetNotebook.id
          doc.hpath = `/${title}`
        } else {
          doc.notebook = targetDoc.notebook
          doc.hpath = `${targetDoc.hpath}/${title}`
        }
      }
      return null
    },
    '/api/filetree/removeDocByID': (payload) => {
      const doc = docOf(payload.id)
      if (doc === undefined) throw new MockError(`doc not found: ${String(payload.id)}`)
      const apply = () => {
        state.docs.delete(doc.id)
        for (const [id, block] of [...state.blocks.entries()]) if (block.docId === doc.id) state.blocks.delete(id)
      }
      // 实测：思源的删除是异步落库的，返回成功时 blocks 行还在。
      if (deleteDelayMs > 0) setTimeout(apply, deleteDelayMs)
      else apply()
      return null
    },

    '/api/block/appendBlock': (payload) => {
      const doc = docOf(payload.parentID)
      if (doc === undefined) throw new MockError(`parent not found: ${String(payload.parentID)}`)
      const before = blocksOfDoc(doc.id).length
      addBlocks(doc, payload.data ?? '')
      const added = blocksOfDoc(doc.id).length - before
      return [{ doOperations: [{ action: 'insert', parentID: doc.id, count: added }] }]
    },
    '/api/block/insertBlock': (payload) => {
      const anchor = state.blocks.get(payload.previousID)
      const parent = docOf(payload.parentID)
      const docId = anchor?.docId ?? parent?.id
      const doc = docOf(docId)
      if (doc === undefined) throw new MockError('insertBlock needs an existing previousID or parentID')
      const created = []
      const before = blocksOfDoc(doc.id).length
      addBlocks(doc, payload.data ?? '')
      const all = blocksOfDoc(doc.id)
      for (const block of all.slice(before)) created.push({ id: block.id, previousID: payload.previousID ?? '' })
      return [{ doOperations: [{ action: 'insert', data: created }] }]
    },
    '/api/block/updateBlock': (payload) => {
      const block = state.blocks.get(payload.id)
      if (block === undefined) throw new MockError(`block not found: ${String(payload.id)}`)
      // 实测行为：多段 Markdown 只保留第一段
      block.markdown = String(payload.data ?? '').split(/\n{2,}/)[0]
      return [{ doOperations: [{ action: 'update', id: block.id }] }]
    },
    '/api/block/deleteBlock': (payload) => {
      // 实测行为（思源 3.8.3）：文档块走 deleteBlock 会返回成功但什么都不删。
      if (state.docs.has(payload.id)) return [{ doOperations: [{ action: 'delete', id: payload.id }] }]
      if (!state.blocks.has(payload.id)) throw new MockError(`block not found: ${String(payload.id)}`)
      const apply = () => state.blocks.delete(payload.id)
      if (deleteDelayMs > 0) setTimeout(apply, deleteDelayMs)
      else apply()
      return [{ doOperations: [{ action: 'delete', id: payload.id }] }]
    },
    '/api/block/getChildBlocks': (payload) => {
      const doc = docOf(payload.id)
      const list = doc === undefined ? [] : blocksOfDoc(doc.id)
      return list.map((block) => ({ id: block.id, type: block.type, subType: block.type === 'h' ? 'h2' : undefined }))
    },

    '/api/attr/getBlockAttrs': (payload) => ({ id: payload.id, ...(state.attrs.get(payload.id) ?? {}) }),
    '/api/attr/setBlockAttrs': (payload) => {
      state.attrs.set(payload.id, { ...(state.attrs.get(payload.id) ?? {}), ...(payload.attrs ?? {}) })
      return null
    },

    '/api/query/sql': (payload) => {
      const stmt = String(payload.stmt ?? '')
      if (!/^select\b/i.test(stmt.trim())) throw new MockError('only SELECT is allowed')
      if (/select\s+1\s+as\s+ok/i.test(stmt)) return [{ ok: 1 }]
      // 单 id 查类型（插件用它区分文档块 / 内容块，并在删除后复核）
      const singleId = /where\s+id\s*=\s*'([^']+)'/i.exec(stmt)
      if (singleId !== null) {
        const id = singleId[1]
        if (state.docs.has(id)) return [{ id, type: 'd' }]
        if (state.blocks.has(id)) return [{ id, type: state.blocks.get(id).type }]
        return []
      }
      const inClause = /where\s+id\s+in\s*\(([^)]*)\)/i.exec(stmt)
      if (inClause !== null) {
        const ids = inClause[1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''))
        return ids.filter((id) => state.blocks.has(id)).map((id) => ({ id, markdown: state.blocks.get(id).markdown }))
      }
      // blocks 表：按 root_id 列某文档的全部块
      const rootClause = /root_id\s*=\s*"([^"]+)"/i.exec(stmt) ?? /root_id\s*=\s*'([^']+)'/i.exec(stmt)
      if (rootClause !== null) {
        return blocksOfDoc(rootClause[1]).map((block) => ({ id: block.id, type: block.type, parent_id: block.docId, markdown: block.markdown }))
      }
      return []
    },

    '/api/search/fullTextSearchBlock': (payload) => {
      const query = String(payload.query ?? '')
      const limit = Number.isFinite(payload.limit) ? Number(payload.limit) : 20
      const hits = []
      for (const doc of state.docs.values()) {
        for (const block of blocksOfDoc(doc.id)) {
          if (!block.markdown.includes(query)) continue
          hits.push({
            id: block.id,
            rootID: doc.id,
            hPath: doc.hpath,
            box: doc.notebook,
            type: block.type,
            content: block.markdown.replace(query, `<mark>${query}</mark>`),
          })
        }
      }
      return { blocks: hits.slice(0, limit), matchedBlockCount: hits.length }
    },
  }

  class MockError extends Error {}

  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let payload = {}
      try {
        payload = raw === '' ? {} : JSON.parse(raw)
      } catch {
        payload = {}
      }
      const pathname = new URL(request.url ?? '/', 'http://mock.invalid').pathname
      const authorized = request.headers.authorization === `Token ${token}`
      state.requests.push({ path: pathname, payload, authorized, rawBody: raw })

      const reply = (code, msg, data) => {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ code, msg, data: data ?? null }))
      }

      if (pathname === '/api/system/version' || pathname === '/api/system/bootProgress') {
        reply(0, '', handlers[pathname](payload))
        return
      }
      if (!authorized) {
        reply(-1, 'Auth failed', null)
        return
      }
      if (pathname === '/api/not-json') {
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.end('<html>nope</html>')
        return
      }
      const handler = handlers[pathname]
      if (handler === undefined) {
        reply(-1, `mock has no handler for ${pathname}`, null)
        return
      }
      try {
        reply(0, '', handler(payload))
      } catch (error) {
        reply(-1, error?.message ?? String(error), null)
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    token,
    state,
    /** 预置一篇文档，返回其 id。 */
    seedDoc({ notebook = 'nb-inbox', hpath = '/收件箱/会议纪要', markdown = '# 会议纪要\n\n讨论了排期与预算。\n\n- 第一项\n- 第二项' } = {}) {
      const doc = createDoc(notebook, hpath, markdown)
      return doc.id
    },
    requestsTo(path) {
      return state.requests.filter((entry) => entry.path === path)
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
