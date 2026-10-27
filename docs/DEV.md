# dsh-siyuan 开发与维护

面向改这个插件的人。**用户请读 [README](../README.md)**；思源接口契约见
[siyuan-api-cheatsheet](./siyuan-api-cheatsheet.md)；历史评审与已修问题见
[code-review-2026-09-12](./code-review-2026-09-12.md)。

## 架构

两个半场，都是**零运行时依赖**：

| 文件 | 角色 |
|---|---|
| `lib/index.js` | 宿主半场（ESM，只用 node 内建模块）：配置持久化、凭据读取、`/siyuan/api/*` 设置页路由、17 个 `siyuan_*` 工具的注册与执行 |
| `lib/client.js` | 浏览器 bundle：在 `settings.section` 槽位注册「思源笔记」设置页 |

要点：

- **配置**：`$DSH_HOME/storages/siyuan/config.json`（地址 / 默认笔记本 / 逐工具开关）。写入是
  「临时文件 + `fsync` + `rename`」；读取时文件损坏会**回退默认值并记警告**（同一份坏文件只警告一次）。
  `baseUrl` 必须是合法 http(s) 地址：设置页保存时直接拒绝非法值，配置文件里读到非法值（手改/旧版写入）
  也回退默认并告警。
- **工具开关的形状与迁移**：`tools` 是**逐工具**的布尔映射（`{ "siyuan_search": false }`）。
  解析只有一处 —— `isToolEnabled(config, name, group)`，三级顺序：
  逐工具键 → 旧版组名键（`{ "read": true }`，迁移期继续兜底）→ `TOOL_GROUP_DEFAULTS[group]`（新装/新工具）。
  因此**旧配置文件不用改写**，行为逐组不变；设置页按工具保存一次（提交 17 个键的完整映射）时，
  `updateConfig` 会把未提到工具的当前结论固化成显式记录、再整层替换，旧组名键就此退场。
  默认值只能在这里兜底：`normalizeConfig` 是纯函数、不看工具清单，补默认值会补错组。
- **设置页的交互契约**：四张卡（连接 / API token / 默认笔记本 / 工具开关）**各自保存**，
  每张卡只提交自己的字段（`updateConfig` 本来就接受部分字段），各自持有 pending 与消息，
  互不锁定；脏值 = 草稿 vs 宿主快照的现算。`testConnection` / `listNotebooks` / `testToken` 接受
  `body.baseUrl` / `body.token`，**优先用页面正在编辑的草稿**（否则"改了地址没保存就点测试"
  测的是旧地址）；非法草稿地址与保存共用 `normalizeBaseUrlInput` 一套判据。打开页面时还会在
  `state.reachable === true` 下**静默**拉一次笔记本列表（失败不写消息，用户没点那个按钮）；
  列表没回来时下拉显示已保存 id 并标注"已保存"，**不能**提前断言"不在当前列表中"。
- **两个测试按钮各管一件事，判定不许掺对方**（见事件记录里那条"误报地址错"）：
  - `testConnection` = **只测地址**：不发 Authorization 头（body 里的 `token` 一律忽略），
    打公开接口 `/api/system/version`，出**三态** `verdict`：`ok`（拿到 code 0，顺带版本号）/
    `auth`（拿到思源信封但 code≠0 —— 地址是活的，只是要 token）/ `fail`（连不上、非 JSON、
    不是思源）。`ok` 字段保留给还没重启 dsh web 的旧客户端（= verdict 为 ok）。
  - `testToken` = 只测鉴权：草稿 token 优先，打 `lsNotebooks`（**不用 SQL**：发布模式下 SQL
    被禁，会把"开了发布模式"误报成"token 不对"），出 `kind`：`ok`/`auth`（被拒）/
    `unreachable`（连不上，**说"未被验证"而不是"token 不对"**）/`error`/`empty`。
  - `testToken` **纯只读**（不写配置、不写凭据），且**不作为保存的门禁**：测不过照样能存。
    设置页上唯一与 `writable` 无关的按钮就是「测试 token」——env 来的 token 恰恰最需要反馈。
