# Code review（2026-09-28）

范围：`lib/index.js`（1437 行）、`lib/client.js`（825 行）、`test/`（7 套件 + 替身）、
`package.json`、`cordis.patch.yml`。基线 `npm test` 7 套件全绿（433 条断言）。

方式：**只审上次评审之后的增量**（`git diff 4bfc063..HEAD`：`lib/client.js` +600/-133、
`lib/index.js` +137/-28、新增 `test/decode-body.mjs`）。[code-review-2026-09-12](./code-review-2026-09-12.md)
的 H1–H10 / T1–T9 状态表当**回归清单**用，不重评。三块并行审查（宿主配置迁移 / 客户端 /
测试可信度）由子代理独立完成，**每条结论都由我复现或对照源码核实后才写进本文件**；
被推翻的结论记在第五节。

判据：**对外信号必须与实际发生的事一致**——既不假成功，也不把已成功报成失败；
不确定时错误信息必须可执行；安静的降级是 bug，声明过的降级是设计。

结论速览：**1 个高危、8 个中等、13 个低等问题，没有一个是崩溃或数据损坏**。高危那条的
要害不是"锁提前解开"，而是**页面显示的工具开关状态可以与模型实际拿到的能力集相反**，
而页脚还写着「所有改动都已保存」。测试侧有 **5 条关键路径摘掉修复后 7 套件仍全绿**——
也就是说这些缺陷没有守门人。

## 状态

| 编号 | 问题 | 状态 |
|---|---|---|
| **F1** | 单值 `pending` → 提前解锁 + 乱序响应覆盖，页面与模型能力集相反 | ✅ **已修复**（2026-09-28） |
| **F2** | 非布尔的工具键被静默丢弃 → 用户明确关掉的**删除工具被打开** | 🔴 未修，已复现 |
| **F3** | 混合提交时组级意图被丢弃，接口回 `ok:true` | 🔴 未修，已复现 |
| F4 | 笔记本列表可能属于另一台思源，页面给出假命题「不在当前列表中」 | 🔴 未修 |
| F5 | 探测失败后旧的 ✓ 明细与「可达」徽标继续显示 | 🔴 未修 |
| F6 | 自适应解码漏掉合法 zlib 头 `78 5e` | 🔴 未修，已复现 |
| F7 | `siyuan_move_doc` 描述把模型导向有损绕行 | 🔴 未修 |
| F8 | token 草稿不进 `dirty`，页脚因此对用户说谎 | 🔴 未修 |
| F9 | `GROUP_ORDER` 是宿主组表的手抄副本，未知组不可见**且关不掉** | 🔴 未修 |
| F10 | 切设置分区卸载组件 → 未保存草稿静默清零 | 🔴 未修，**需真机确认** |
| F11 | `get_child_blocks` 正文补齐失败后每行显示「(无正文)」，无降级迹象 | 🔴 未修 |
| L1–L13 | 低等问题（见第三节） | 🔴 未修 |
| T4–T5 | 剩下 2 条变异后仍全绿的关键路径 | 🔴 未修 |
| E1–E6 | 排除结论（看着像 bug 其实不是） | ✅ 已排除 |

---

## 一、高危

### F1 客户端单值 `pending`：锁被提前清掉 + 乱序响应覆盖，**页面显示的工具开关可以与模型实际能力集相反**

`lib/client.js:343-353` 的 `run()` 里 `pending` 是**单值**：

```js
const run = async (card, label, fn) => {
  setPending(card)
  try { await fn() } catch (e) { … } finally { setPending(null) }   // 谁先结束谁清空
}
```

`busy` 由 `pending === card` 派生（`lib/client.js:448-454`）。"各卡互不锁定"本身是对的，
但 A 卡在飞时点 B 卡会覆盖 `pending`，B 一结束 `setPending(null)` 就把 **A 的锁一起清掉**；
而且 `applyState`（`lib/client.js:359-368`）对任何返回的响应都无条件覆盖草稿——
两次 `updateConfig` 并发在飞时，**迟到的旧响应会盖掉新响应**。

复现（`test/client-harness-lib.mjs` 的真实 hook 运行时 + 逐个挂起的 fetch 替身；
建模为「fetch 被调用 = 宿主收到请求并立即落盘，resolve = 响应返回」）：

