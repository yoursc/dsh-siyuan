# Code review（2026-09-12）

范围：`lib/index.js`（宿主，964 行）、`lib/client.js`（客户端，327 行）、`test/`（4 个套件 + 替身）、`package.json`、`cordis.patch.yml`。
方式：逐行通读全部源码；测试套件由子代理独立审查后我复核了其关键结论（含实际复现），并逐条核实本文件的每个论断。

结论速览：**架构和真实行为记录（README 那套"坑"）是这个项目最大的资产，质量很高；但代码里有 1 个会造成写错数据的真 bug，测试门禁有 5 条会掩盖缺陷的假绿，其中 1 条可复现让整套 `npm test` 变红。** 建议在发布前处理 H1–H4 与 T1–T5。

## 状态（2026-09-12 更新）

| 条目 | 状态 | 说明 |
|---|---|---|
| H1 日期静默回落/翻滚 | ✅ 已修复 | `parseDateArg` 现在只对空值回退今天，非法/翻滚输入抛错；新增 13 条回归断言，已验证摘掉修复后必失败（`test/tools-e2e.mjs`） |
| H4 `/tmp` 诊断残留 | ✅ 已修复 | 删除 `diagnostic()` 与三处调用，`apply()` 直接冒泡异常 |
| T1 `npm test` 非自包含 | ✅ 已修复 | harness 默认改走 `mock-siyuan.mjs` 并 `delete process.env.SIYUAN_TOKEN`；真实实例探测移到 `--live` 门后；已验证「导出 SIYUAN_TOKEN」与「无真实思源」两种环境下全绿，`--live` 仍能跑真实实例 |
| T2 `harness.mjs:176` 恒真断言 | ✅ 已修复 | 恒真条件改成有意义的断言：预置 config.json 被读入（baseUrl 来自文件而非默认值） |
| T3 schema 校验静默跳过 | ✅ 已修复 | 解析不到 `@deepseek-ai/dsh-tools` 改为判失败并提示 `npm install`；验证方式：临时改成不存在的包名 → `1 项失败` |
| T4 客户端交互层零覆盖 | ✅ 已修复 | 新增 `test/client-interactive.mjs` + `test/client-harness-lib.mjs`（可执行的 React 替身：真实 setter、可等待的 effect、fetch 替身）。覆盖载荷成功/宿主 ok:false/非 JSON/HTTP 失败/网络失败、保存设置与失败提示、全开全关、token 保存（含空值拒绝）与清除、加载笔记本、连接测试两种结果。验证：删掉 `setTokenDraft("")`、去掉 `run()` 的 catch、移除空 token 守卫，三处都让用例变红 |
| T5 客户端断言夹具而非产品 | ✅ 已修复 | 两个客户端套件的夹具改为调用宿主的 `internals.buildStatePayload` 生成（`client-render.mjs` 与 `client-interactive.mjs`），不再手抄形状 |
| H2 配置写入非原子 + 静默回退默认值 | ✅ 已修复 | `writeConfig` 改「临时文件 + `fsync` + `rename`」；`readConfig` 区分 ENOENT 与损坏：损坏仍回退默认值但必须 `ctx.logger.warn` 告警，同一份坏文件只告警一次。验证方式：只回退这两个函数 → 2 条新断言必失败 |
| H5 删除复核窗口偏紧 | ✅ 已修复 | 固定 `8 × 250ms`（2 秒）改为指数退避（150ms 起、上限 1200ms、总预算 6 秒、最多 15 次探测）；超时文案不再断言"删除未生效"，改为提示复核方法；慢于 1.5 秒的复核会在成功文案里告知耗时。验证方式：换回旧窗口 → 4 条新断言必失败（延迟 3 秒的替身会被误报失败） |
| H3 `abort` 未真正生效 | ✅ 已修复 | 取消信号经 `createApi` 贯通到 HTTP 请求（`AbortSignal.any` 组合超时）与删除复核的可中断 sleep；取消抛官方 `AbortError`。验证：摘掉请求上的取消 → 请求进行中取消要等满 3007ms；换回旧入口守卫 → 抛的是普通 `Error` |
| H6 `update_block` 不复核 | ✅ 已修复 | 写前预检目标块、写后复核仍存在；多段输入明确告警"只写入第一段"。验证：换回旧实现 → 3 条断言必失败（含"真往不存在的块写请求"） |
| H7/H8/H9/H10 | ✅ 已修复 | H7 删死代码（`resolveDailyDoc` → `lookupDailyDoc`）；H8 设置页显示"已启用 N / 共 17"；H9 `siyuan_sql` 只接受单条 SELECT；H10 写入前校验笔记本存在且已打开 |
| T6/T7/T8 替身偏松 | ✅ 已修复 | 替身新增表名校验与"不认识的 SELECT 形状报错"、`createDocWithMd` 校验 notebook 存在性、`setNotebookClosed` 供关闭态用例；"多段只留第一段"由 H6 的断言覆盖 |
| T9 测试基础设施 | ✅ 已修复 | 临时 home 改 `mkdtempSync`（失败时保留取证）、替身 timer 登记并在 `close()` 清理、新增插件卸载路径断言、失败清单保留 detail、新增路由围栏（cross-site/origin/trustedHosts/无 Host）与请求体（非法 JSON / >2MB / 空体）用例、工具分支缺口补齐（缺 notebook、`parentId`、attrs 非对象、`toId` 空、format 回落、无命中、空目录、goLayout 全片段与 2126 回归、开关关回去） |


