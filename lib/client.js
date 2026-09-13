/**
 * dsh-siyuan — 客户端半场（浏览器 bundle）。
 *
 * 在 `settings.section` 槽位注册「思源笔记」设置页：连接（地址 + 探测）、API token（只显示
 * 是否已配置）、默认笔记本、逐工具开关（四张卡各自保存）。全部读写都走宿主半场的
 * /siyuan/api/* 路由；token 由宿主存入 dsh 凭据库，页面永不回显。
 *
 * 本文件不经打包器：浏览器模块加载器提供 `react`，用 React.createElement 手写。
 */
// 注意：这个 id 必须与 package.json 的 name 完全一致（client-modules 按包名找注册），
// 改名时 package.json / cordis.patch.yml 的 insert name / 这里的 id 三处要一起改。
window.__ModuleLoader__.load({
	id: "@yoursc/dsh-siyuan",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const e = React.createElement;
		const { useCallback, useEffect, useState } = React;

		//#region css
		const css = `
.dsy-root{display:flex;flex-direction:column;gap:14px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsy-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}
.dsy-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base)}
.dsy-card > h3{font-size:13px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary)}
.dsy-row{display:flex;flex-direction:column;gap:4px}
.dsy-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsy-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsy-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsy-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:6px 9px;font-size:13px;line-height:18px;outline:none}
.dsy-input:focus{border-color:var(--dsw-alias-border-l2)}
.dsy-input[disabled]{opacity:.55;cursor:not-allowed}
.dsy-btn{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:999px;padding:3px 12px;font-size:12px;line-height:18px}
.dsy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dsy-btn:disabled{opacity:.5;cursor:not-allowed}
.dsy-btn.primary{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.dsy-badge{font-size:11px;line-height:16px;border-radius:999px;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.dsy-badge.ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));border-color:currentColor}
.dsy-badge.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.dsy-msg{font-size:12px;line-height:18px}
.dsy-msg.err{color:var(--dsw-alias-state-error-primary)}
.dsy-msg.ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.dsy-probes{display:flex;flex-direction:column;gap:4px;font:var(--dsw-font-markdown-code-block-small,12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dsy-probe{display:flex;gap:8px;align-items:baseline}
.dsy-probe .name{flex:none;color:var(--dsw-alias-label-secondary)}
.dsy-probe .detail{min-width:0;word-break:break-word;color:var(--dsw-alias-label-tertiary)}
.dsy-switch{position:relative;display:inline-block;flex:none;width:34px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l4);cursor:pointer;transition:background .15s ease}
.dsy-switch .dsy-switch-knob{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.dsy-switch.on{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary))}
.dsy-switch.on .dsy-switch-knob{transform:translateX(14px)}
.dsy-switch.mixed .dsy-switch-knob{transform:translateX(7px)}
.dsy-switch:disabled{opacity:.5;cursor:not-allowed}
.dsy-switch.master{width:42px;height:24px}
/* 组总开关换个色：逐工具开关是主题蓝(business)，组开关用绿色，扫一眼就能分出"这一行管整组"。
   想换别的：这里换成 --dsw-alias-state-warn-primary（琥珀）或 --dsw-alias-label-primary（黑白）即可。 */
.dsy-switch.master.on{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}
.dsy-switch.master .dsy-switch-knob{width:18px;height:18px}
/* 危险组的总开关 ON 用琥珀：与红标题同框不刺眼，也与其余组的绿区分开。 */
.dsy-switch.master.dsy-tone-danger.on{background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary))}
.dsy-switch.master.on .dsy-switch-knob{transform:translateX(18px)}
.dsy-switch.master.mixed .dsy-switch-knob{transform:translateX(9px)}
.dsy-switch-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsy-groups{display:flex;flex-direction:column;gap:10px}
.dsy-group{display:flex;flex-direction:column;gap:6px}
.dsy-group + .dsy-group{border-top:.5px solid var(--dsw-alias-border-l1);padding-top:10px}
.dsy-group-head{display:flex;align-items:center;gap:8px}
.dsy-group-head h4{flex:none;margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsy-group-head h4.dsy-danger{color:var(--dsw-alias-state-error-primary)}
.dsy-group-meta{margin-left:auto;display:flex;align-items:center;gap:6px}
.dsy-count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
/* 开关统一住在行首的固定宽度槽位里：组总开关(42)与逐工具开关(34)左对齐，
   后面的文字自然排成同一列。 */
.dsy-switch-slot{flex:none;display:flex;align-items:center;width:42px}
/* 组说明行与组名/工具名同列（缩进 = 槽位 42 + gap 8）。 */
.dsy-group-hint{padding-left:50px}
/* 整行可点：hover 底纹告诉用户"这一整行都能按"，行间细线帮 17 行不串行。 */
.dsy-tool{display:flex;align-items:center;gap:10px;padding:3px 0;border-radius:8px;cursor:pointer;transition:background .12s ease}
.dsy-tool + .dsy-tool{border-top:.5px solid var(--dsw-alias-border-l1)}
.dsy-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 高亮块上下那两条线一起隐掉，免得横线从高亮里穿过去 */
.dsy-tool:hover, .dsy-tool:hover + .dsy-tool{border-top-color:transparent}
.dsy-tool:focus-visible{outline:2px solid var(--dsw-alias-border-l2);outline-offset:2px}
.dsy-tool[aria-disabled="true"]{cursor:not-allowed;opacity:.6}
.dsy-tool-text{display:flex;flex-direction:column;min-width:0;flex:1}
.dsy-tool .name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsy-tool .desc{font:var(--dsw-font-markdown-code-block-small,12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-tertiary)}
.dsy-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px}
`;
		// 这个 id 必须与 __ModuleLoader__.load({ id }) 一致：client-hmr 重载时会删掉
		// style[data-plugin=<模块 id>] 再重放，写裸名的话旧样式永远删不掉（改了 CSS 却
		// 一直是旧样式，只能整页刷新）。`data-plugin-css` 只用于同页去重。
		const tagId = "@yoursc/dsh-siyuan/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@yoursc/dsh-siyuan";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api
		/** api() 的兜底超时：宿主侧最坏路径（连接测试三条探测并发 ~8s）也在其内。 */
		const API_TIMEOUT_MS = 15000;
		/** 调用宿主半场的设置页路由；宿主用 {ok,value|error} 信封，HTTP 状态不表达成败。 */
		async function api(method, body) {
			// 兜底超时，页面不无限转圈。AbortSignal.timeout 不可用（旧浏览器）时保持
			// 原行为（无超时）。
			const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
				? AbortSignal.timeout(API_TIMEOUT_MS)
				: undefined;
			let response;
			try {
				response = await fetch("/siyuan/api/" + method, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body ?? {}),
					signal
				});
			} catch (error) {
				// AbortSignal.timeout 超时抛的是 TimeoutError；给可读文案而不是裸的浏览器原文。
				if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
					throw new Error("请求超时（" + API_TIMEOUT_MS / 1000 + " 秒），宿主没有响应");
				}
				throw error;
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (payload === null || typeof payload !== "object") throw new Error("宿主没有返回 JSON（HTTP " + response.status + "）");
			if (payload.ok !== true) throw new Error((payload.error && payload.error.message) || ("HTTP " + response.status));
			return payload.value;
		}
		//#endregion

		//#region 文案
		const GROUP_ORDER = ["read", "write", "daily", "danger"];
		const GROUP_LABELS = { read: "只读", write: "写入", daily: "日记", danger: "危险" };
		const GROUP_HINTS = {
			read: "检索、SQL、读文档、看结构：不修改笔记库",
			write: "新建文档、追加、插入、更新、改属性：会真实写入笔记库",
			daily: "读取与追加日记（按笔记本的 dailyNoteSavePath 建当天日记）",
			danger: "删除内容块 / 整篇文档：默认关闭，建议只在该用时临时打开"
		};
		/**
		 * 工具名的中文短标签。**没收录的工具回落到显示原名**，所以宿主新增工具时
		 * 这里不会把它藏起来（只是暂时没有中文说明）。
		 */
		const TOOL_LABELS = {
			siyuan_list_notebooks: "列出笔记本",
			siyuan_search: "全文检索",
			siyuan_sql: "执行 SQL 查询",
			siyuan_read_doc: "读文档",
			siyuan_list_docs: "列子文档",
			siyuan_get_child_blocks: "看块结构",
			siyuan_get_block_attrs: "读块属性",
			siyuan_create_doc: "新建文档",
			siyuan_append_block: "追加到文档末尾",
			siyuan_insert_block: "在某块之后插入",
			siyuan_update_block: "覆盖块内容",
			siyuan_set_block_attrs: "设置块属性",
			siyuan_move_doc: "移动文档",
			siyuan_rename_doc: "重命名文档",
			siyuan_daily_note: "读写日记",
			siyuan_delete_block: "删除内容块",
			siyuan_remove_doc: "删除整篇文档"
		};
		//#endregion

		//#region 展示件（都不带状态：hooks 只住在 SiYuanSection 里）
		function Message(props) {
			if (props.status === null || props.status === undefined) return null;
			return e("div", { className: "dsy-msg " + props.status.kind }, props.status.text);
		}

		function Note(props) {
			return e("p", { className: "dsy-note" }, props.children);
		}

		function Btn(props) {
			return e(
				"button",
				{
					type: "button",
					className: "dsy-btn" + (props.primary === true ? " primary" : ""),
					disabled: props.disabled === true,
					onClick: props.onClick
				},
				props.label
			);
		}

		/** 卡片：标题行（右侧可放按钮/徽标）+ 卡内消息 + 内容。 */
		function Card(props) {
			return e(
				"div",
				{ className: "dsy-card" },
				e("div", { className: "dsy-inline" }, e("h3", null, props.title), props.header),
				e(Message, { status: props.status }),
				props.children
			);
		}

		/**
		 * 椭圆开关（轨道 + 小球）。用 `button[role=switch]` 而不是 `input[type=checkbox]`：
		 * 圆角轨道得自己画，原生 checkbox 的外观各浏览器不可控；`aria-checked` 还能表达
		 * "mixed"——分组里只开了一部分工具时组开关就是这个状态。
		 */
		function Switch(props) {
			// master：分组总开关的变体——比逐工具的小开关更大（CSS 里放大），
			// 让人一眼看出"这是整组，不是某一个工具"。tone：整组的色调（危险组用琥珀）。
			const className =
				"dsy-switch" +
				(props.master === true ? " master" : "") +
				(props.tone === "danger" ? " dsy-tone-danger" : "") +
				(props.checked === true ? " on" : props.mixed === true ? " mixed" : "");
			return e(
				"button",
				{
					type: "button",
					role: "switch",
					"aria-checked": props.mixed === true ? "mixed" : props.checked === true,
					"aria-label": props.label,
					className: className,
					disabled: props.disabled === true,
					onClick: props.onToggle
				},
				e("span", { className: "dsy-switch-knob" })
			);
		}

		/** 探测明细。宿主回报的 baseUrl 一起显示：让用户看出测的是哪个地址。 */
		function ProbeList(props) {
			const probes = Array.isArray(props.probe.probes) ? props.probe.probes : [];
			return e(
				"div",
				{ className: "dsy-probes" },
				typeof props.probe.baseUrl === "string" && props.probe.baseUrl !== "" ? e(Note, null, "探测地址：" + props.probe.baseUrl) : null,
				probes.map((item, index) =>
					e(
						"div",
						{ className: "dsy-probe", key: "probe-" + index },
						e("span", { className: "name" }, (item.ok ? "✓ " : "✗ ") + item.label),
						e("span", { className: "detail" }, item.detail)
					)
				)
			);
		}

		/**
		 * 纯展示的开关轨道（轨道 + 小球），不带任何交互。
		 * 逐工具行是**整行可点**的（行本身带 `role="switch"`），所以轨道不能再是一个 button
		 * ——按钮里套按钮是非法 HTML，还会让一次点击被处理两遍。
		 */
		function SwitchTrack(props) {
			const className = "dsy-switch" + (props.checked === true ? " on" : props.mixed === true ? " mixed" : "");
			return e("span", { className: className }, e("span", { className: "dsy-switch-knob" }));
		}

		/** 宿主 state.tools → 表单草稿 `{ 工具名: 是否启用 }`。 */
		function toolsDraftFromState(state) {
			const tools = {};
			for (const entry of Array.isArray(state?.tools) ? state.tools : []) tools[entry.name] = entry.enabled === true;
			return tools;
		}

		/** 表单草稿的初值：地址 / 默认笔记本 / 逐工具开关。 */
		function draftFromState(state) {
			return { baseUrl: state.config.baseUrl, defaultNotebook: state.config.defaultNotebook, tools: toolsDraftFromState(state) };
		}
		//#endregion

		//#region 设置页
		/**
		 * 设置页主体。
		 *
		 * 交互约定（都是"操作落在被改的东西旁边"）：
		 * - 四张卡各自保存：连接（地址）、API token、默认笔记本、工具开关。**只提交本卡字段**，
		 *   宿主 updateConfig 本来就接受部分字段，所以保存笔记本不会顺手把地址也写一遍。
		 * - 每张卡有自己的 pending 与消息：一张卡在请求时不会把别的卡锁住，反馈也出现在操作旁边。
		 * - 「测试连接 / 加载笔记本」直接用卡里**正在编辑**的地址与 token（不必先保存），
		 *   否则"填了新地址没保存就点测试"测的是旧地址，结论会误导人。
		 * - 改动过但没保存的卡会显示「撤销」，底部固定一条"有未保存的改动"的提示。
		 *
		 * 外壳给的 `close` 用不上（本页没有会离开设置面板的动作），因此不接收 props。
		 */
		function SiYuanSection() {
			const [state, setState] = useState(null);
			const [draft, setDraft] = useState(null);
			const [notebooks, setNotebooks] = useState(null);
			const [tokenDraft, setTokenDraft] = useState("");
			const [messages, setMessages] = useState({});
			const [probe, setProbe] = useState(null);
			// 正在跑的动作 key（= 卡片名）：只锁那一张卡。
			const [pending, setPending] = useState(null);

			const load = useCallback(async () => {
				try {
					const value = await api("getState");
					setState(value);
					setDraft(draftFromState(value));
				} catch (error) {
					setMessages((current) => ({ ...current, connection: { kind: "err", text: "读取配置失败：" + error.message } }));
				}
			}, []);

			useEffect(() => {
				// React 契约：effect 只能返回清理函数或 undefined，返回 promise 会在 dev
				// 构建触发 "useEffect must not return anything besides a function" 控制台报错，
				// 生产行为未定义。"挂载即加载"不变；测试的可等待性由替身的 flushEffects
				// 排干微任务实现（见 test/client-harness-lib.mjs）。
				load();
			}, [load]);

			/**
			 * 打开设置页就顺手把笔记本列表拉回来（只在宿主报"可达"时、**静默**）。
			 * 否则配置过默认笔记本的人再进来只看得到一串光秃秃的 id——而且旧文案还会
			 * 谎称它"不在当前列表中"（列表压根没加载）。失败不写消息：用户没点这个按钮，
			 * 不该在卡片里留一条错误；他点「加载笔记本」时会看到真正的报错。
			 * 依赖只取 state/notebooks：draft 每次敲键都变，用它当依赖会反复发请求。
			 */
			useEffect(() => {
				if (state === null || draft === null || notebooks !== null || state.reachable !== true) return;
				let cancelled = false;
				api("listNotebooks", { baseUrl: draft.baseUrl, token: tokenDraft })
					.then((result) => {
						if (!cancelled) setNotebooks(result.notebooks);
					})
					.catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [state, notebooks]);

			const setMessage = (card, status) => setMessages((current) => ({ ...current, [card]: status }));

			const run = async (card, label, fn) => {
				setPending(card);
				setMessage(card, null);
				try {
					await fn();
				} catch (error) {
					setMessage(card, { kind: "err", text: label + "失败：" + error.message });
				} finally {
					setPending(null);
				}
			};

			/**
			 * 保存成功后只把**这张卡**的字段对齐到宿主返回的权威值：
			 * 整份草稿重置会把用户在其他卡里还没保存的改动一起抹掉。
			 */
			const applyState = (value, card) => {
				setState(value);
				setDraft((current) => {
					if (current === null) return draftFromState(value);
					if (card === "connection") return { ...current, baseUrl: value.config.baseUrl };
					if (card === "notebook") return { ...current, defaultNotebook: value.config.defaultNotebook };
					if (card === "tools") return { ...current, tools: toolsDraftFromState(value) };
					return current;
				});
			};

			const patchDraft = (patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }));
			/**
			 * 就地翻转一个工具。必须读**更新函数里的最新 draft**，不能用本次渲染闭包里的值：
			 * 同一帧内连点（或点完立刻敲空格）时，闭包里的值还是旧的，会连着写两次同一个结果。
			 */
			const flipTool = (name) =>
				setDraft((current) => (current === null ? current : { ...current, tools: { ...current.tools, [name]: current.tools[name] !== true } }));

			const saveConnection = () =>
				run("connection", "保存地址", async () => {
					const value = await api("updateConfig", { baseUrl: draft.baseUrl });
					applyState(value, "connection");
					setMessage("connection", { kind: "ok", text: "地址已保存。" });
				});

			const saveNotebook = () =>
				run("notebook", "保存笔记本", async () => {
					const value = await api("updateConfig", { defaultNotebook: draft.defaultNotebook });
					applyState(value, "notebook");
					setMessage("notebook", { kind: "ok", text: "默认笔记本已保存。" });
				});

			const saveTools = () =>
				run("tools", "保存开关", async () => {
					const value = await api("updateConfig", { tools: draft.tools });
					applyState(value, "tools");
					setMessage("tools", { kind: "ok", text: "工具开关已生效（不需要重启 dsh）。" });
				});

			const saveToken = () =>
				run("token", "保存 token", async () => {
					if (tokenDraft.trim() === "") throw new Error("token 为空");
					const value = await api("setToken", { token: tokenDraft });
					applyState(value, "token");
					setTokenDraft("");
					setMessage("token", { kind: "ok", text: "token 已存入宿主凭据库。" });
				});

			const clearToken = () =>
				run("token", "清除 token", async () => {
					const value = await api("clearToken");
					applyState(value, "token");
					setMessage("token", { kind: "ok", text: "已清除 token。" });
				});

			const testConnection = () =>
				run("connection", "连接测试", async () => {
					// 用草稿：填完地址/token 直接测，不必先保存。
					const result = await api("testConnection", { baseUrl: draft.baseUrl, token: tokenDraft });
					setProbe(result);
					setMessage("connection", { kind: result.ok ? "ok" : "err", text: result.ok ? "连接正常，思源版本 " + result.version + "。" : "有探测项失败，详见下方。" });
				});

			const loadNotebooks = () =>
				run("notebook", "加载笔记本", async () => {
					const result = await api("listNotebooks", { baseUrl: draft.baseUrl, token: tokenDraft });
					setNotebooks(result.notebooks);
					setMessage("notebook", { kind: "ok", text: "已加载 " + result.notebooks.length + " 个笔记本。" });
				});

			if (state === null || draft === null) {
				return e(
					"div",
					{ className: "dsy-root" },
					e(Message, { status: messages.connection }),
					e(Note, null, "正在读取配置…")
				);
			}

			const tools = Array.isArray(state.tools) ? state.tools : [];
			const enabledCount = tools.filter((entry) => draft.tools[entry.name] === true).length;
			// 脏值是"草稿 vs 宿主快照"的现算：保存按钮据此启用，不需要用户自己记住改过什么。
			const dirty = {
				connection: draft.baseUrl !== state.config.baseUrl,
				notebook: draft.defaultNotebook !== state.config.defaultNotebook,
				tools: tools.some((entry) => draft.tools[entry.name] !== entry.enabled)
			};
			const anyDirty = dirty.connection || dirty.notebook || dirty.tools;
			// 每张卡自己的"忙"标志：一张卡在请求时不该把别的卡也锁死。
			const busy = {
				connection: pending === "connection",
				token: pending === "token",
				notebook: pending === "notebook",
				tools: pending === "tools"
			};
			const revertTools = () => setDraft((current) => (current === null ? current : { ...current, tools: toolsDraftFromState(state) }));
			const setAllTools = (value) =>
				setDraft((current) => {
					if (current === null) return current;
					const next = {};
					for (const entry of tools) next[entry.name] = value;
					return { ...current, tools: next };
				});

			const reachBadge = e(
				"span",
				{ className: "dsy-badge " + (state.reachable ? "ok" : "err") },
				state.reachable ? "可达 · v" + (state.version || "?") : "不可达"
			);
			/**
			 * token 状态徽标。它**住在 API token 卡**（不是连接卡）：文案里写明主语，
			 * 否则「已配置（env）· 只读」挨着"可达"会让人以为是说这个连接只读。
			 */
			const tokenSourceText = state.token.source === "env" ? "来自环境变量" : state.token.source === "credentials" ? "存在 dsh 凭据库" : state.token.source === "" ? "" : "来源 " + state.token.source;
			const tokenBadge = e(
				"span",
				{ className: "dsy-badge " + (state.token.configured ? "ok" : "") },
				state.token.configured
					? "token 已配置" + (tokenSourceText === "" ? "" : " · " + tokenSourceText) + (state.token.writable ? " · 可在页面修改" : " · 页面不可改")
					: "token 未配置"
			);
			const notebookOptions = [{ id: "", name: "（未设置 · 工具调用时必须显式传 notebook）" }].concat(notebooks === null ? [] : notebooks.map((nb) => ({ id: nb.id, name: (nb.closed ? "[已关闭] " : "") + nb.name + " · " + nb.id })));
			const selectedNotebookKnown = notebookOptions.some((option) => option.id === draft.defaultNotebook);

			const groupSections = GROUP_ORDER.map((group) => {
				const groupTools = tools.filter((entry) => entry.group === group);
				if (groupTools.length === 0) return null;
				const onCount = groupTools.filter((entry) => draft.tools[entry.name] === true).length;
				return e(
					"div",
					{ className: "dsy-group", key: "group-" + group },
					e(
						"div",
						{ className: "dsy-group-head" },
						// 开关放在最前：控件要贴着人要读的那一行，甩到行尾离内容太远、容易点错。
						e(
							"span",
							{ className: "dsy-switch-slot" },
							e(Switch, {
								master: true,
								// 危险组：标题是红的，组开关 ON 也别用绿，换琥珀（否则红绿同框很跳）。
								tone: group === "danger" ? "danger" : undefined,
								label: GROUP_LABELS[group] + "整组开关",
								checked: onCount === groupTools.length,
								mixed: onCount > 0 && onCount < groupTools.length,
								disabled: busy.tools,
								onToggle: () => {
									const next = onCount !== groupTools.length;
									setDraft((current) => {
										if (current === null) return current;
										const tools = { ...current.tools };
										for (const entry of groupTools) tools[entry.name] = next;
										return { ...current, tools };
									});
								}
							})
						),
						e("h4", { className: group === "danger" ? "dsy-danger" : undefined }, GROUP_LABELS[group]),
						// 两个"组级"信息并到右簇：视线不用在组名和右边缘之间来回跳。
						e(
							"span",
							{ className: "dsy-group-meta" },
							e("span", { className: "dsy-switch-label" }, "整组"),
							e("span", { className: "dsy-count" }, onCount + "/" + groupTools.length)
						)
					),
					e("p", { className: "dsy-note dsy-group-hint" }, GROUP_HINTS[group]),
					groupTools.map((entry) => {
						const hasLabel = typeof TOOL_LABELS[entry.name] === "string";
						const label = hasLabel ? TOOL_LABELS[entry.name] : entry.name;
						const on = draft.tools[entry.name] === true;
						const toggle = () => flipTool(entry.name);
						return e(
							"div",
							{
								className: "dsy-tool",
								key: "tool-" + entry.name,
								// 整行就是开关：34×20 的小圆钮太难点，行内任何位置都能切（见 onClick）。
								role: "switch",
								"aria-checked": on,
								"aria-label": label + "（" + entry.name + "）",
								"aria-disabled": busy.tools === true ? true : undefined,
								tabIndex: busy.tools === true ? -1 : 0,
								onClick: (event) => {
									// 拖选文字不该顺手切换开关：选区落在这一行里就放行默认行为。
									const selection = typeof window === "undefined" || typeof window.getSelection !== "function" ? null : window.getSelection();
									if (selection !== null && selection.isCollapsed !== true && typeof selection.containsNode === "function" && selection.containsNode(event.currentTarget, true)) return;
									if (busy.tools === true) return;
									toggle();
								},
								onKeyDown: (event) => {
									if (event.key !== " " && event.key !== "Enter") return;
									event.preventDefault();
									if (busy.tools === true) return;
									toggle();
								}
							},
							e("span", { className: "dsy-switch-slot" }, e(SwitchTrack, { checked: on })),
							e(
								"div",
								{ className: "dsy-tool-text" },
								// 中文（人读的）在上、工具名（模型读的）在下；没收录中文时只留工具名一行。
								e("div", { className: "name" }, label),
								hasLabel ? e("div", { className: "desc" }, entry.name) : null
							)
						);
					})
				);
			});

			return e(
				"div",
				{ className: "dsy-root" },
				// ── 连接 ──
				e(
					Card,
					{ title: "连接", status: messages.connection, header: reachBadge },
					e(
						"div",
						{ className: "dsy-row" },
						e("label", { className: "dsy-label", htmlFor: "dsy-base-url" }, "思源地址（API base URL）"),
						e("input", {
							id: "dsy-base-url",
							className: "dsy-input",
							type: "text",
							value: draft.baseUrl,
							placeholder: "http://127.0.0.1:6806",
							disabled: busy.connection,
							onChange: (event) => patchDraft({ baseUrl: event.target.value })
						}),
						e(Note, null, "以 dsh 进程所在机器的视角访问它；默认 127.0.0.1:6806 即本机思源。")
					),
					e(
						"div",
						{ className: "dsy-actions" },
						e(Btn, { label: "保存地址", primary: true, disabled: busy.connection || !dirty.connection, onClick: saveConnection }),
						e(Btn, { label: "测试连接", disabled: busy.connection, onClick: testConnection }),
						dirty.connection ? e(Btn, { label: "撤销", disabled: busy.connection, onClick: () => patchDraft({ baseUrl: state.config.baseUrl }) }) : null
					),
					e(Note, null, dirty.connection ? "地址有未保存的改动；「测试连接」用的就是上面这个地址。" : "「测试连接」直接用上面这个地址探测，不必先保存。"),
					probe === null ? null : e(ProbeList, { probe })
				),

				// ── API token ──
				e(
					Card,
					{ title: "API token", status: messages.token, header: tokenBadge },
					e(
						"div",
						{ className: "dsy-row" },
						e("label", { className: "dsy-label", htmlFor: "dsy-token" }, "API token"),
						e(
							"div",
							{ className: "dsy-inline" },
							e("input", {
								id: "dsy-token",
								className: "dsy-input",
								type: "password",
								style: { flex: "1 1 220px" },
								value: tokenDraft,
								placeholder: "思源 → 设置 → 关于 → API token",
								disabled: busy.token || state.token.writable !== true,
								onChange: (event) => setTokenDraft(event.target.value)
							}),
							e(Btn, { label: "保存 token", primary: true, disabled: busy.token || state.token.writable !== true, onClick: saveToken }),
							e(Btn, { label: "清除", disabled: busy.token || state.token.configured !== true || state.token.writable !== true, onClick: clearToken })
						),
						state.token.writable !== true
							? e(Note, null, "当前 token 来自只读来源（环境变量或部署配置），页面无法覆盖。想改成在页面里管理：去掉 dsh web 的 SIYUAN_TOKEN 环境变量后重启，再在这里保存。")
							: e(Note, null, "保存后写入宿主凭据库；轮换 token 无需重启。「测试连接」也会用这里刚填的 token。")
					)
				),

				// ── 默认笔记本 ──
				e(
					Card,
					{
						title: "默认笔记本",
						status: messages.notebook,
						header: e(
							"div",
							{ className: "dsy-actions" },
							e(Btn, { label: notebooks === null ? "加载笔记本" : "刷新笔记本", disabled: busy.notebook, onClick: loadNotebooks }),
							e(Btn, { label: "保存笔记本", primary: true, disabled: busy.notebook || !dirty.notebook, onClick: saveNotebook }),
							dirty.notebook ? e(Btn, { label: "撤销", disabled: busy.notebook, onClick: () => patchDraft({ defaultNotebook: state.config.defaultNotebook }) }) : null
						)
					},
					e(
						"div",
						{ className: "dsy-row" },
						e("label", { className: "dsy-label", htmlFor: "dsy-notebook" }, "写入 / 日记 / 列文档默认用它"),
						e(
							"select",
							{
								id: "dsy-notebook",
								className: "dsy-input",
								value: draft.defaultNotebook,
								disabled: busy.notebook,
								onChange: (event) => patchDraft({ defaultNotebook: event.target.value })
							},
							selectedNotebookKnown
								? null
								: e(
										"option",
										{ value: draft.defaultNotebook },
										// 列表没加载时不能断言"不在列表里"——那是没根据的结论。
										notebooks === null
											? draft.defaultNotebook + "（已保存 · 点「加载笔记本」显示名称）"
											: draft.defaultNotebook + "（不在当前列表中）"
									),
							notebookOptions.map((option) => e("option", { key: "nb-" + option.id, value: option.id }, option.name))
						),
						e(Note, null, "工具调用里也可以显式传 notebook 覆盖它。")
					)
				),

				// ── 工具开关 ──
				e(
					Card,
					{
						title: "工具开关",
						status: messages.tools,
						header: e("span", { className: "dsy-note" }, "已启用 " + enabledCount + " / 共 " + tools.length + " 个")
					},
					e("div", { className: "dsy-groups" }, groupSections),
					// 清单为空 = 宿主没回 tools 数组（旧宿主 / 插件没挂上）。升级后忘了重启 dsh web
					// 就是这种画面：给一句可执行的提示，而不是一张空卡。
					tools.length === 0 ? e(Note, null, "宿主没有返回工具清单。如果你刚升级过插件，请重启 dsh web（工具清单是这个版本新增的）。") : null,
					e(
						"div",
						{ className: "dsy-actions" },
						e(Btn, { label: "保存开关", primary: true, disabled: busy.tools || !dirty.tools, onClick: saveTools }),
						e(Btn, { label: "全部停用", disabled: busy.tools || enabledCount === 0, onClick: () => setAllTools(false) }),
						dirty.tools ? e(Btn, { label: "撤销", disabled: busy.tools, onClick: revertTools }) : null
					),
					e(Note, null, "改动在「保存开关」后即时生效（工具会重新注册，不需要重启 dsh）。")
				),

				// ── 页脚 ──
				e(
					"div",
					{ className: "dsy-footer" },
					e(Btn, { label: "重新读取", disabled: pending !== null, onClick: () => run("connection", "重新读取", load) }),
					e(Note, null, anyDirty ? "有未保存的改动，「重新读取」会丢弃它们。" : "所有改动都已保存。")
				)
			);
		}
		//#endregion

		//#region 导航图标
		/**
		 * 设置面板左侧导航的小图标由 DSH 外壳硬编码：`navIcon(id)` 只给内置的
		 * `models` / `agent-presets` / `plugins` 配了图形，其余分区（含本插件的 `siyuan`）
		 * 一律回退成齿轮；`settings.section` 槽位也没有 icon 选项
		 * （见 @deepseek-ai/dsh-client-ui-settings-general/lib/client.js，上游 Discussion #4502）。
		 *
		 * 所以这里在设置面板挂载后，把「思源笔记」那一行的齿轮换成思源官方 logo 的单色版。
		 * 这是**依赖外壳 DOM 的兜底**：外壳哪天提供图标 API（或改了导航结构），这段就该删掉，
		 * 失效时的表现只是退回齿轮，不影响设置页功能。
		 */
		/** 导航行文案：注册与图标替换共用一处，避免同一串字写死两次。 */
		const SECTION_LABEL = "思源笔记";
		/**
		 * 思源官方 logo（siyuan-note/siyuan 仓库的 app/src/assets/icon.svg）单色版：
		 * 原图红色 + 深灰两色，这里统一用 currentColor（深浅色主题自适应），
		 * 原本深灰的两段用 fill-opacity 保留 logo 的前后层次（想全平涂就把它调成 1）。
		 */
		const NAV_ICON_VIEW_BOX = "0 0 1024 1024";
		const NAV_ICON_PATHS = [
			{ d: "M37.052 371.676l269.857-269.857v550.507l-269.857 269.857z", opacity: 1 },
			{ d: "M306.909 101.818l205.091 205.091v550.507l-205.091-205.091z", opacity: 0.55 },
			{ d: "M512 306.909l205.091-205.091v550.507l-205.091 205.091z", opacity: 1 },
			{ d: "M717.091 101.818l269.857 269.857v550.507l-269.857-269.857z", opacity: 0.55 }
		];
		const SVG_NS = "http://www.w3.org/2000/svg";

		/**
		 * 把一行导航按钮里的齿轮换成我们的图标。
		 * 外壳不给导航行绑 id，区分行的唯一抓手是文案；不假定文案 span 是第几个
		 * （外壳哪天在行里加个角标 span 也不会误判成别的行）。
		 * 用 `replaceWith` 换掉整根 svg，而不是改原 svg 的子节点：React 手里仍握着那个 svg 的
		 * 引用，换掉后它对旧节点的任何操作都落在游离节点上，不会在卸载时 removeChild 抛错。
		 * @param cell - 导航行（`nav button`）
		 * @param doc - 文档对象（注入以便测试）
		 * @returns 是否真的换了（不是我们的行 / 已经换过 → false）
		 */
		function patchNavCell(cell, doc) {
			if (typeof cell.querySelectorAll !== "function" || typeof cell.querySelector !== "function") return false;
			const isOurs = Array.from(cell.querySelectorAll("span")).some((span) => String(span.textContent).trim() === SECTION_LABEL);
			if (!isOurs) return false;
			const current = cell.querySelector("svg");
			if (current === null || current.getAttribute("data-dsy-icon") === "siyuan") return false;
			const icon = doc.createElementNS(SVG_NS, "svg");
			icon.setAttribute("data-dsy-icon", "siyuan");
			icon.setAttribute("viewBox", NAV_ICON_VIEW_BOX);
			icon.setAttribute("width", "16");
			icon.setAttribute("height", "16");
			icon.setAttribute("fill", "currentColor");
			icon.setAttribute("aria-hidden", "true");
			// class 由外壳生成（带哈希），只能抄不能写死：尺寸、对齐与颜色令牌都挂在它上面。
			const className = current.getAttribute("class");
			if (className !== null) icon.setAttribute("class", className);
			for (const path of NAV_ICON_PATHS) {
				const shape = doc.createElementNS(SVG_NS, "path");
				shape.setAttribute("d", path.d);
				if (path.opacity !== 1) shape.setAttribute("fill-opacity", String(path.opacity));
				icon.appendChild(shape);
			}
			current.replaceWith(icon);
			return true;
		}

		/**
		 * 盯着设置面板的出现与重渲，顺手把齿轮换掉。
		 * 面板关闭时整棵 nav 会被移除，没法只盯 nav，所以观察 body 的 childList；一帧内的多次
		 * 变更用 rAF 合并成一次 `querySelectorAll`——对话流式输出时 DOM 变更很密，这个合并是必要的。
		 * @param doc - 文档对象；不可用时返回空卸载函数
		 * @returns 断开观察的卸载函数
		 */
		function watchNavIcon(doc) {
			if (doc === undefined || typeof doc.querySelectorAll !== "function" || doc.body === undefined || doc.body === null) return () => {};
			let scheduled = false;
			const patch = () => {
				scheduled = false;
				for (const cell of doc.querySelectorAll("nav button")) patchNavCell(cell, doc);
			};
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(patch);
				else Promise.resolve().then(patch);
			};
			let disconnect = () => {};
			if (typeof MutationObserver === "function") {
				const observer = new MutationObserver(schedule);
				observer.observe(doc.body, { childList: true, subtree: true });
				disconnect = () => observer.disconnect();
			}
			schedule();
			return disconnect;
		}
		//#endregion

		//#region plugin
		const inject = ["slots"];
		function apply(ctx) {
			// `inject = ["slots"]` 保证服务已就绪；直接读 ctx.slots，兼容只暴露 get() 的场景。
			const slots = ctx.slots ?? (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
			if (slots === undefined) return;
			slots.inject("settings.section", () =>
				slots.register({ name: "settings.section", id: "siyuan", order: 40, label: SECTION_LABEL }, SiYuanSection)
			);
			// 导航图标兜底。挂在 ctx.effect 上，插件卸载/热重载时断开观察（测试替身没有 effect 就直接装）。
			const documentObject = typeof document === "undefined" ? undefined : document;
			if (typeof ctx.effect === "function") ctx.effect(() => watchNavIcon(documentObject), "dsh-siyuan: 设置面板导航图标");
			else watchNavIcon(documentObject);
		}
		exports.inject = inject;
		exports.apply = apply;
		/** 客户端测试入口（宿主半场同等暴露 `internals` 是既有约定）。 */
		exports.internals = { SECTION_LABEL, NAV_ICON_VIEW_BOX, NAV_ICON_PATHS, patchNavCell, watchNavIcon, TOOL_LABELS };
		//#endregion

		return module.exports;
	}
});
