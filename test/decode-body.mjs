/**
 * dsh-siyuan 响应解码测试：覆盖「压缩体与 content-encoding 不一致」的各种形态。
 *
 * 起因：DSH 0.1.7 把内置 undici 升到 8.11.0 后，经全局代理 dispatcher
 * （EnvHttpProxyAgent）的响应会**留下 gzip 体并把 content-encoding 丢掉**；
 * 而 0.1.5/0.1.6（undici 8.10.2）是「头写 gzip、体已明文」。两种形态都要能解析。
 *
 * 不联网、不碰真实思源：替换 globalThis.fetch 返回预制的 Response，走真实的
 * siyuanFetch（请求头 → arrayBuffer → decodeResponseBody → JSON.parse），
 * 因此请求头、JSON 错误文案这些旁支也一并被断言到。
 *
 * 用法：node test/decode-body.mjs
 */

import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { internals } from '../lib/index.js'

const { decodeResponseBody, siyuanFetch } = internals

const failures = []
function check(label, condition, detail) {
  if (condition === true) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label + (detail === undefined ? '' : ` — ${detail}`))
    console.log(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}`)
  }
}

/** 与思源一致的响应约定：HTTP 200，成败看 body.code。 */
const OK_BODY = JSON.stringify({ code: 0, msg: '', data: { notebooks: [{ id: 'nb1', name: '测试笔记本' }] } })
const OK_DATA = { notebooks: [{ id: 'nb1', name: '测试笔记本' }] }

// ── fetch 替身 ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch
let lastRequest = null
/** 用给定字节与 content-encoding 应答下一次请求；ce 为 null 表示宿主把这个头丢了。 */
function stubFetch(bytes, contentEncoding) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, init }
    const headers = contentEncoding === null ? {} : { 'content-encoding': contentEncoding }
    return new Response(bytes, { status: 200, headers })
  }
}
const callFetch = (bytes, ce) => {
  stubFetch(bytes, ce)
  return siyuanFetch({ baseUrl: 'http://siyuan.test/' }, 'tok', '/api/notebook/lsNotebooks', {})
}

// ── 解码矩阵 ────────────────────────────────────────────────────────────────

// [标签, 响应字节, content-encoding, 期望 body]
const CASES = [
  ['gzip + ce=gzip（中间层没解压）', gzipSync(Buffer.from(OK_BODY)), 'gzip', OK_BODY],
  ['gzip + ce=null（DSH 0.1.7 的坏形态）', gzipSync(Buffer.from(OK_BODY)), null, OK_BODY],
  ['zlib + ce=deflate', deflateSync(Buffer.from(OK_BODY)), 'deflate', OK_BODY],
  ['zlib + ce=null', deflateSync(Buffer.from(OK_BODY)), null, OK_BODY],
  ['brotli + ce=br', brotliCompressSync(Buffer.from(OK_BODY)), 'br', OK_BODY],
  ['明文 + ce=gzip（DSH 0.1.5/0.1.6：头没删、体已解压）', Buffer.from(OK_BODY), 'gzip', OK_BODY],
  ['明文 + ce=null', Buffer.from(OK_BODY), null, OK_BODY],
]

const run = async () => {
  console.log('— 解码矩阵：siyuanFetch 端到端（替身 fetch）—')
  for (const [label, bytes, ce, expected] of CASES) {
    let data = null
    let error = null
    try {
      data = await callFetch(bytes, ce)
    } catch (err) {
      error = err
    }
    check(`解析成功：${label}`, error === null, error?.message)
    if (error === null) {
      check(`data 正确：${label}`, JSON.stringify(data) === JSON.stringify(OK_DATA), JSON.stringify(data))
    }
  }

  // 请求头是补丁的一部分（明确要 gzip，交给宿主/中间层去解或不解压）。
  check('请求带 Accept-Encoding: gzip', lastRequest?.init?.headers?.['Accept-Encoding'] === 'gzip', JSON.stringify(lastRequest?.init?.headers))
  check('鉴权头保持原样', lastRequest?.init?.headers?.Authorization === 'Token tok', JSON.stringify(lastRequest?.init?.headers))
  check('方法仍是 POST', lastRequest?.init?.method === 'POST', String(lastRequest?.init?.method))
  check('去掉 baseUrl 末尾斜杠再拼路径', lastRequest?.url === 'http://siyuan.test/api/notebook/lsNotebooks', String(lastRequest?.url))

  // ── 魔数优先于响应头 ──────────────────────────────────────────────────────
  console.log('— 魔数优先：头与字节冲突时以字节为准 —')
  {
    const gz = gzipSync(Buffer.from(OK_BODY))
    check('gzip 字节 + ce=br 仍按 gzip 解', decodeResponseBody(gz, 'br').toString('utf8') === OK_BODY)
    const zl = deflateSync(Buffer.from(OK_BODY))
    check('zlib 字节 + ce=gzip 仍按 zlib 解', decodeResponseBody(zl, 'gzip').toString('utf8') === OK_BODY)
    check('ce 大小写与空白不敏感（br）', decodeResponseBody(brotliCompressSync(Buffer.from(OK_BODY)), ' BR ').toString('utf8') === OK_BODY)
  }

  // ── 解压失败 / 非 JSON 的降级路径 ─────────────────────────────────────────
  console.log('— 降级路径：解压失败退回原文，错误信息可远程排障 —')
  {
    const truncated = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])
    check('截断的 gzip 退回原文而不是抛异常', decodeResponseBody(truncated, null).equals(truncated))

    const html = Buffer.from('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>')
    let error = null
    try {
      await callFetch(html, null)
    } catch (err) {
      error = err
    }
    // SiYuanError 没有覆盖 name（仍是 'Error'），用构造器名断言，避免把普通 Error 放过去。
    check('HTML 错误页抛出 SiYuanError', error !== null && error.constructor?.name === 'SiYuanError', String(error?.constructor?.name))
    check('错误信息含「无法解析为 JSON」', /无法解析为 JSON/.test(error?.message ?? ''), error?.message)
    check('错误信息带 content-encoding', /content-encoding=null/.test(error?.message ?? ''), error?.message)
    // "<!DOCTYPE" 的前 8 字节是 "<!DOCTYP"，末尾的 ） 正好卡住「不多不少 8 个」。
    check('错误信息带前 8 字节 hex', /前 8 字节=3c 21 44 4f 43 54 59 50）/.test(error?.message ?? ''), error?.message)

    // 截断 gzip 走完 siyuanFetch 时，报错也要带上真实的头/字节，而不是解压异常。
    let gzError = null
    try {
      await callFetch(truncated, null)
    } catch (err) {
      gzError = err
    }
    check('截断 gzip 报可诊断错误而非 zlib 原生错误', /无法解析为 JSON/.test(gzError?.message ?? ''), gzError?.message)
    check('截断 gzip 的报错带 1f 8b 08 00', /1f 8b 08 00/.test(gzError?.message ?? ''), gzError?.message)
  }

  // ── 业务失败面不受影响 ────────────────────────────────────────────────────
  console.log('— 业务失败面：解码后 code!=0 仍按原语义报错 —')
  {
    const failBody = gzipSync(Buffer.from(JSON.stringify({ code: -1, msg: 'notebook not found' })))
    let error = null
    try {
      await callFetch(failBody, null)
    } catch (err) {
      error = err
    }
    check('gzip 体里的业务失败被正确解出', /code=-1 msg=notebook not found/.test(error?.message ?? ''), error?.message)
  }
}

try {
  await run()
} finally {
  globalThis.fetch = originalFetch
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
}
console.log(`${failures.length} 项失败：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