```
起点：新建文档 aria-checked = true（write 组已开）
① 关掉它 → 页面 = false；保存按钮 disabled = false
② 保存#1 到达宿主 → 落盘 create_doc = false；响应挂起；保存按钮 disabled = true（busy，正常）
③ 点「测试连接」后 → 保存按钮 disabled = false        ← 锁被提前清掉，而 #1 还在飞
④ 用户又打开它 → 页面 = true
⑤ 保存#2 到达宿主 → 落盘 create_doc = true           ← 磁盘最终值 = 模型实际能力集

—— 响应乱序：#2 先回，#1 迟到 ——
  #2 响应落地 → 页面 = true ；页脚「所有改动都已保存」= true
  #1 迟到落地 → 页面 = false；页脚「所有改动都已保存」= true

宿主配置（模型实际拿到的能力集）= siyuan_create_doc true
页面显示                          = siyuan_create_doc false
```

**页面说「关」、模型仍然开着，页脚还写着已保存。** 这是本项目最坏的一类不一致：
工具开关就是模型的能力集，错了它就等于权限系统失守，而用户在界面上看不出任何异常。

窗口有多宽：`buildStatePayload` 每次都做可达性探测（`lib/index.js:1217`，
`PROBE_TIMEOUT_MS = 4000`），思源不可达时**每次保存都慢 4 秒**（实测 4007ms）——
而这正是用户在这张卡上反复拨弄、忍不住再点一次的时刻。

**修法要两处：**

1. `pending` 换成 `Set`，`finally` 里**只摘自己那张**；`busy` 按集合成员派生。
2. 加**请求票据**：每张卡一个自增序号，响应回来时对不上就丢弃（连同它的成功/失败消息）。

> **补一条对本文的修正**：修完第 1 点之后，第 2 点在**当前 UI 下已经不可达**了——同一张卡的
> 输入、下拉、开关行在保存期间全是 `disabled`，按钮也是，用户点不出第二次保存。票据因此是
> 防御性的（防止以后给某张卡加"保存中仍可改"的交互），不是修当下这个洞所必需。
> 但它便宜、且把一整类问题挡在门外，所以保留；对应的用例也如实标注了它是防御性断言。

### F1 的修复记录（2026-09-28）

**产品**（`lib/client.js`）：

- `pending` 由单值改为 `Set<string> | null`（`null` = 全空闲），`run()` 用更新函数增删，
  `busy` 由 `isPending(card)` 派生，页脚「重新读取」的 `pending !== null` 随之变准。
- 新增 `requestSeq = useRef({n, latest})`：`run()` 每次领一张票据并传给 `fn(isCurrent)`；
  七个动作（保存地址/笔记本/开关、保存 token、清除 token、测试连接、加载笔记本）与
  `load` 都在落地前判 `isCurrent()`，过期响应连同它的消息一起丢弃。
- 状态形状变了，因此 `test/client-harness-lib.mjs` 的 `createHooks` 补了 `useRef`，
  四处 react 替身（`client-harness` / `client-navicon` / `client-render` / `client-interactive`）跟上。

**测试**（`test/client-interactive.mjs`，+25 条断言，433 → 458）：

- fetch 替身新增 `hold`：先按正常路径算出"此刻宿主会回的响应"，再把**传输**挂起，
  由用例显式 `release()`，因此放行顺序独立于到达顺序——这是观察乱序返回的前提。
- 新增 `drain()`：只排干异步链、**不重跑 effect**。竞态用例必须用它——替身的 `useEffect`
  不看依赖数组，`settle()` 会重发一次 `getState` 把"还没返回的写入"提前同步进页面，
  dirty 被抹平、按钮因"没有改动"而禁用，**正好把锁 bug 掩盖掉**（这条本身就说明了 E1 的危害）。
- 新增 `cardText(title)`：按卡取文本。原先 `messages()` 把所有卡拍平、不带归属，
  所以"消息落到别的卡"没有任何断言能发现。
- 四组新用例：两卡并发互不顶锁 / 同一张卡的旧响应后到不覆盖 / 保存 token 不动别的卡草稿 /
  锁与反馈都落在本卡。

**变异验证**（逐条摘掉修复，确认对应用例变红）：

| 变异 | 结果 |
|---|---|
| `pending` 退回单值 | ✅ 变红 3 条 |
| 去掉请求票据守卫 | ✅ 变红 1 条 |
| `applyState` 整份重置 | ✅ 变红 4 条 |
| 成功消息写到别的卡 | ✅ 变红 2 条 |
| 锁落到别的卡 | ✅ 变红 2 条 |
| `load` 的票据 | ⚠️ **假绿——目前无用例覆盖**，`load` 经页脚「重新读取」那条路径的乱序仍无守门人。补用例时要先把 `重新读取` 按钮在 `hold` 下的路径跑出来 |

---

## 二、中等

### F2 非布尔的工具键被静默丢弃 → 用户明确关掉的删除工具被打开