---

## 一、宿主：真实缺陷

### H1（严重）非法 `date` 会静默落到"今天"，可能写错日记

`lib/index.js:227-232` → 被 `siyuan_daily_note` 使用（`:643`）。

```js
const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
if (match === null) return new Date()      // 非法输入 → 静默用今天
return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))  // 溢出翻滚
```

实测（Node 22）：

| 传入 | 实际解析成 | 问题 |
|---|---|---|
| `""` / `"abc"` / `"2026-9-12"` / `"2026-09-12T00:00:00Z"` | 今天 | 非法输入无声变成"今天" |
| `"2026-02-30"` | `2026-03-02` | 不存在的日期向前翻滚 |
| `"2026-13-45"` | `2027-02-14` | 越界月份/日期翻滚到下一年 |

`Date` 构造函数不做校验，非法值不抛错。风险在 `append` 路径：模型若传了一个手滑的日期，`siyuan_daily_note` **不会报错**，而是把内容追加到今天（或翻滚后的某天）的日记里。这属于静默写错位置，和本项目"不给假成功"的原则直接冲突。

建议：非法格式或翻滚（校验 `year/month/day` 是否等于构造结果的对应字段）一律抛错；`date` 参数改用 `enum`/pattern 无法表达，至少要显式拒绝。

### H2（中）配置写入不是原子的，损坏后静默回退默认值

`lib/index.js:79-83` 直接 `writeFileSync(target, …)`；`:71-77` 的 `readConfig` 用 `try/catch` 兜底，**解析失败就当成"没有配置"**。

后果：写一半掉电/被 kill（或并发写）留下半个 JSON，之后所有设置（baseUrl、默认笔记本、工具开关）静默回到默认值——用户看不出发生了什么，只发现开关全变回去了。dsh 自带 `dsh-atomic-write`，本项目零依赖所以手写也能接受，但至少要"写临时文件 + rename"。

建议：临时文件 + `fs.renameSync`；`readConfig` 区分 ENOENT（正常默认）与解析失败（记录/抛出，别伪装成默认）。

### H3（中）`abort` 未真正生效

`lib/index.js:262-265` 只在**入口**检查一次 `exec?.signal?.aborted`，之后执行的 `spec.execute(args)` 拿不到 signal。删除路径里的 `waitUntilBlockGone` 最长要轮询 2 秒（`:307-313`），用户中断/超时期间工具不会退出，仍会完成删除并给出结果。

建议：把 signal 传进 execute，至少在 `waitUntilBlockGone` 的轮询循环里检查。

### H4（中）生产代码往 `/tmp` 写残留诊断文件

`lib/index.js:779-786, 947, 954, 956`：每次 `apply()` 都写 `/tmp/dsh-siyuan-mount.txt`，异常时写 `/tmp/dsh-siyuan-error.txt`。这是当初没有宿主日志时的调试手段，现在宿主日志可用、README 也没提它。对发布包来说这是意外的文件系统副作用，且固定路径在并行实例间会互相覆盖。

建议：删掉 `diagnostic` 与三处调用，或改为 `ctx.logger.debug` 走宿主日志。

### H5（中）删除复核窗口只有 2 秒，慢实例上会误报失败

`:307-313`：`8 × 250ms`。README 自己写的实测是"返回成功那一刻 blocks 行还在，下一秒再查就没了"，即当前预算只比实测值宽一倍。大文档/慢磁盘/库在忙时，2 秒可能不够 → 工具报"删除未生效"，而文档其实已删（替身里 `deleteDelayMs: 250` 恰好卡在舒适区，测不出这个风险）。

建议：拉长到 `8 × 750ms` 或指数退避（约 6 秒），并让超时文案说明"思源删除是异步的，请稍后用 SQL 复核"。

### H6（中）`siyuan_update_block` 只回显成功，不校验

`lib/index.js:565-568`：调用后直接返回"已更新块"。而思源 `updateBlock` 传多段 Markdown 时**只保留第一段**（README 明确记录了这个坑）。模型传两段 → 内容静默丢失 → 工具回"已更新"，模型以为写全了。删除路径有 SQL 复核，更新路径没有，严格度不一致。

