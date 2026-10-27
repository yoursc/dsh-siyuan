# dsh-siyuan 界面设计契约

本文是**界面半场**（`lib/client.js`，设置页）的设计契约，与 `README.md`（用户可见功能契约）、
`docs/DEV.md`（架构与发布）并列且**独立**。三者回答不同问题：

| 文档 | 回答的问题 | 失败模式 |
|---|---|---|
| `README.md` | 这个插件能做什么 | 用户按文档操作却失败 |
| `docs/DEV.md` | 怎么改、怎么发 | 改完线上起不来 |
| `docs/code-review-*.md` | 代码逻辑对不对 | 写错数据、假成功 |
| **本文** | **人会不会用错、看着对不对** | 点错、看不见状态、以为点了没生效 |

界面评审和代码评审的失败模式不同：代码评审判断"逻辑是否正确"，界面评审判断
"**这个正确逻辑，用户能不能正确读懂并用对**"。`npm test` 全绿完全不能说明后者。

---

## 一、设计原则

1. **跟随宿主，不自创设计语言。** dsh 有完整的设计 token 与首方组件（`@deepseek-ai/dsh-client-ui-primitives`）。
   插件能 `require` 到的只有 `react`（client-modules 只提供 react），所以控件必须手写——
   **但手写的是实现，不是设计**。token 选择、焦点样式、控件语义，一律照宿主的既有约定抄。
2. **颜色不是唯一语义载体。** 任何靠颜色区分的状态，必须有第二种可区分信号（形状/位置/文字/图标）。
3. **状态必须可辨**：默认 / 悬停 / 聚焦 / 禁用 / 忙 / 错误 / 只读，六种状态各自要能在视觉上认出来。
4. **配置频率决定版面权重。** 开箱即用、极少改的内容不该占据首屏主要高度。
5. **界面同样不许对用户说谎**（与代码评审同一条红线）。UI 显示的结论必须与实际状态一致，
   不确定就说不确定。

---

## 二、Token 纪律（硬规则）

### 2.1 只允许 `--dsw-alias-*`

插件样式表中**不允许出现裸色值**（`box-shadow` 的 `rgba()` 除外——宿主也没有阴影 token）。

这条不是洁癖。2026-10-04 的评审抓到全表唯一一处违反：开关小球写死 `#fff`，而宿主在同一位置
用的是 `--dsw-alias-switch-thumb` / `--dsw-alias-label-primary-foreground`——这两个 token 在
暗色下分别是 `#adb2b8` 和 `#0f1115`，**都不是白色**。写死白色等于放弃跟随主题，直接导致暗色下
小球对比度崩到 2.33:1（见 `docs/ui-review-2026-10-04.md` U1）。

**该处已修，并加了守门断言。** `test/client-navicon.mjs` 现在会检查：

1. 小球用 `--dsw-alias-switch-thumb` / ON 态用 `--dsw-alias-label-primary-foreground`；
2. 焦点规则一律不引用 `--dsw-alias-border-l2`；
3. 四个可聚焦控件都落到 `--dsw-alias-state-business-primary`；
4. **上色声明里没有裸色值**（解析式：剥注释、逐条声明看属性名，不用正则扫全文——
   否则注释里为解释问题而写的 token 实际色值会误报）。

第 4 条是这一节的机器化。新增裸色值时它会直接变红。

### 2.2 边界色强度顺序（反直觉，容易用错）

```
亮色：l4 #00000029(16%)  >  l3 #0000001f(12%)  >  l2 #0000001a(10%)  >  l1 #0000000a(4%)
暗色：l4 #ffffff33(20%)  >  l3 #ffffff29(16%)  >  l2 #ffffff1f(12%)  >  l1 #ffffff0f(6%)
```

**l4 最强，l1 最弱**——编号越大越重。默认边框用 l4 是宿主的约定（`Input.module.css` 同款），
所以"聚焦时换成 l2"会让控件**在聚焦后变淡**，属于反向操作。

### 2.3 焦点一律用 `--dsw-alias-state-business-primary`

宿主三个首方控件在焦点上完全一致：

| 控件 | 焦点实现 |
|---|---|
| `Input.module.css` | `.wrap:focus-within{border-color:var(--dsw-alias-state-business-primary)}` |
| `Checkbox.module.css:21` | `outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))` |
| `Switch.module.css:29` | 同上（同一条兜底） |

`--dsw-focus-ring-width` / `--dsw-focus-ring-color` 在主题里**未定义**，所以宿主实际生效的就是
`state-business-primary`（亮色 4.23:1 / 暗色 7.83:1）。插件里所有 `:focus` / `:focus-visible`
都应落到这个 token 上。