- **凭据**：token 存宿主凭据库的 `SIYUAN_TOKEN`，页面只报告状态（徽标文案如
  `token 已配置 · 来自环境变量 · 页面不可改`），永不回显值。徽标住在 **API token 卡**，
  不要跟"可达"挤在连接卡标题行——那样会被读成"这个连接只读"。
  没有凭据服务时回退到进程环境变量（因此真实部署常见 `source: "env"`、页面输入框置灰）。
  草稿 token 只在探测请求里出现（宿主的 `tokenState.source` 会回 `"draft"`），不会被落盘。
- **工具动态注册**：`syncTools()` 按**逐个工具**的开关注册/释放；分组挂在工具定义上
  （`definition.group`），设置页据此排列与算「已启用 N / 共 M」。
- **取消**：工具调用的 `AbortSignal` 经 `createApi(ctx, signal)` 贯通到 HTTP 请求（`AbortSignal.any`
  组合超时）与删除复核的可中断 sleep；取消抛 `name === 'AbortError'`，dsh-tools 据此标成 `ABORTED`。
- **客户端 bundle 不走构建**：手写 `React.createElement`，只 `require("react")`。**不要给它加别的
  模块引用**——client-modules 只提供 `react`，其它 specifier 会变成运行时请求。
- **样式标签必须挂在模块 id 上**：`data-plugin` = **包名**（与 `__ModuleLoader__.load({id})` 一致），
  `data-plugin-css` = `<包名>/client.css`（同页去重键）。`client-hmr` 重载时按
  `style[data-plugin=<模块 id>]` 删旧样式再重放；写成裸名（`dsh-siyuan`）会让这条清理永远命中不了，
  结果是 **JS 热更新了、CSS 一直是旧的**（表现为"新结构配旧样式"，只能整页刷新）。
  `test/client-navicon.mjs` 在假 document 上断言了这两个属性，改坏会变红。
- **设置面板的导航图标是兜底来的**：DSH 外壳把导航图标硬编码在 `navIcon(id)` 里——只有
  `models` / `agent-presets` / `plugins` 有专属图形，其余分区（含本插件的 `siyuan`）一律回退齿轮，
  而 `settings.section` 槽位没有 icon 选项（上游 Discussion #4502 尚无官方回应）。所以
  `lib/client.js` 在面板挂载后，把「思源笔记」那一行的齿轮换成思源官方 logo 的单色版
  （`patchNavCell` / `watchNavIcon`，用 `MutationObserver` + rAF 合并扫描，按**行文案**认行）。
  这段依赖外壳 DOM：上游给了图标 API（或改了导航结构）就该删掉，失效时只是退回齿轮，不影响
  设置页功能。真机效果刷新页面即可看（客户端 bundle 免重启）；Node 侧只有
  `test/client-navicon.mjs` 的 DOM 替身守着，**别把它当成真机验证**。

## 目录

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主半场 |
| `lib/client.js` | 客户端 bundle（`window.__ModuleLoader__.load`，无构建步骤） |
| `cordis.patch.yml` | 发布用 `dsh.bundle.patch` 层（`dsh plugin add` 通道） |
| `test/harness.mjs` | 假 ctx 调 `apply()`：工具 schema、逐工具开关的动态注册/释放、旧配置迁移、设置页路由（围栏、请求体、草稿探测、地址三态、token 测试只读且不阻断保存、凭据路径）、卸载路径 |
| `test/mock-siyuan.mjs` | 思源 API 本地替身（鉴权——`/api/system/version` 与 `bootProgress` 免鉴权、`code` 信封、非幂等 create、异步落库、延时响应；逐请求记 `hasAuthHeader`） |
| `test/tools-e2e.mjs` | 对着替身跑通全部 17 个工具与错误面（含取消、删除复核窗口、笔记本校验） |
| `test/client-harness.mjs` | 客户端 bundle 加载与 `settings.section` 槽位契约 |
| `test/client-navicon.mjs` | 导航图标兜底：DOM 替身驱动「面板挂载 → 换掉齿轮」，含幂等/不误伤/卸载 |
| `test/client-render.mjs` | 设置页「已加载」分支的结构断言（四张卡、17 个工具行、开关与宿主 enabled 一致、干净态按钮禁用） |
| `test/client-harness-lib.mjs` | 客户端测试共享支持：bundle 加载 + 宿主夹具（`buildHostState`）+ 可执行 React 替身 + 元素查找 |
| `test/client-interactive.mjs` | 设置页交互层：fetch 替身驱动加载/错误、四张卡各自保存（请求体只带本卡字段）、草稿探测、逐工具与整组开关 |
| `package.json` | `dsh.bundle.patch`（安装通道）、`dshhub`（目录元数据）、`files`（发布清单） |
| `tools/ui-contrast.mjs` | 对比度审计（**opt-in，不进 `npm test`**）：反解宿主主题 token 算 WCAG，见「界面怎么验」 |
| `docs/ui-design.md` | 界面设计契约：token 纪律、颜色语义、焦点与间距规范、三层验证方法 |
| `docs/ui-review-2026-10-04.md` | 界面评审记录（U1–U9），含宿主设计 token 实测值 |
| `tmp/siyuan-src/` | **思源笔记稀疏源码检出（gitignore，不提交）**——查接口契约与内置 agent 实现时对着看，来源与重建方法见下节 |
| `docs/research/` | 思源内置 agent 提示词的调研产物：报告、system prompt 逐字原文、两个体量计量脚本 |