`lib/index.js:70-72` 的 `normalizeConfig` 只收 `typeof value === 'boolean'`，其余键直接丢，
**不走 `reportConfigCorrupt`**——而同一个函数对非法 `baseUrl` 是会告警的（`lib/index.js:80`），
标准不一致。

复现（配置 `{read:true, write:false, daily:true, danger:true, siyuan_delete_block: 0}`）：

```
注册到的删除类工具 = [ siyuan_delete_block, siyuan_remove_doc ]
判定 = ❌ 用户明确关掉的删除工具被打开了
告警条数 = 0
```

机制：`isToolEnabled`（`lib/index.js:99-105`）先查逐工具键 → 键被丢了 → 回落组键
`danger:true` → 两个删除工具全部启用。同理 `{"read":0}` 会把 7 个只读工具全打开
（`read` 的组默认是 true）。而且这**每次 `readConfig()` 都发生**，不只在保存时；
一旦触发一次保存，`updateConfig` 落盘时会把丢掉的键**永久抹掉**。

危险程度取决于 `danger` 组默认是关的（是），所以只有当配置里同时存在组键和损坏的逐工具键时
才会发生——手改配置、外部脚本写配置、旧版本写坏值都可能。**这是"配置里明确写了关闭"被
无声反转**，方向上最不该出现。

修法：`normalizeConfig` 遇到非布尔的工具键时 `reportConfigCorrupt` 一次，并且
**保留该键、按 `value === false` 处理**（宁可少开一个工具，也不要静默打开）。

### F3 混合提交时组级意图被丢弃，接口回 `ok:true`

`lib/index.js:1311` 用"有没有非组名键"分两条分支；进入逐工具分支后，`incoming`
**只按工具名被读**（`lib/index.js:1319`），`incoming['read']` 从头到尾没人看。

复现（盘上是旧版组名键，提交 `{tools:{read:false, siyuan_search:true}}`）：

```
路由回 ok = true ← 接受并回成功
落盘后还有 read 键 = false ；键数 = 17
read 组仍启用的工具 = 7 / 7
判定 = ❌ read:false 一个都没生效
```

用户要的"关掉只读组"完全没发生，接口回成功，组名键还被整层替换抹掉。浏览器路径不会这么调
（设置页总是提交全 17 个工具名），暴露面是 `/siyuan/api/updateConfig` 这个 POST 端点的
脚本调用、旧客户端、以及未来的第三方客户端。

同类还有一个更轻的版本：迁移完成后组名键成为**死键**（`lib/index.js:1322-1325` 的 else
分支只做叠加，而逐工具键齐全后组键永远不会被读到），此后任何组名键提交都会被接受并回
`ok:true` 却毫无效果。**解析本身是设计**（README 已声明"分组只决定排列与新建时的默认值"），
**"接受一种自己兑现不了的请求并回成功"是缺陷**。

修法：else 分支里若该组已有逐工具键，把它映射到组内每个工具；或直接抛一条说明性错误。

### F4 笔记本列表可能属于另一台思源，页面因此给出**假命题**

宿主的 `listNotebooks` 返回值里带 `baseUrl`（`lib/index.js:1354`），显然就是给客户端判别用的，
而客户端两处都丢了（`lib/client.js:333`、`lib/client.js:426` 只取 `result.notebooks`）。
同时 `notebooks` 不会随地址变化失效（`lib/client.js:296` 只由 `loadNotebooks` 与静默 effect 写）。

场景：打开设置页静默加载到 A 服务器的列表 → 用户把地址改成 B，不点「刷新笔记本」→
下拉里仍是 A 的笔记本，而 `lib/client.js:665-668` 会把已保存的笔记本标成
**「（不在当前列表中）」**——它就在"当前列表"里，只不过列表是旧的。用户据此会以为 id 失效，
改选一个只存在于 B 的 id，保存后写入与日记全部落错库。

叠加两处安静的降级：静默 effect（`lib/client.js:328-339`）的 `.catch(() => {})` 不写任何消息，
用户点「加载笔记本」之前完全看不出列表没加载；它还用的是**请求发出那一刻**的
`draft.baseUrl`（依赖数组里故意不含 draft），响应回来时输入框里的地址可能已经变了。

修法：存 `{ baseUrl, notebooks }`，渲染时与 `draft.baseUrl` 不一致就标注"列表来自旧地址"，
不一致时**不要**断言"不在当前列表中"。

### F5 探测失败后旧的 ✓ 明细与「可达」徽标继续显示