建议：多段输入时至少给出警告（或复核 `blocks.markdown` 与传入首段一致），与 `confirm` 无关的第二道"不许假成功"。

### H7（小）`resolveDailyDoc` 的 `create` 分支是死代码，`config` 参数未用

`:316-326` 的 `if (!create)` 建文档分支永远走不到——两个调用点（`:649`、`:659`）都写死 `false`，创建逻辑被内联在 `append` 分支里（`:652`）；`config` 参数两个分支都没用到。阅读成本白付。

建议：删掉参数与死分支，或让 `append` 复用该分支。

### H8（小）客户端"工具总数"与实际注册脱节

`lib/client.js:306` 显示 `state.toolNames.length`，而 `toolNames` 是**全部 17 个定义**（`:834`），与开关状态无关。用户关掉 danger 后，文案"当前共 17 个工具定义"仍是 17，容易被读成"已生效 17 个"。

建议：改为显示"已启用 N / 共 17"（按 `draft.tools` 过滤统计）。

### H9（小）`siyuan_sql` 的 SELECT 白名单只看开头

`:389` 用 `/^select\b/i` 判首词。原理上 `SELECT 1; DELETE FROM blocks` 这类多语句可以绕过头词检查（是否真能执行取决于思源 SQL 接口是否只读、是否接受多语句——**未验证**）。同时 `:391-394` 会把结果截断到 200 行，但拿不到总行数时不做提示之外的收敛。

建议：拒绝包含分号的多语句（或至少在 cheatsheet 里标注"思源 query/sql 是否只读、未验证"）。

### H10（小）块变更类工具不改笔记本状态

`:269-275` 的 `assertNotebook` 只校验"有没有填"，不校验笔记本是否存在/是否已关闭。往已关闭的笔记本写，错误文案来自思源的 `code/msg`，对用户不够可读。

建议：复用 `listNotebooks` 做一次存在性/`closed` 校验，或在错误里提示"笔记本可能已关闭"。

---

## 二、测试：可信度问题

`npm test` 当前全绿（exit 0），但下列问题使"绿"不足以支撑发布。

### T1（严重）`npm test` 不是自包含的，会因环境变红

`test/harness.mjs` 不走替身，直连真实 `http://127.0.0.1:6806`（`:172-216`）。已复现的两个变红路径：

- 没有本地思源（CI/新机器/离线）：`思源可达`（`:174`）与 `公开接口探测成功`（`:202`）FAIL → exit 1；
- **开发者 shell 里导出了 `SIYUAN_TOKEN`**：`SIYUAN_TOKEN=dummy-token node test/harness.mjs` → `FAIL token 未配置 — {"configured":true,"source":"env"}`，exit 非 0（我实测复现）。

第二点尤其致命：本项目**真实部署就是靠 `SIYUAN_TOKEN` 环境变量供 token 的**（现场记录在 `docs/handover.md`，该文件已 gitignore、不随仓库发布）。也就是说在这台机器上，开发者的日常 shell 反而跑不绿测试。另外 `:197-204` 还隐含依赖"本机思源已启用 token 鉴权"这一具体配置。

建议：harness 也接 `mock-siyuan.mjs`（或用 stub `fetch`）跑，把真实实例验证从默认路径剥离；测试开头 `delete process.env.SIYUAN_TOKEN`。

### T2（严重）恒真断言

`test/harness.mjs:176`：

```js
check('配置文件已写入临时 DSH_HOME', fs.existsSync(TEST_HOME + '/storages/siyuan/config.json') === false || true)
```

`A === false || true` 恒为 true。这条零信息量，还会掩盖"配置文件不该存在却已存在"的场景。同文件的 schema 校验（`:99-107`）写法正确（`try { check(..., true) } catch { check(..., false) }`），只有这一处是漏改。

建议：删掉 `|| true`（保留 `=== false` 的意图）。

### T3（严重）schema 校验会被静默跳过，套件仍报"全部通过 ✅"

`test/harness.mjs:15-19`：解析不到官方 `@deepseek-ai/dsh-tools` 时只 `console.log('skip …')`，然后 `assertSupportedJsonSchema = null`；`:99` 判 `!== null` 就整层跳过。而该依赖是**被 gitignore 的本地软链**（指向 dsh 安装目录），换机或清 `node_modules` 后必然触发 → 17 个工具的 schema 校验无声消失，套件照样绿。

建议：缺依赖直接 FAIL（或记入 `failures`），不要只 log。

### T4（严重）客户端交互层零覆盖

