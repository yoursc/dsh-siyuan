# 更新日志

版本语义跟着**实际验证过的 dsh 版本**走；兼容范围的写法与理由见 [`docs/DEV.md`](docs/DEV.md#发布)。

## 0.0.3 — 2026-09-22

### 修复

- **适配 DSH 0.1.7：undici 8.11 在代理 dispatcher 下不解压 gzip，且丢掉 `content-encoding`。**
  DSH 0.1.7-alpha.1 把内置 undici 从 8.10.2 升到 8.11.0。经宿主全局代理 dispatcher
  （`EnvHttpProxyAgent`）的响应不再自动解压，`content-encoding` 响应头还变成 `null`，
  body 却仍是压缩体。此时插件拿到的是 `1f 8b 08 …`，`JSON.parse` 失败，报
  「返回了非 JSON 响应（HTTP 200）」，`getState.reachable` 为 `false`，17 个工具全部不可用。
  现在 `siyuanFetch` 改为**自适应解码**：先按魔数判断字节实际是什么（gzip `1f 8b`、
  zlib `78 01/9c/da`），响应头只用于没有魔数的 br，解压失败退回原文；请求显式带
  `Accept-Encoding: gzip`。DSH 0.1.5/0.1.6（头写 gzip、体已明文）与 0.1.7（头丢失、
  体仍压缩）都能正常解析。
- JSON 解析失败时的报错补上 `content-encoding` 与响应体前 8 字节 hex，便于远程排障。

### 变更

- 兼容范围由 `^0.1.5-rc.1` 改为 `>=0.1.5-rc.1 || >=0.1.6-0 || >=0.1.7-0`
  （`dsh.engines.dsh` 与 `dshhub.compatibility.dsh` 两处同步）：含预发布的 caret 范围
  不匹配 `0.1.6-*` / `0.1.7-*`，会把新宿主判为不兼容。

### 测试

- 新增 `test/decode-body.mjs`：压缩体与 `content-encoding` 不一致的解码矩阵
  （gzip / zlib / brotli / 明文 × 响应头为对应值 / `null`）、魔数优先于响应头、
  解压失败降级、HTML 错误页透传与报错信息。摘掉补丁后 12 项变红。

> 0.0.1 / 0.0.2 发布于本文件建立之前，未补条目；历史见 `git log`。