`lib/client.js:415-421` 的失败路径只写 `messages.connection`，**从不 `setProbe(null)`**——
`setProbe` 全文件只在成功分支（`lib/client.js:419`）被调用。而徽标
（`lib/client.js:464-468`）只看 `state.reachable`，那是上一次 `getState`/`updateConfig` 的快照。

于是"改过地址/token 后测试失败"的用户，会在红色失败文案下面看着三条**指向另一个地址、
另一个 token** 的绿勾，以及一个仍然亮着的「可达 · v3.8.3」徽标。

修法：`testConnection` 开头 `setProbe(null)`；徽标在有未保存地址时改口径
（例如"已保存地址：可达"），或测试后用探测结果更新 `state.reachable`。

### F6 自适应解码漏掉一档合法 zlib 头，落在 0.0.3 要消灭的那个场景里

`lib/index.js:322` 的魔数表只有 `0x01 / 0x9c / 0xda`。zlib 头在 `CMF=0x78` 时合法 FLG
**只有四个**：`0x01`、`0x5e`、`0x9c`、`0xda`。漏掉的 `0x5e`（FLEVEL=1）正是
`zlib.deflateSync` 在 **level 2–5** 时的实际输出：

| 响应体 | 头两字节 | 解码 | JSON |
|---|---|---|---|
| deflate level=1 | `78 01` | ✅ | ✅ |
| **deflate level=3** | **`78 5e`** | **❌** | **❌ 抛「响应无法解析为 JSON」** |
| deflate level=6 | `78 9c` | ✅ | ✅ |
| deflate level=9 | `78 da` | ✅ | ✅ |
| gzip | `1f 8b` | ✅ | ✅ |

（走真实的 `internals.decodeResponseBody`，`content-encoding` 传 `null`，复刻 DSH 0.1.7
代理 dispatcher 丢头的场景。）

失败形态是**带诊断信息的报错**（错误文案会打出 `content-encoding` 与前 8 字节 hex，
用户能看到 `78 5e`），不是假成功——所以这是覆盖面缺口而非正确性事故。但它削弱的
恰恰是 0.0.3 的核心卖点。修法用结构判据比补一个魔数更稳：
`(buf[0] & 0x0f) === 8 && buf.readUInt16BE(0) % 31 === 0`，
同时给头分支补上 `deflate`（`lib/index.js:324` 现在只认 `br`）。

### F7 `siyuan_move_doc` 的描述把模型导向一个会丢数据的绕行

`lib/index.js:995`：「移动单个块请用 `siyuan_insert_block` / `siyuan_delete_block`」。

插件**没有**暴露块级移动——`/api/block/moveBlock` 在
[siyuan-api-cheatsheet.md:393](./siyuan-api-cheatsheet.md) 里有实测契约，`lib/` 里一次都没出现。
而"插入 + 删除"不是移动：块 id 会变、块历史会丢，中途失败就是内容重复或丢失。
工具描述是直接喂给模型的行为约束，让它把"移动一个块"理解成"复制再删"是危险的。

修法二选一：补 `siyuan_move_block`（代价：工具数 17 → 18，要同步 README 工具表、
`dshhub.summary`、awesome-dsh-plugin 条目、`TOOL_LABELS`）；或把描述改成实话。

### F8 token 草稿不进 `dirty`，页脚因此对用户说谎

`lib/client.js:442-447` 的 `dirty` 只有 connection / notebook / tools 三项，token 草稿不在内，
而 `anyDirty` 驱动页脚（`lib/client.js:703`）。实测：在 token 框里输入任意内容后，页脚仍然是
**「所有改动都已保存」**。叠加 F10（切分区卸载）→ 输了一半的 token 静默消失。

同一张卡的「保存 token」按钮（`lib/client.js:624`）也不按 dirty 门控，空 token 点下去必然弹
「保存 token失败：token 为空」，而另外三张卡的主按钮都是 `!dirty` 门控——**四卡行为不一致**，
正好破掉"各卡一致"这条设计约定。

### F9 `GROUP_ORDER` 是宿主组表的手抄副本，未知组不可见**且关不掉**

`lib/client.js:143` 硬编码 `["read","write","daily","risk"→"danger"]`，`lib/client.js:484-486`
对 `groupTools.length === 0` 的组 `return null`。而宿主明明把 `toolGroups` 回传了
（`lib/index.js:1227`），客户端**一次都没读**（grep 确认）。

宿主往 `TOOL_GROUPS` 加一个新组而客户端漏同步时：该组工具**默认开着、模型能用，
但设置页没有任何一行能把它关掉**，唯一的出路是"全部停用"再逐个开回来；同时计数行会显示
「已启用 9 / 共 18 个」而页面上只有 17 行。