两个客户端套件（`client-harness.mjs`、`client-render.mjs`）的 React 替身都把 `useEffect` 设为 no-op、没有 `fetch` stub、**从未调用任何 onClick**。因此 `lib/client.js:66-81`（`api()` 信封处理）、`:133-181`（`run` 的 busy/err 状态机、`saveConfig`/`testConnection`/`loadNotebooks`/`saveToken`/`clearToken`）、`setAllTools`、`tokenDraft.trim()===''` 拒绝分支**一行都没执行过**。把 `saveToken` 里的 `setTokenDraft("")` 或 `run` 的 `catch` 删掉，套件依然全绿。

建议：补一个带 `fetch` stub 的执行型 harness，真正触发 onClick 闭包，断言请求 URL/body 与 busy/错误态。

### T5（严重）客户端渲染断言的是夹具，不是产品

`test/client-render.mjs:59-70` 手抄了宿主 `statePayload` 的形状，17 个工具名手工铺在夹具里（且全标成 `group:'read'`，与真实分组不符）；`:157` 断言"当前共 17 个工具定义"实际只在断言这个数组字面量的长度。宿主把 `toolNames` 改名而 `client.js` 未同步时，夹具与被测代码同改不动 → 测试绿、线上设置页崩。

建议：夹具由宿主真实产出生成（跑一次 `statePayload` 再喂给组件），或在 `tools-e2e` 里断言宿主字段集与夹具键集一致。

### T6（中）替身的 SQL 是正则伪解析器

`test/mock-siyuan.mjs:221-244` 只识别 `select 1 as ok` / `where id='x'` / `where id in (…)` / `root_id=…` 四种形状，表名列名写错也可能返回成功或 `[]`。`tools-e2e.mjs:100-103` 只证明"语句被原样转发 + 非 SELECT 被拦"，没证明 SQL 有效。

### T7（中）替身比真实宽松，掩盖了不校验 notebook 的问题

`test/mock-siyuan.mjs:106-110` 的 `createDocWithMd` 不校验 notebook 是否存在（真实思源会返回非 0），而 `lib/index.js:503-514` 的 `create_doc` 也没有预校验 → "往不存在的笔记本写文档"这条 bug 在替身下永远测不出来。

### T8（中）已知真实行为"复刻了但没断言"

`mock-siyuan.mjs:193-199` 忠实实现了 `updateBlock` 只留第一段，但 `tools-e2e.mjs:154-156` 传的是单段 markdown，只断言"变了" → 这个被写进工具描述的关键坑，测试其实没约束住（配合 H6：插件也只回成功、不复核）。

其他缺口（不逐条展开）：约 20 处工具分支无覆盖（`assertNotebook`、`insert_block` 的 `parentId` 分支、`set_block_attrs` 非对象拒绝、`abort`、`goLayout` 的 `15/04/05` 与"顺序替换产出 2126"回归）；路由围栏只测了 Host 一条（`sec-fetch-site`/origin/trustedHosts 未测）；`>2MB` 请求体与非法 JSON 未测；`updateConfig` 把工具关回去（17 → 8）的路径未测；断言大量绑定中文文案；`client-render.mjs:91` 用位置数组注入 7 个 `useState`，绑定 hook 顺序；`tools-e2e.mjs:178` 标签写"文档不再出现在列表里"而实际断言的是请求计数；`test/tools-e2e.mjs:2` 头注释仍写"14 个工具"；`harness.mjs:22`、`tools-e2e.mjs:11` 用硬编码 `/tmp/sy-*-home` 且开头 `rmSync`（并行跑会互删）。

---

## 三、没问题的部分（避免误改）

- **思源接口契约的注释与 README 记录**：`deleteBlock` 文档块 no-op、删除异步落库、`createDocWithMd` 非幂等、`updateBlock` 只留第一段、标题是叶子块、折叠标题不在 getDoc DOM 里——这些是第一手实测结论，价值高于代码本身，别在重构中丢掉。
- **`goLayout` 的单趟正则**：确实修掉了顺序替换把 `2026` 变成 `2126` 的 bug（`:217-219` 的注释准确）。
- **信任围栏 `isTrustedRequest`**：Host + `sec-fetch-site` + origin 三重判据，与同生态插件一致，写法没问题（只是测试没盖到）。
- **删除路径的复核设计**：先查块类型、文档块拒绝、删后 SQL 轮询——思路正确（H5 只是预算偏紧）。
- **嵌套渲染方法**：`dataType: 'markdown'` + 单段语义都传对了；参数校验（`attrs` 非对象、`toId` 空、`docIds` 空、`title` 空）覆盖得比预期好。

---

## 四、建议的处理顺序

发布前（阻断项）：H1、H4、T1、T2、T3。
发布前（强烈建议）：H2、H5、T4、T5、H6。
可延后：H3、H7–H10 与 T6–T8 的补测。

修完 H1/H4 与 T1/T2/T3 后重跑 `npm test`，应满足：无本地思源、无 `SIYUAN_TOKEN`、缺 `dsh-tools` 三种环境下行为明确（要么全绿要么显式失败，不得静默跳过）。