## 思源参考源码（`tmp/siyuan-src/`）

改本插件时有两类问题「文档说不清，只能对着上游源码看」：
思源某个接口的**真实怪癖**（异步落库、静默 no-op、只保留第一段），
以及思源**内置 AI agent 是怎么把提示词和工具喂给模型的**。
为此在 `tmp/` 下放一份思源笔记的**稀疏源码检出**。

| | |
|---|---|
| 来源 | <https://github.com/siyuan-note/siyuan>（AGPL-3.0，b3log.org） |
| 版本 | commit `1588124`（2026-09-29），`app/package.json` 记为 **3.8.6** |
| 方式 | `git clone --filter=tree:0 --depth=1 --no-checkout` + `sparse-checkout`（**treeless**，不下载用不到的 blob） |
| 落地 | 工作树约 33 MB + `.git` 约 37 MB ≈ 70 MB |
| 是否提交 | **否**。`.gitignore` 第 3 行 `tmp/`；`git status` 看不见它，也不进 `npm pack`（`files` 是白名单） |

**这不是依赖**：`npm test` 不需要它，删掉 `tmp/` 本插件照常工作。它只是**查资料用的参考副本**。

### 重新获取

```bash
cd <本仓库>
git clone --filter=tree:0 --depth=1 --no-checkout https://github.com/siyuan-note/siyuan.git tmp/siyuan-src
cd tmp/siyuan-src
git sparse-checkout init --cone
git sparse-checkout set app/guide app/src/ai app/src/config/tabs/ai app/src/layout/dock/agent \
                         docs kernel/agent kernel/api kernel/apicontract kernel/conf kernel/mcp kernel/util
git checkout HEAD
```

**想跟上游保持同步**（版本会往前走，本仓库记的 commit 只是拉取当天的快照）：

```bash
cd tmp/siyuan-src && git fetch --depth=1 origin master && git reset --hard FETCH_HEAD
```

sparse 目录不用重列，`git reset --hard` 之后仍是同一批路径。

### 检出了什么

| 路径 | 里面有什么 |
|---|---|
| `kernel/mcp/tools/` | **34 个内置 agent 工具的定义**（`&Tool{Name, Description, InputSchema, ActionEffects}`）——`Description` 就是喂给 LLM 的提示词 |
| `kernel/agent/` | **system prompt 常量**在 `agent.go:47`（`const systemPrompt`）；拼装顺序看 `agent.go:2032` 的 `buildSystemPrompt`；技能/AGENTS.md 注入、能力裁剪 `capability.go:140`、压缩摘要 `compaction.go` |
| `kernel/util/` | `skill.go`（`SKILL.md` 发现与安装）、`agent_instructions.go`（`data/ai/AGENTS.md` 读取与乐观锁） |
| `kernel/api/` | agent 的 HTTP 接口（`/api/ai/agent/*`） |
| `app/src/layout/dock/agent/` | 前端：4 个浏览器能力 `frontendCapabilities.ts`、会话 UI |
| `app/src/ai/skills/`、`app/src/config/tabs/ai/` | 技能管理页与「设置 - 人工智能」页 |
| `app/guide/` | 4 份随包发布的《AI 智能体》用户指南（`.sy` JSON，简体中文那条是 `20260804171000-aiagt01`） |
| `docs/` | 上游开发文档，含 `SKILL-MANAGER.zh-CN.md` |