讽刺的是同文件的 `TOOL_LABELS` 对未知工具名有明确回落（`lib/client.js:151-154` 的注释就是
"宿主新增工具时不会把它藏起来"），**工具名有前向兼容、组名没有**——两处策略不一致。
修法：按 `state.toolGroups` 渲染，未知组用原文兜底。

### F10 切设置分区会卸载本组件，所有未保存草稿静默清零

外壳 `dsh-client-ui-settings-general/lib/client.js:333` 是
`renderSlot("settings.section", {close}, { only: active })`——只渲染当前分区，其余分区组件卸载。
本组件的全部状态都在 `useState`（`lib/client.js:294-301`），重新挂载必走 `load()` →
`setDraft(draftFromState(value))`。

后果：用户改了地址、拨了几个工具，切到"模型"看一眼再切回来 → 草稿全没，页脚从
"有未保存的改动"变回"所有改动都已保存"，**没有任何提示**。页脚那句「『重新读取』会丢弃它们」
只覆盖按钮（`lib/client.js:702-703`），覆盖不了分区切换。

Node 替身结构上测不到（替身没有卸载概念）。**必须真机点一遍**确认 `{only: active}`
的实际语义——这是本文件里唯一一条我无法在本地闭环的结论。

### F11 `get_child_blocks` 正文补齐失败后，模型看到的是一片「(无正文)」

`lib/index.js:838-840` 把 SQL 正文补齐的失败 `catch {}` 吞掉，之后
`block.content`（`getChildBlocks` 根本不返回，`lib/index.js:830` 的注释自己写了）
也取不到 → **每一行都显示「(无正文)」，没有任何迹象表明这是降级**。

代码注释声明了"正文补齐失败不影响结构输出"——按判据"用户能不能看出它退化了"，
**模型看不出来**。安静的降级。修法：补齐失败时在输出开头加一行显式说明。

---

## 三、低（13 条）

| 编号 | 位置 | 问题 |
|---|---|---|
| L1 | `lib/index.js:888-889` / `:1056-1058` | 思源返回 `null` 时字面输出「已创建文档：id=null」、「文档 id=」（已复现）。`daily_note` 更弱：`String(createdId ?? '')` → 空 id |
| L2 | `lib/index.js:764-766` | `siyuan_sql` 截断时把「…（共 N 行）」后缀拼在 JSON 数组**之后**，输出不再是合法 JSON，模型可能解析失败（已复现） |
| L3 | `lib/index.js:738` / `:764` | `search` 的 limit 钳制与 `sql` 的 200 行截断都无断言（变异后全绿） |
| L4 | `lib/client.js:408-413` | `clearToken` 不清 `tokenDraft`：清除已存 token 后，框里残留的旧草稿仍优先于凭据库参与之后的探测，页面却显示「token 未配置」 |
| L5 | `lib/index.js:1301` + `lib/client.js:380-382` | 清空地址点「保存地址」→ 宿主整段跳过 → 回「地址已保存。」并把旧值填回输入框 |
| L6 | `lib/index.js:1211-1237` | 思源不可达时每个设置页操作固定多等 **4007ms**（实测），四个路由都共用带探测的 `statePayload` |
| L7 | `lib/index.js:1216-1221` | 探测的 `catch {}` 把原因整个丢掉，只剩 `reachable:false`——看不出是地址错、token 错还是代理解压炸了 |
| L8 | `lib/client.js:239-254` | 宿主 `testConnection` 明确回 `tokenConfigured` / `tokenSource`（注释写着"页面用的是草稿时用户要能看出这一点"），`ProbeList` 根本不显示。用户在 token 框填了错 token 去测试，徽标仍写「token 已配置 · 存在 dsh 凭据库」 |
| L9 | `lib/client.js:430-437` | 加载配置失败的分支只渲染一条错误 + "正在读取配置…"，「重新读取」在另一个分支里——用户只能关掉设置页重开 |
| L10 | `lib/index.js:36` / `:1183-1200` | `MAX_BODY_BYTES` 只管请求体。0.0.3 新增了解压面，`gunzipSync/inflateSync` 对整块无上限展开 |
| L11 | `lib/index.js:82-86` + `:1327` | `writeConfig` 写归一化后的对象，配置文件里任何未知顶层键会在下次保存时被静默删掉 |
| L12 | `lib/index.js:134` / `:1240` | `onConfigCorrupt` / `warnedCorruptFile` 是模块级全局，卸载时不清理；重复实例会互相抑制告警 |
| L13 | `lib/client.js:228` | `aria-checked="mixed"` 挂在 `role="switch"` 上不合 ARIA 1.2（switch 的 aria-checked 是布尔；三态模式用 `role="checkbox"`）。"半开"状态对读屏不可靠 |

