# AGENTS.md — dsh-siyuan

给在这个仓库里工作的 AI 编码代理。

角色分工：`README.md` 是**用户可见的功能契约**，`docs/DEV.md` 是**架构、重启与发布说明**，
本文件只写**做事的方式与红线**——凡是能由测试或 README 守住的东西，不要搬到这里来。

## 项目

dsh 插件，两个半场：`lib/index.js`（宿主：`siyuan_*` 工具 + `/siyuan/api/*` 设置页路由）、
`lib/client.js`（浏览器 bundle：设置页）。纯 JavaScript ESM，Node >= 20，
**无构建、无 TypeScript、无 linter、零运行时依赖**。文档与注释用中文。

## 命令

```bash
npm install     # 只装 devDependency：@deepseek-ai/dsh-tools（官方 schema 校验器）
npm test        # 7 个套件，自包含；改完必跑
node test/harness.mjs --live   # 可选：改成探测真实实例 127.0.0.1:6806
```

单跑一套：`node test/{harness,tools-e2e,decode-body,client-harness,client-navicon,client-render,client-interactive}.mjs`

## 文件地图

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主半场 |
| `lib/client.js` | 客户端 bundle（手写 `React.createElement`，无构建步骤） |
| `cordis.patch.yml` | 发布用 `dsh.bundle.patch` 层 |
| `test/mock-siyuan.mjs` | 思源 API 本地替身 |
| `test/decode-body.mjs` | 响应解码矩阵（替换 `globalThis.fetch`，覆盖 `content-encoding` 丢失） |
| `CHANGELOG.md` | 用户可见的版本改动 |
| `docs/DEV.md` | 架构、重启矩阵、发布流程、历史事件记录 |
| `docs/siyuan-api-cheatsheet.md` | 思源接口实测契约，**改接口调用前必读** |
| `docs/code-review-2026-09-12.md` | 历史评审，含「避免误改」清单 |
| `docs/ui-design.md` | **界面设计契约**：token 纪律、颜色语义、焦点与间距规范、三层验证方法 |
| `docs/ui-review-2026-10-04.md` | 界面评审记录（U1–U9），含宿主设计 token 实测值与对照 |
| `tools/ui-contrast.mjs` | 对比度审计（**opt-in，不在 `npm test`**）：反解宿主主题 token 算 WCAG |
| `docs/handover.md` | 本机现场备忘，已 gitignore，**永不提交** |

## 约束（没有测试守着、错了会静默失效的那些）

1. **重启矩阵**：`lib/client.js` 免重启（HMR 按 mtime 轮询）；`lib/index.js` **必须重启 dsh web**
   （宿主插件按 URL 缓存，Node ESM 不允许二次 import）；`cordis.patch.yml` / profile 组合树必须重启。
2. **客户端 bundle 只能 `require("react")`** —— client-modules 只提供 react，别的 specifier 会变成运行时请求。
3. **不要引入构建步骤、运行时依赖或 TypeScript**：`lib/` 就是发布产物，手写即最终形态。
4. **改包名要同步三处**：`package.json` 的 `name`、`cordis.patch.yml` 里 insert 的 `name`、
   `lib/client.js` 中 `__ModuleLoader__.load({ id })` 的 id。少一处 Web 整页起不来。
5. **文档与 `dshhub` 元数据里写死了工具总数**：增删工具时同步 README 工具表、`package.json` 的
   `dshhub.summary`（上游 awesome-dsh-plugin 的条目已收录，改数量后需要另开 PR 更新那里的
   `data/plugins/yoursc__dsh-siyuan.yml`）。真实数量从 `lib/index.js` 的 `buildTools` 数，
   别相信文档里的数字（设置页的计数是动态算的，不用改）。
6. **dsh 兼容范围必须按 rc 线逐条枚举**（`dsh.engines.dsh` 与 `dshhub.compatibility.dsh` 两处）：
   semver 只放行「与比较器同元组」的预发布，`>=0.1.5-rc.1` 也救不了 0.1.6/0.1.7，
   每跟进一条新 rc 线都要手工加一段。复核命令见 `docs/DEV.md`。

## 测试约定

- **三不**：不联网、不碰真实思源实例、不读环境变量（harness 显式 `delete process.env.SIYUAN_TOKEN`）。
- **夹具必须由宿主真实产出生成**（`internals.buildStatePayload`），不要手抄字段形状——手抄的夹具会在字段改名时两边一起错、测试仍然绿。
- **替身刻意复刻真实思源的怪癖，改测试时不要「修」掉它们**：文档块走 `deleteBlock` 静默 no-op、删除异步落库、`createDocWithMd` 非幂等、`updateBlock` 只保留第一段、SQL 只认已知语句形状。
- **加断言时先把修复摘掉，确认它会变红**。本仓库出现过「新旧实现都能通过」的恒真断言，是靠这一步发现的。
- **界面守门分两层，别把后者塞进 `npm test`**：样式纪律（有无裸色值、焦点色）由
  `test/client-navicon.mjs` 断言，自包含、进 `npm test`；对比度数值要读宿主的主题文件，
  只能 opt-in 跑 `node tools/ui-contrast.mjs`。两层互补：只做前者会漏掉「token 用对了但对比度不达标」。
- 断言条数与工具数量都会漂移：引用前先跑一遍，不要在文档里写死。

## 改动前先读

- 改工具或设置页行为 → `README.md` 的工具分组表与「已知限制」（用户可见契约）；
  思源接口的形状与怪癖 → `docs/siyuan-api-cheatsheet.md`
- 改架构、重装、发布 → `docs/DEV.md`
- **改设置页界面 / CSS / 颜色 → `docs/ui-design.md`**（token 纪律与三层验证方法）；
  已有的界面结论 → `docs/ui-review-2026-10-04.md`
- 想重构 → `docs/code-review-2026-09-12.md` 的「没问题的部分（避免误改）」

## 红线

- 不要 kill 或自行重启 dsh 进程（容器里没有 docker socket，入口脚本没有重启循环），重启交给用户或 1Panel。
- 不要提交 `docs/handover.md`（含本机地址、token 来源、安装状态）。
- 不要手工编辑 awesome-dsh-plugin 仓库的 README（由 `data/plugins/*.yml` 生成）。
- 一次工具调用只处理一个文档/块是**有意的设计**，不要「顺手」做成批量。

## 提交信息

- commit message 用中文 + 约定式前缀（`feat:` / `fix:` / `test:` / `docs:` / `chore(release):`），风格参考 `git log`。
- git 操作规范不在这里重复，见全局 AGENTS.md。

## 环境

- 写 `/workspace` 与 `~/.dsh` 都在 dsh 会话工作区之外，会触发沙箱授权，需要放行。
- 浏览器渲染只能在 dsh web 挂载后真正验证；Node 侧跑的是 React 替身。**不要为补上浏览器控制而自建截图脚本 / 渲染器**——DSH 插件开发契约明确禁止，理由与三条合规路径见 `docs/ui-design.md` 第八节。