**`app/guide/` 占了工作树的 18 MB，却和 agent 实现无关**，纯粹是内置指南数据。
嫌大可以去掉这一行 `git sparse-checkout set`，省 18 MB；去掉后
`siyuan-builtin-agent-prompt.md` 第 6 节引用到的指南结论不受影响（那些是读出来的，不是脚本读的）。

### 调研产物

`docs/research/` 下是对这份源码的静态分析，**随仓库提交**（很小，且是结论的出处）：

| 文件 | 作用 |
|---|---|
| `siyuan-builtin-agent-prompt.md` | 调研报告：完整 system prompt 拼装结构、工具面、能力 ID 方案、权限模型、体量对比 |
| `siyuan-agent-systemprompt.verbatim.txt` | `agent.go:47` 的**逐字原文**（13 444 字符），用 `sed -n '47,142p' kernel/agent/agent.go` 提取 |
| `count-siyuan-descriptions.py` | 解析 Go 字面量，统计 34 个工具的 description 字符数（对应报告第 6 节） |
| `count-plugin-descriptions.mjs` | 仿 `test/tools-e2e.mjs` 的 mock ctx 真注册一遍，统计本插件 17 个工具的 description 字符数 |

```bash
python3 docs/research/count-siyuan-descriptions.py    # 需要 tmp/siyuan-src；可用 SIYUAN_SRC=<路径> 覆盖
node docs/research/count-plugin-descriptions.mjs       # 在仓库根跑
```

两个脚本**只统计不校验**，是调研工具而不是测试——数字会随工具增删漂移，
引用前重跑，别把当前数字当契约（同「测试」节那条：条数会漂移，别写死）。

## 本地开发安装

```bash
dsh plugin --profile web add /path/to/this/repo
```

`dsh plugin add` 转发给 profile 里的 pnpm 装上包，并读包里的 `dsh.bundle` 声明，
**自动把包名写进 `dsh.profile.bundles`** —— 不需要手工编辑 profile 的任何文件。
`link:` 安装，改完 `lib/` 重启 dsh web 即生效。

<details>
<summary>备选：手工软链挂载</summary>

```bash
ln -s /path/to/this/repo ~/.dsh/profiles/web/node_modules/@yoursc/dsh-siyuan
```

再在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: siyuan
      name: '@yoursc/dsh-siyuan'
```

手工挂载与 CLI 通道**只能二选一**：同时存在会让同一个插件挂两次、路由重复注册，profile 起不来。
</details>

## 开发循环：哪些改动需要重启

| 改动 | 生效方式 |
|---|---|
| `lib/client.js` | **不用重启**。`dsh-client-hmr` 每 500ms 轮询 bundle 的 mtime/size，变了就重算 rev 并经 SSE 推给浏览器，刷新页面即新版 |
| `lib/index.js` | **必须重启** dsh web。宿主插件由 loader 按 URL 缓存，Node ESM 不允许二次 import 同一 URL；`patchReload: live` 只监视补丁文件、不监视插件源码 |
| `cordis.patch.yml` / profile 组合树 | 必须重启（本机 `patchReload: live` 实测不工作：原地写、`touch`、unlink+add 原子替换都试过） |

重启：

```bash
docker restart deepseek-harness     # 或在 1Panel 里重启对应容器
```

想在不停主实例的情况下迭代，可以用隔离实例（真实 profile、状态写 `/tmp`、另开端口）：

```bash
DSH_HOME=/tmp/sy-probe node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3099 --no-open
```

## 测试

```bash
npm install                    # 只有 devDependency：@deepseek-ai/dsh-tools（官方 schema 校验器）
npm test                       # 7 个套件全绿；自包含，不需要真实思源
                               # 断言条数会随开发变化，别在文档里写死（要数字就跑一遍数 "  ok "）