另有**契约缺口**（非已证实的假成功，延续上一版评审的 C5）：`siyuan_append_block` /
`siyuan_insert_block` / `siyuan_rename_doc` / `siyuan_move_doc` 的"目标不存在"行为既无预检
也无结论。`insert_block` 优先级最高——工具描述明确引导模型拿标题 id 当 `previousID`，
而标题 id 失效（被删/被移动）很常见。最省的做法不是给四个工具都加预检（每加一次就是一次
SQL 往返），而是**先在 cheatsheet 里记一条实测结论**。

---

## 四、测试可信度（变异测试：摘掉保护，看 7 套件是否变红）

> **出处说明**：T1 由我写脚本复现（见第一节）；T2–T5 是子审查在仓库副本上做变异测试的结果，
> 我核对了每条的**机制**（读了对应断言与产品代码）但没有逐条重跑。恒真断言与结构性假绿那几组，
> 我逐条 grep / 读码核实过。

| 编号 | 被摘掉的保护 | 变异结果 |
|---|---|---|
| T1 | `client.js:343-353` 的 `pending` 单值 | ✅ **已补用例** |
| **T2** | `client.js:359-368` `applyState` 的按卡对齐 | ✅ **已补用例** |
| **T3** | 各卡的 pending 卡名 / 消息落点 | ✅ **已补用例** |
| **T4** | `index.js:1092 / :1122` 删除复核失败即抛错 | 🔴 未修 |
| **T5** | `client.js:331 / :425` 拉笔记本用草稿地址 | **全绿** |

- **T1**：「各卡互不锁定」那组只让**一张**卡挂在飞，结构上给不出两卡并发的形状。
  （我复核过一条子审查的说法并**推翻**它：把那几条断言改成期望值的是不成立的——
  换成 `Set` 之后它们仍然全绿。真正的问题是它们没覆盖并发。）
- **T2**：`applyState` 对三张卡有断言，**token 卡的 `return current` 兜底零覆盖**——
  而那正是这条代码存在的理由（保存 token 不该动别的卡的草稿）。
- **T3**：`client-interactive.mjs:134-138` 的 `messages()` 把所有卡的 `.dsy-msg` 拍平成一个
  字符串，**不带卡归属**；`busy` 也只断言了 token 卡和 tools 卡。套件 docblock 宣称的
  "每张卡各自 pending 与消息"只验证了"请求体只提交本卡字段"。
- **T4**：这是 `delete_block` / `remove_doc` 的最后一道安全网，配套的可执行文案
  `deletionNotVerifiedMessage` 也零覆盖。替身里"文档块静默 no-op"因为产品的 `type==='d'`
  预检已经不可达，**连替身都造不出这个场景**——要给 mock 加一个"内容块也吞删除"的开关。
- **T5**：断言只写了 `typeof body.baseUrl === 'string'`，换成任何字符串都过。同文件里
  testConnection 的写法（精确等值）说明作者知道怎么写对，只是这两条写松了。

**恒真断言**（已核实）：

- `client-render.mjs:150` 与 `client-interactive.mjs:37` 的「不回显 token 值」**永远为真**——
  `'stored-token'` 字面量来自 `harness.mjs:522` 的假凭据，与客户端套件无关；
  客户端夹具的 token 值恒为 `''`。把 `lib/index.js:1224` 改成连值一起回显，
  `harness.mjs:584`（**那才是真守卫**）变红，这两条仍然绿。
- `tools-e2e.mjs:171/238/270` 的 `requestsTo(X).every(...)` 在空数组上恒真，缺长度守卫。

**结构性假绿**：

- **替身的 `useEffect` 丢弃依赖数组**（`client-harness-lib.mjs:124-127`），
  所以 `client.js:328-339` 注释里郑重守着的那条"依赖不能用 draft，否则反复发请求"
  的设计约束**在替身下完全无法验证**（把依赖改成 `[state, notebooks, draft]` 全绿）。
- **替身从不卸载**（`renderOnce` 没有 unmount 概念）→ 所有清理函数零覆盖；
  连带 `client.js:370/376/455/457` 里 `current === null` 的守卫在产品里其实是**死代码**
  （早退分支在它们之前就 return 了）。
- `client-harness-lib.mjs:97` 的注释声称有 `assertHookShape()` 守 hook 形状——
  **全仓库零命中**（只有这行注释自己），`hookCount` getter 也没人用。注释会骗后来的人。