### 2.4 文字与状态色的分工

- 正文/次要/辅助文字 → `--dsw-alias-label-primary` / `-secondary` / `-tertiary`
- 状态文字（成功/警告/错误）→ `--dsw-alias-state-{success,warn,error}-primary`
- **注意**：亮色主题下 `state-success`(#22c55e, 2.28:1) 与 `state-warn`(#f59e0b, 2.15:1)
  作为**文字**不达 WCAG AA。这是宿主全站同款的取舍（宿主把 success 当文字色用了 117 处），
  **不是本插件该单方面修的**——改了反而与宿主脱节。记账在案，等宿主改，插件自动继承。

---

## 三、颜色语义（当前规范与已知问题）

| 用途 | token | 亮色 | 暗色 |
|---|---|---|---|
| 逐工具开关 ON 轨道 | `state-business-primary` | 4.23:1 | 2.33:1 |
| 组开关 ON 轨道 | `state-success-primary` | 2.28:1 | 2.28:1 |
| 危险组 ON 轨道 | `state-warn-primary` | 2.15:1 | 2.15:1 |
| 开关 OFF 轨道 | `border-l4` | 1.45:1 | 9.75:1 |

（对比度 = 小球 vs 轨道，门槛 3:1）

**已知问题（`docs/ui-review-2026-10-04.md` U3）**：本插件用一个颜色承担了多重语义——
"绿"同时是「连接可达」徽标、「token 已配置」徽标、以及三个组的 master ON；"琥珀"同时是
warn 文案和危险组 master ON。同一布尔状态（整组全开）在不同组呈现不同颜色，用户无法建立稳定映射。

目标规范：**同一状态用同一颜色；组与逐工具的区分靠控件尺寸与位置，不靠色相。**
若确实需要区分危险组，用位置（独立区块）或图标，而不是换色相。

---

## 四、布局与间距

### 4.1 当前标度

| 位置 | 值 | 出处 |
|---|---|---|
| 卡片间距 | 14px | `.dsy-root{gap:14px}` |
| 卡片内边距 | 12px 14px | `.dsy-card` |
| 卡片内元素间距 | 10px | `.dsy-card{gap:10px}` |
| 开关槽位宽度 | 42px | `.dsy-switch-slot` |
| 组头元素间距 | 8px | `.dsy-group-head{gap:8px}` |
| 工具行元素间距 | 10px | `.dsy-tool{gap:10px}` |

### 4.2 已知不对齐

`.dsy-group-hint{padding-left:50px}` 的注释声称"与组名/工具名同列"，实际：
组名在 `42+8=50px`（对），工具名在 `42+10=52px`（差 2px）。
**注意这不是那 2px 的问题**——问题是注释里的推导没跟着 `gap` 从 8 改成 10 而更新。
数值推导应写成断言或常量，不要写在注释里。

### 4.3 建议

把间距抽成一组具名常量（`SPACE_1..SPACE_5`）并生成 CSS。这样"间距是否成标度""两个东西是否对齐"
在 diff 里就能看出来，而不是靠读 72 行 CSS 手算。

---

## 五、组件约定

### 5.1 `Card` 的 `header` 插槽

`Card`（`lib/client.js:204-213`）的 `header` 用于标题行右侧。**约定：只放徽标或计数，不放按钮。**

当前违反：`lib/client.js:731-737`（「默认笔记本」卡）把「加载笔记本 / 保存笔记本 / 撤销」
整组按钮放进了 `header`。后果是同一页面上 **primary 保存按钮出现在两个不同位置**——
「保存地址」「保存 token」「保存开关」在内容下方，只有「保存笔记本」在标题右侧，
用户建立不了"保存按钮在哪"的空间记忆。

**规范**：primary 操作性按钮一律放内容下方的 `.dsy-actions` 行；`header` 只承担状态展示。

### 5.2 开关

- 外观**应由 `aria-checked` 驱动，不要平行 class**。宿主 `Switch.module.css` 开头的注释给了理由：
  *"the visual state cannot disagree with the state assistive technology reads"*。
  插件当前用 `.dsy-switch.on` class + `aria-checked` 两套推导（都由同一个 prop 算出，
  今天不会分歧，但结构上允许分歧）。
- 逐工具行是**整行可点**的（`role="switch"` 在行上），因此轨道必须是纯展示的 `span`
  （`SwitchTrack`），不能再套 `button`——按钮套按钮是非法 HTML 且会双触发。这一点当前实现正确。
- `mixed` 状态（组内部分开启）用小球居中 + `aria-checked="mixed"` 表达，正确。

### 5.3 禁用态

当前只有 `opacity:.5`。**规范**：禁用控件除了降透明度，还应降低边框/背景强度，
并且不要以"可用控件同形"占满版面——用户扫过时会数成"N 个可操作项"。

---

## 六、可访问性要求

- 交互控件必须有 `role` + 状态属性 + `aria-label`（当前 `Switch` / 整行 `switch` 都做到了）
- 整行可点必须有键盘等价物（`tabIndex` + Space/Enter），当前做到
- **焦点指示可见**：≥3:1（WCAG 1.4.11）。当前不达标，见评审 U2
- 不可逆操作（删除整篇文档）需要视觉隔离：独立区块 / 底色 / 图标 / 二次确认文案，
  不能只靠一个红色标题

---

## 七、验证方法（三层，能力严格递减）

| 层 | 覆盖 | 手段 | 能否自动化 |
|---|---|---|---|
| 1. 颜色对比度 | token 的实际色值、对比度是否达标 | `node tools/ui-contrast.mjs` | ✅ 可自动化（**opt-in**，见下） |
| 2. 结构 + 样式纪律 | DOM 结构、aria 属性、文案、**token 纪律**（无裸色值 / 焦点色） | `test/client-render.mjs`、`test/client-interactive.mjs`、`test/client-navicon.mjs` | ✅ 在 `npm test` 内，有守门 |
| 3. 真实渲染 | **布局、间距、对齐、溢出、hover、真实排版** | 真实浏览器里的人眼 | ❌ 不可自动化（见第八节） |

第 1 与第 2 层的分工很重要：**样式纪律**（有没有用 token）能自包含地断言，所以进 `npm test`；
**对比度数值**要读宿主主题文件，所以只能做成 opt-in 工具。两者互补，缺一不可——
只做第 2 层会漏掉"token 用对了但对比度不达标"（U1b 就是），只做第 1 层则没人拦得住改回裸色值。

第 1 层命令：

```bash
node tools/ui-contrast.mjs          # 有插件缺陷项失败时 exit 1
node tools/ui-contrast.mjs --json   # 机读
node tools/ui-contrast.mjs --all    # 连宿主参照行一起计入失败数
```

它**故意不在 `npm test` 里**：测试的「三不」要求自包含，而本脚本必须读本机 dsh 安装目录的
主题文件。它是开发者审计工具，不是测试。

---

## 八、真实效果图：唯一合规路径

**本仓库不建截图流水线**，也不要为此自建渲染器。理由有两条，第二条是决定性的：

1. **契约禁止。** dsh 的 `cordis-plugin-development` skill（`references/verification.md`）明确要求：
   *"Do not launch a separate browser from shell commands... do not search for rasterizers, invoke
   Quick Look, extract SVG into preview files, emulate React/DOM, or implement a custom renderer to
   compensate for missing browser control. A screenshot of a mock page is not verification of the
   running plugin."* 插件开发的验证对象是**运行中的插件**，不是 mock 页面。
2. **技术上也不成立。** 设置页只在 dsh web 壳内成立：需要 `window.__DSH_BOOT__`、
   client-modules 提供的 `react`、宿主注入的 client-module 图、`/siyuan/api/*` 路由与鉴权
   （直接访问 `127.0.0.1:3080` 未鉴权返回 401）。抽掉任何一项自己渲染出来的图，
   长得像但没有验证价值——**它恰好是本仓库最警惕的"假绿"**。

因此获取真实效果图只有三条路：

| 路径 | 做法 | 代价 |
|---|---|---|
| **A. 已鉴权的宿主页面**（推荐） | 在你已登录的 `http://127.0.0.1:3080` 上打开设置页截图 | 每次改版要人工截一次 |
| **B. 启用浏览器控制插件** | profile 启用 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`，agent 即获得真实浏览器控制权，可自行截图与量测 | 改 profile + 重启 dsh（属用户/1Panel 权限，不是 agent 能自行做的） |
| **C. 不验视觉** | 只做第 1、2 层，并在结论里**明确写"视觉未验证"** | 布局/间距类问题只能靠静态推导 |

路径 B 是"让 agent 自己拿效果图"的唯一正当实现方式——**赋予真实浏览器控制权，而不是伪造一个渲染环境**。

### 截图存档规范

`assets/settings-*.png` 是发布资产，`screenshots.json` 登记清单。每次更换截图必须：

- 文件名带主题（如 `settings-overview.png` 为亮色），暗色另存
- 在 `docs/ui-review-*.md` 里注明该截图对应的 commit
- 注意 `package.json` 的 `files` **不包含 `assets/`**，而 `README.md:15` 引用了
  `assets/settings-overview.png` —— npm 页面上这张图是裂的。归档时要么把 `assets` 加进
  `files`，要么让 README 用绝对 URL。
