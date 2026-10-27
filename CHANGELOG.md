# 更新日志

版本语义跟着**实际验证过的 dsh 版本**走；兼容范围的写法与理由见 [`docs/DEV.md`](docs/DEV.md#发布)。

## 0.0.4 — 2026-10-27

### 修复

- **修复反向代理子路径部署下设置页 API 请求丢失前缀的问题。** 设置页改用相对 API 路径，兼容飞牛 `fngateway` 等子路径部署；新增对应回归测试。
- **地址下面的测试不再把「没配 token」误报成「地址填错了」。**
  原先那个按钮是"三条探测全过才算成功"：没配 token 时，两条需要鉴权的探测必然失败，
  红字「有探测项失败」又落在**地址**卡里，用户只会读成地址不对——可下方探明细里
  思源版本明明读得到，地址本来就是通的。地址与 token 的判定拆成两个按钮，各管一件事。

### 变更

- **声明兼容 DSH 0.2.1-rc.3**：插件已在该版本真机验证可运行，兼容范围同步写入 `dsh.engines.dsh` 与 `dshhub.compatibility.dsh`，避免安装时误报依赖不兼容。
- **插件页支持中英文显示名称**：英文显示为 `SiYuan Notes`，中文显示为「思源笔记」，包名仍为 `@yoursc/dsh-siyuan`。
- **「测试连接」改名「测试地址」，并且只测地址**：不带 token 去问思源一个公开接口，
  结论分三态——`地址可用（附版本）`、**`地址可达但思源要求 API token`（琥珀色，不是地址错）**、
  `地址不通（附具体原因）`。
- **API token 卡新增「测试 token」**：先试你刚填进来、还没保存的值（没填就用已保存的），
  结论分四种：有效、思源拒绝了这个 token、连不上思源（说的是"token 未被验证"，
  不是"token 不对"）、其它错误。**测不通过、甚至根本没测，都照常保存**——你可能只是
  思源没启动，token 不该被写死在这一步。token 来自只读来源（环境变量）时该按钮仍然可用。
- 宿主侧 `siyuanFetch` 拆出 `sendSiyuanRequest`（发请求 + 解码 + 解析），错误对象新增
  `kind`（`transport` / `envelope` / `siyuan`），设置页据此区分"连不上"与"被拒绝"；
  工具调用侧行为不变。

### 测试

- `test/harness.mjs`：地址判定三态（含"思源回鉴权错误 → auth""返回 HTML → fail"两个替身
  给不出的分支，用临时 HTTP 服务补齐）、地址探测**不带** Authorization 头（替身新增
  `hasAuthHeader` 记录）、`testToken` 五种 `kind`、以及"测试失败不阻断保存"。
- `test/client-interactive.mjs`：地址三态文案**与颜色**（`auth` 必须是琥珀，染红一样误导人）、
  旧宿主无 `verdict` 时的降级、token 测试四态、测试后仍能保存、只读来源下测试仍可用。
- `test/client-render.mjs`：只读来源时「测试 token」仍可用。

> 本次改动涉及 `lib/index.js`：**升级后必须重启 dsh web**（`testToken` 路由与三态判定都在宿主侧）。

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