- 四个客户端套件的失败摘要 `failures.push(label)` 不带 detail（`tools-e2e` / `harness` /
  `decode-body` 都带），失败时末尾清单只有标签没有值。
- `client-render.mjs:39` 丢掉了 `buildHostState` 返回的 `home`，结尾没有 `rmSync`——
  每跑一次泄漏一个 `/tmp/sy-client-fixture-*`。
- 客户端套件没 `delete process.env.SIYUAN_TOKEN`（只有 `harness.mjs:24` 有），
  `buildHostState` 的 ctx 走 env 回退分支——目前被手抄的 `token` 字面量盖住，
  一旦有人改成 `{...payload.token}` 就会变成不确定的。
- 工具数在 6 个文件里各自硬编码（`17` / `8` / `21` / `4`），增删一个工具要改 6 处，
  没有一处会提示漏改。AGENTS.md 明说"不要在文档里写死"，测试代码里同样写死了 10+ 处。

**替身与真实思源的偏差**（只列刻意之外的；那四个刻意怪癖不算）：

- `mock-siyuan.mjs:234` 把**所有**标题块的 `subType` 写成 `h2`（真实是 h1..h6），
  而 `tools-e2e.mjs:148` 正在断言这个编出来的值——真实思源回 `h1` 时会红，产品其实没写错。
- `mock-siyuan.mjs:231-235` 的 `getChildBlocks` **不认块 id**，于是"块没有子块"和
  "替身不认块 id"不可区分——而这正是该工具描述里点名的主用途（读折叠内容、判断章节是否为空）。
- `mock-siyuan.mjs:130-136` 的 `listDocsByPath` 是前缀匹配（真实列直接子文档），
  且 `subFileCount` 恒为 0，而 `lib/index.js:814` 正是渲染这个字段。
- `mock-siyuan.mjs:112-116` 的 `getNotebookConf` 把 notebook 对象本身当 conf，
  且**永远有 `dailyNoteSavePath`** → `lib/index.js:684` 的兜底模板分支在替身下不可达。
- `mock-siyuan.mjs:137-146`：`getDoc` 对未知 id 回 `code 0 + 空 content`，
  `exportMdContent` 却抛错——同一坏 id 在两条分支上表现不一致。
- `mock-siyuan.mjs:275-293` 的检索是子串匹配且 `content` 非空，真实是分词匹配且
  `content` 列对带格式的段落**常为空**——`lib/index.js:745` 的空串路径测不到。

---

## 五、排除的结论（不是缺陷，记录下来省得下次重查）

1. **并发 `updateConfig` 不会丢配置**：`lib/index.js:1299-1327` 的读—改—写之间**没有任何
   `await`**（第一个 `await` 在最后的 `statePayload()`），Node 单线程下无法交错。
   F1 的伤害因此限定在 UI 与响应顺序，**不在落盘结果**——但"页面与磁盘不一致"的伤害同样成立。
2. **brotli 无魔数只能靠响应头**：brotli 确实没有固定魔数（实测头 `1b 7a 02 18`，随内容变），
   头被丢时无法识别，是 0.0.3 那个 bug 的固有代价。**不建议**为它加"试解一遍"的兜底：
   会引入无界开销和新的静默失败路径。
3. **`AbortSignal.timeout` / `AbortSignal.any` 不吊住事件循环**：20 秒超时不会累积，进程
   在定时器到期前正常退出，不是泄漏。
4. **`body.tools` 无法原型污染**：`incoming['__proto__']=true` 对普通对象是 no-op 且
   `Object.keys` 看不到；展开只复制自有可枚举属性。
5. **空请求体不构成 CSRF**：表单 POST 必然带 urlencoded 体 → `JSON.parse` 抛
   （`lib/index.js:1198`），写操作全部挡掉；空体只能命中只读路由。
6. **导航图标的 `replaceWith` 策略在当前外壳下是安全的**：对照外壳源码核实——active 态加在
   button 上而不是 svg、外壳图标是 `fill:none` + path 上 `stroke`，我们的实体路径 +
   `fill="currentColor"` 不会被吃掉；HMR 会正确 `tearDownEntryFiber`，**不累积观察者**。
   残留只有一条低危：选择器是全文档 `nav button`，用户若有一个恰好叫"思源笔记"的侧栏面板，
   它的图标会被换成思源 logo。

### 被我推翻的子审查结论（记下来免得又被人当结论引用）