node test/harness.mjs --live   # 可选：把干跑测试改成探测真实实例 127.0.0.1:6806
```

设计约定：

- **默认不碰真实实例、不联网、不读环境变量**。harness 显式 `delete process.env.SIYUAN_TOKEN`，
  否则本机 shell 里的真实 token 会让「未配置」断言失败。
- **夹具必须从宿主真实产出生成**（`internals.buildStatePayload`；客户端套件统一走
  `client-harness-lib.mjs` 的 `buildHostState()`），不要手抄字段形状——
  手抄的夹具会在字段改名时两边一起错、测试仍然绿。
- **客户端用例的状态由真实 hook 运行时驱动**（`createHooks()` + fetch 替身），**不要按 hook
  位置注入状态**：旧写法（七元数组按顺序注入 `useState`）在 hook 增删时会静默错位、测试照样绿。
  渲染断言只读元素树，交互断言直接调 `props.onClick/onChange`。
- **替身刻意复刻真实行为，改测试时别把它们"修"掉**：文档块走 `deleteBlock` 静默 no-op、
  删除异步落库（`deleteDelayMs`）、`createDocWithMd` 非幂等、`updateBlock` 只保留第一段、
  延时响应（`responseDelayMs`）、SQL 只认已知语句形状（不认识的形状报错而不是返回空数组）。
- **临时 home 用 `mkdtempSync`**，失败时保留目录便于取证；替身的定时器在 `close()` 里清理。
- **响应解码用例替换 `globalThis.fetch`**（`test/decode-body.mjs`）：用预制 `Response` 喂真实的
  `siyuanFetch`，覆盖「压缩体 × `content-encoding` 有/无」的组合与魔数优先分支。不联网，
  也不需要替身服务；断言的是解码后的 `data`、请求头与报错文案，不是内部函数返回值。

补一条断言时的自检：**先把修复摘掉，确认它会失败**。本仓库里 H1（日期翻滚）、H2（损坏配置）、
H5（删除复核窗口）、H6（多段丢弃）、B1（请求中取消）、B3（工具计数）、D1（响应解码，摘掉补丁
12 项变红）都是这么验证过的；
其中 B1 的第一版断言其实测不出修复（新旧实现都会抛 `AbortError`），是靠"摘掉修复看是否变红"
才发现并补强的。

### 界面（设置页）怎么验

界面分三层验，能力严格递减——**前两层可自动化，第三层不行**：

| 层 | 覆盖 | 手段 | 进 `npm test`？ |
|---|---|---|---|
| 1. 颜色对比度 | token 实际色值、WCAG 对比度 | `node tools/ui-contrast.mjs` | ❌ opt-in |
| 2. 结构 + 样式纪律 | DOM 结构、aria、文案、**有无裸色值**、焦点色 | `client-render.mjs` / `client-interactive.mjs` / `client-navicon.mjs` | ✅ |
| 3. 真实渲染 | **布局、间距、对齐、溢出、hover** | 真人在 dsh web 页面上看 | ❌ 不可能 |

第 1 层**不能**塞进 `npm test`：它要读宿主 dsh 安装目录里的 `@deepseek-ai/dsh-client-ui-theme`
才能拿到设计 token 的真实色值，违反「三不」里的自包含。它是开发者审计工具；退出码在
**插件缺陷**项失败时为 1（宿主参照行只报数不计失败）。逐项含义见 `docs/ui-design.md` 第七节，
实测结论见 `docs/ui-review-2026-10-04.md`。

第 3 层**不要试图自动化**，也不要自建渲染器去补上缺失的浏览器控制。DSH 的
`cordis-plugin-development` 契约明确禁止（*"emulate React/DOM, or implement a custom
renderer to compensate for missing browser control. A screenshot of a mock page is not
verification of the running plugin."*）；而且设置页只在 dsh web 壳内成立（需要
`window.__DSH_BOOT__`、client-modules 的 react、宿主 `/siyuan/api/*` 路由与鉴权），
抽掉壳渲染出来的图是 mock——正是本仓库最警惕的「假绿」。三条合规路径
（含"怎么让 agent 自己拿到真实浏览器控制权"）见 `docs/ui-design.md` 第八节。

## 发布

```bash
npm version <patch|minor|0.0.x>   # 见下「版本策略」
npm publish                       # publishConfig 已带 registry 与 access:public，无需再加参数
```

`npm pack --dry-run` 的清单应只含 `lib/` + `cordis.patch.yml` + `CHANGELOG.md`
（README/LICENSE/package.json 由 npm 自带）。`files` 不含 `test/`：发布包里没有测试，属正常取舍。

**`lib/` 里不要留 `*.bak-*` 备份**：`files` 是白名单，白名单目录内的文件**不能**用 `.npmignore`
排除，备份会被原样打进包里（实测清单里多出一个 68 kB 的 `lib/index.js.bak-*`）。备份放到
`lib/` 之外，或直接删掉（打补丁前的版本在 git HEAD 里，`git show HEAD:lib/index.js` 可取回）。

**发布前必查**（本机全局 registry 是 npmmirror 镜像源，不能发布，靠 `publishConfig` 兜住）：

```bash
npm test                       # 7 套件全绿
npm pack --dry-run             # 7 个文件：lib/×2 + cordis.patch.yml + CHANGELOG.md + npm 自带的 README/LICENSE/package.json
npm view @yoursc/dsh-siyuan@<新版本> --registry https://registry.npmjs.org/   # 预期 404（该版本未占用）
```

**版本策略**：首个公开版是 `0.0.1`（发 `latest`）。版本号语义要跟着**实际验证过的 dsh 版本**走，
而不是跟着本体版本号：本插件的 `dsh.engines.dsh` 与 `dshhub.compatibility.dsh` 两处声明同一个
范围，0.0.3 起为 `>=0.1.5-rc.1 || >=0.1.6-0 || >=0.1.7-0`，理由见下条。

**兼容范围为什么必须按 rc 线逐条枚举**：semver 只在「比较器里的预发布元组与候选版本的元组
相同」时才对预发布放行。因此 `^0.1.5-rc.1` 会把 `0.1.6-*` / `0.1.7-*` 判为不兼容；换成
`>=0.1.5-rc.1` **也救不了**——下界元组是 0.1.5，实测两者对 dsh 已发布的版本判定完全相同，
加 `<0.2.0` 上界同样不改变该规则。想让某条 rc 线通过，范围里就必须出现**它自己的元组**，
所以按已知 rc 线逐条 `||` 枚举。dsh 至今**只发布过预发布版本**，每跟进一条新 rc 线都要手工
加一段。改完用 npm 自带 semver 复核（先 `npm view @deepseek-ai/dsh versions` 看有哪些版本）：

```bash
node -e "const s=require('/usr/local/lib/node_modules/npm/node_modules/semver');const r='>=0.1.5-rc.1 || >=0.1.6-0 || >=0.1.7-0';for(const v of ['0.1.5-rc.1','0.1.5-rc.3','0.1.6-alpha.1','0.1.7-alpha.1','0.1.7','0.2.0-alpha.1'])console.log(v,s.satisfies(v,r))"
```

`dsh` 主包内**没有** `engines` / `dshhub` 的消费点（全量 grep 无命中），所以这两个字段不参与
CLI 安装校验，只在 dshhub 目录侧影响兼容性展示与过滤。

**发布凭据**：账号 `yoursc` 开了 2FA（`auth-and-writes`），`npm publish` 会交互式索要 OTP，
必须在真实 TTY 里跑；若报 403，改用 npmjs.com 生成的 Automation token。

**改名必须同时改三处**，少一处会让 Web 整页起不来（实测踩过）：`package.json` 的 `name`、
`cordis.patch.yml` 里 insert 的 `name`、以及 `lib/client.js` 里 `__ModuleLoader__.load({ id })` 的
`id`——client-modules 要求 bundle 用**包名**注册，否则报
`bundle … loaded without registering "<包名>" via __ModuleLoader__.load`。
`test/client-harness.mjs` 现在用 `package.json` 断言这个 id，改名后 `npm test` 就能发现。

包名已定为 `@yoursc/dsh-siyuan`（npm 上的裸名 `dsh-siyuan` 已被 `coolgech` 占用）。
GitHub 地址按 `github.com/yoursc/dsh-siyuan` 填写，与账号不一致时改 `package.json` 里的
`repository` / `homepage` / `bugs` 三处即可。

## 事件记录（都是真机测试抓出来的）

| 现象 | 根因 | 处理 |
|---|---|---|
| Web 整页起不来：`bundle … loaded without registering "@yoursc/dsh-siyuan" via __ModuleLoader__.load` | 改名时漏了第三处——`lib/client.js` 里 `__ModuleLoader__.load({id})` 的 id 仍是旧裸名 | id 改为包名；`test/client-harness.mjs` 改成用 `package.json.name` 断言 |
| `siyuan_delete_block` 传文档 id 报成功但什么都没删 | 思源 `/api/block/deleteBlock` 对文档块静默 no-op | 新增 `siyuan_remove_doc`（走 `/api/filetree/removeDocByID`）；`delete_block` 先查块类型，遇文档块直接拒绝 |
| `siyuan_remove_doc` 报「删除未生效」，但文档其实已删 | 思源删除是**异步落库**，返回成功那一刻 `blocks` 行还在 | 删除后用 `waitUntilBlockGone` 复核；替身用 `deleteDelayMs` 复现 |
| 发布前审计发现 `dsh.engines.dsh: ">=0.1.2-rc.1"` 把 dsh 的 `latest`（`0.1.5-rc.1`）判为不兼容 | semver 仅对「与比较器同元组」的预发布放行；dsh 只发过预发布版 | 两处都改成 `^0.1.5-rc.1`，并在本文件记下「跟进新 rc 线要手工更新」 |
| DSH 0.1.7-alpha.1 上插件 `reachable: false`、17 个工具全不可用，报「返回了非 JSON 响应（HTTP 200）」 | 该版内置 undici 8.10.2 → 8.11.0：经全局代理 dispatcher（`EnvHttpProxyAgent`）的响应不再自动解压，且 `content-encoding` 变成 `null`（body 仍是 gzip）。两版 `dsh-http-proxy/lib/index.js` 逐字节相同（sha256 前 16 `5310861bc89788ea`），裸 fetch 不走 dispatcher 时正常 | `siyuanFetch` 改自适应解码（魔数优先、头只兜 br、解压失败退回原文）+ 请求显式带 `Accept-Encoding: gzip`；JSON 报错带 `content-encoding` 与前 8 字节 hex；新增 `test/decode-body.mjs`（摘掉补丁 12 项变红）。同源问题也出现在 `dsh-cost-meter`（OpenRouter 价格刷新），不属本项目 |
| `^0.1.5-rc.1` 在 dshhub 目录侧把 `0.1.6-*` / `0.1.7-*` 判为不兼容；换成 `>=0.1.5-rc.1` 实测**判定完全相同**、照样不兼容 | semver 只对「与比较器同元组」的预发布放行，下界元组是 0.1.5，救不了 0.1.6/0.1.7；加 `<0.2.0` 上界也不改变该规则 | 0.0.3 起两处都改成按 rc 线枚举 `>=0.1.5-rc.1 \|\| >=0.1.6-0 \|\| >=0.1.7-0`（`dsh` 主包不消费这两个字段，只影响目录侧展示与过滤） |
| 日记路径渲染成 `2126-09-12` | Go layout 顺序替换时 `02` 命中了已替换出的 `2026` | 改成单趟正则替换（`goLayout`） |
| 设置页保存的改动没生效（如 `danger` 开关） | 页面上的改动必须先点**那张卡自己的**保存按钮才落盘 | 无需改码，操作上注意 |
| 没配 token 时点地址下面的「测试连接」报红，用户以为地址填错了 | 它其实是"三条探测全过才算成功"：没 token 时两条鉴权探测必然失败，红字落在**地址**卡里。可下方探明细里版本号明明读得到——地址是通的 | 拆成两个按钮：「测试地址」不带 token，只对地址下结论（`ok`/`auth`/`fail` 三态，`auth` 用琥珀色而不是红色）；「测试 token」测鉴权且**测不过也允许保存**。`siyuanFetch` 拆出 `sendSiyuanRequest`，让地址探测能自己分辨"连不上"与"被拒绝"（`SiYuanError.kind`） |
| 取消工具调用后删除仍跑完整个复核 | 信号只在入口检查一次，`sleep` 不可中断 | 信号贯通到请求与退避等待；抛官方 `AbortError` |
| 往不存在的笔记本写文档"成功" | `assertNotebook` 只看"有没有填"，替身也不校验 notebook | 写入前查 `lsNotebooks` 确认存在且未关闭；替身同步收紧 |

## 环境注意

- 写 `/workspace` 与 `~/.dsh` 都在 dsh 会话的工作区之外，会触发沙箱授权，需要放行。
- 容器里没有 docker socket，看不到 compose 的 restart policy；**不要**自行 kill dsh 进程
  （入口脚本 `exec dsh web`，没有重启循环），重启交给用户或 1Panel。
- 本机现场备忘（思源实例、token 来源、安装状态）在 `docs/handover.md`，已 gitignore，**永不提交**。