- ❌「`client-interactive.mjs:414-427` 把 F1 钉成了期望值，改成 `Set` 后要一起改断言」——
  **不成立**。那组断言只让一张卡在飞，`pending` 换成 `Set` 后仍然全绿。问题不是"钉错期望值"，
  而是"根本没覆盖两卡并发"。

---

## 六、没问题的部分（别顺手改）

- **`isToolEnabled` 的三级判定与 `updateConfig` 的 `settled` 整层替换主路径**：
  未提到的工具按当前解析结论固化，不会因为旧组名键退场而被"组默认"悄悄改写；
  只提交 2 个逐工具键时其余 15 个原状不变。F2/F3 是**旁路**（非布尔值、混合提交），
  不是这条主路径的缺陷。
- **`siyuan_update_block` 的三段式**（预检存在性 → 复核仍在 → 多段告警，`lib/index.js:944-963`）：
  注释写清了**为什么不做内容等值复核**（思源会规范化 Markdown，等值比会误报）——这是判断力，
  不是遗漏。
- **`goLayout` 的单趟正则与备选 token 顺序**（`lib/index.js:412-430`），连
  "2026-09-12 渲染成 Satday"这个实测坑都写在注释里了。
- **信任围栏**（`lib/index.js:1147-1175`）：Host 缺失直接拒、loopback 或 trustedHosts、
  `sec-fetch-site: cross-site` 拒、origin **比 host 含端口**（注释解释了为什么不能只比 hostname）；
  路由方法用 `Object.hasOwn` 取防原型污染。
- **客户端的 hook 顺序无违规**：7×`useState` + `useCallback` + 2×`useEffect`，早退分支在
  **所有 hook 之后**；异步 effect 有 `cancelled` 守卫；挂载 effect 不返回 promise。
  **`flipTool` 用 `setDraft(updater)` 而不是渲染闭包值**（`lib/client.js:375-376`）——
  这是最容易写错的地方，这里是对的。
- **`applyState` 对 `card === "token"` 走 `return current`** 是有意的：token 不在草稿里，
  保存 token 不该动其他卡的草稿。
- **凭据只出状态不出值**（`lib/index.js:1224`）、草稿 token 只进探测请求且 source 标 `draft`。
- **`mount()` 走 `ctx.inject(['tools','webServer'])`**（`lib/index.js:1429-1431`），
  测试替身专门复现了 cordis 的 `cannot get property ... without inject` 约束。
- **元数据一致性**（已复核）：`buildTools` 实际 17 个（read 7 / write 7 / daily 1 / danger 2），
  README 与 `dshhub.summary` 都写 17；`dsh.engines.dsh` 与 `dshhub.compatibility.dsh` 一致，
  [docs/DEV.md:191-193](./DEV.md#L191-L193) 的复核命令仍有效（本机 dsh 0.1.7-rc.2 判兼容）。
- **测试侧的好写法**（值得推广）：`harness.mjs:460-469` 不靠文案自证，而是把配置指向死地址、
  让草稿指向替身，再看替身记的 `authorized` 计数；`tools-e2e.mjs:182/225/259` 断言替身里的
  文档数与块内容而不是中文文案；`tools-e2e.mjs:418-421` 用「elapsed > 2000ms + 替身里已查不到」
  而不是"文案说了什么"。

---

## 七、建议的处理顺序

**发布前（阻断）**

1. ~~**F1**（高）~~ ✅ **已修复**（2026-09-28）——`pending` 改 `Set` + 请求票据，
   T1–T3 三条变异假绿一并补上；修复记录见第一节。**遗留**：`load` 经页脚「重新读取」
   那条路径的票据无用例覆盖。
2. **F2**（中，安全相关）——非布尔工具键告警并按 `false` 处理，一行量级的改动，
   堵的是"明确关掉的删除工具被打开"。
3. **F3**（中）——混合提交要么兑现组级意图，要么明确报错。

**发布前（强烈建议）**

4. F4 / F5 / F8 / F9 / F11——都是"页面说的与实际不符"，改动集中在 `lib/client.js` 的几处
   状态与渲染判断，互相独立可并行。
5. F6——一行魔数判据 + 一条 level 3 的断言。
6. F7——改描述即可（补工具的话工具数三处同步另算）。

**可延后**

7. F10——先真机确认卸载语义，再决定要不要跨分区保留草稿。
8. L1–L13 与契约缺口（日记 / 插入 / 改名）。
9. 测试侧：T4 / T5 两条断言补齐，恒真断言改成有意义的（A1 那两条建议直接删——
   `harness.mjs:584` 已是真守卫），替身的 `useEffect` 至少要能记录依赖数组，
   补上 `assertHookShape()` 或把那句注释删掉。
