/**
 * dsh-siyuan — 客户端半场（浏览器 bundle）。
 *
 * 在 `settings.section` 槽位注册「思源笔记」设置页：思源地址、API token（只显示
 * 是否已配置）、默认笔记本、工具分组开关、连接测试。全部读写都走宿主半场的
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
.dsy-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.dsy-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}
.dsy-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base)}
.dsy-card > h3{font-size:13px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary)}
.dsy-row{display:flex;flex-direction:column;gap:4px}
.dsy-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsy-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsy-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:6px 9px;font-size:13px;line-height:18px;outline:none}
.dsy-input:focus{border-color:var(--dsw-alias-border-l2)}
.dsy-input[disabled]{opacity:.55;cursor:not-allowed}
.dsy-btn{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:999px;padding:3px 12px;font-size:12px;line-height:18px}
.dsy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dsy-btn:disabled{opacity:.5;cursor:not-allowed}
.dsy-btn.primary{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.dsy-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsy-check input{margin-top:2px}
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
.dsy-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
`;
		const tagId = "dsh-siyuan/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-siyuan";
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
		const GROUP_LABELS = {
			read: "只读工具：检索 / SQL / 读文档 / 列文档 / 看结构 / 读属性",
			write: "写入工具：新建文档 / 追加 / 插入 / 更新 / 设属性",
			daily: "日记工具：读取与追加日记",
			danger: "危险工具：删除内容块 / 删除整篇文档（默认关闭）"
		};
		const GROUP_ORDER = ["read", "write", "daily", "danger"];
		//#endregion

		function Message(props) {
			if (props.status === null) return null;
			return e("div", { className: "dsy-msg " + props.status.kind }, props.status.text);
		}

		/**
		 * 设置页主体。
		 * `props.initialDraft` 只给测试用：渲染替身不跑 useEffect，靠它注入表单状态。
		 * 宿主调用时是 e(SiYuanSection)，不带 props，行为与之前一致。
		 */
		function SiYuanSection(props) {
			const [state, setState] = useState(null);
			const [draft, setDraft] = useState((props && props.initialDraft) || null);
			const [notebooks, setNotebooks] = useState(null);
			const [tokenDraft, setTokenDraft] = useState("");
			const [status, setStatus] = useState(null);
			const [probe, setProbe] = useState(null);
			const [busy, setBusy] = useState(false);

			const load = useCallback(async () => {
				try {
					const value = await api("getState");
					setState(value);
					setDraft({ baseUrl: value.config.baseUrl, defaultNotebook: value.config.defaultNotebook, tools: { ...value.config.tools } });
				} catch (error) {
					setStatus({ kind: "err", text: "读取配置失败：" + error.message });
				}
			}, []);

			useEffect(() => {
				// React 契约：effect 只能返回清理函数或 undefined，返回 promise 会在 dev
				// 构建触发 "useEffect must not return anything besides a function" 控制台报错，
				// 生产行为未定义。"挂载即加载"不变；测试的可等待性由替身的 flushEffects
				// 排干微任务实现（见 test/client-harness-lib.mjs）。
				load();
			}, [load]);

			const patchDraft = (patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }));
			const patchTool = (key, value) =>
				setDraft((current) => (current === null ? current : { ...current, tools: { ...current.tools, [key]: value } }));
			const setAllTools = (value) =>
				setDraft((current) => {
					if (current === null) return current;
					const tools = {};
					for (const key of GROUP_ORDER) tools[key] = value;
					return { ...current, tools };
				});

			const run = async (label, fn) => {
				setBusy(true);
				setStatus(null);
				try {
					await fn();
				} catch (error) {
					setStatus({ kind: "err", text: label + "失败：" + error.message });
				} finally {
					setBusy(false);
				}
			};

			const saveConfig = () =>
				run("保存", async () => {
					const value = await api("updateConfig", draft);
					setState(value);
					setDraft({ baseUrl: value.config.baseUrl, defaultNotebook: value.config.defaultNotebook, tools: { ...value.config.tools } });
					setStatus({ kind: "ok", text: "已保存。" });
				});

			const testConnection = () =>
				run("连接测试", async () => {
					const result = await api("testConnection");
					setProbe(result);
					setStatus({ kind: result.ok ? "ok" : "err", text: result.ok ? "连接正常，思源版本 " + result.version + "。" : "有探测项失败，详见下方。" });
				});

			const loadNotebooks = () =>
				run("加载笔记本", async () => {
					const result = await api("listNotebooks");
					setNotebooks(result.notebooks);
					setStatus({ kind: "ok", text: "已加载 " + result.notebooks.length + " 个笔记本。" });
				});

			const saveToken = () =>
				run("保存 token", async () => {
					if (tokenDraft.trim() === "") throw new Error("token 为空");
					const value = await api("setToken", { token: tokenDraft });
					setState(value);
					setTokenDraft("");
					setStatus({ kind: "ok", text: "token 已存入宿主凭据库。" });
				});

			const clearToken = () =>
				run("清除 token", async () => {
					const value = await api("clearToken");
					setState(value);
					setStatus({ kind: "ok", text: "已清除 token。" });
				});

			if (state === null || draft === null) {
				return e("div", { className: "dsy-root" }, e("h2", { className: "dsy-title" }, "思源笔记"), e(Message, { status: status }), e("p", { className: "dsy-note" }, "正在读取配置…"));
			}

			const reachBadge = e(
				"span",
				{ className: "dsy-badge " + (state.reachable ? "ok" : "err") },
				state.reachable ? "可达 · v" + (state.version || "?") : "不可达"
			);
			const tokenBadge = e(
				"span",
				{ className: "dsy-badge " + (state.token.configured ? "ok" : "") },
				state.token.configured ? "已配置" + (state.token.source ? "（" + state.token.source + "）" : "") + (state.token.writable ? "" : " · 只读") : "未配置"
			);
			const notebookOptions = [{ id: "", name: "（未设置 · 工具调用时必须显式传 notebook）" }].concat(notebooks === null ? [] : notebooks.map((nb) => ({ id: nb.id, name: (nb.closed ? "[已关闭] " : "") + nb.name + " · " + nb.id })));
			const selectedNotebookKnown = notebookOptions.some((option) => option.id === draft.defaultNotebook);
			// 已启用的工具数按「宿主给的每组清单 × 表单当前勾选」现算。
			// 不能显示 state.toolNames.length —— 那是全部定义，与开关无关，关掉分组也还是 17。
			// 用 draft 而不是已落盘的 state.config：勾选框读的也是 draft，点保存前就能实时对上。
			const toolNames = Array.isArray(state.toolNames) ? state.toolNames : [];
			const enabledToolCount = toolNames.filter((entry) => draft.tools[entry.group] === true).length;

			return e(
				"div",
				{ className: "dsy-root" },
				e("h2", { className: "dsy-title" }, "思源笔记"),
				e("p", { className: "dsy-note" }, "把思源笔记接入 dsh：设置页负责连接与工具开关，模型侧通过 siyuan_* 工具检索、读取与写入。token 存在宿主凭据库（SIYUAN_TOKEN），页面不会回显它的值。"),
				e(Message, { status: status }),

				// 连接
				e(
					"div",
					{ className: "dsy-card" },
					e("div", { className: "dsy-inline" }, e("h3", null, "连接"), reachBadge, tokenBadge),
					e(
						"div",
						{ className: "dsy-row" },
						e("label", { className: "dsy-label" }, "思源地址（API base URL）"),
						e("input", {
							className: "dsy-input",
							type: "text",
							value: draft.baseUrl,
							placeholder: "http://127.0.0.1:6806",
							onChange: (event) => patchDraft({ baseUrl: event.target.value })
						}),
						e("p", { className: "dsy-note" }, "宿主是以 dsh 进程所在机器的视角访问它的；默认 127.0.0.1:6806 即本机思源。")
					),
					e(
						"div",
						{ className: "dsy-row" },
						e("label", { className: "dsy-label" }, "API token"),
						e(
							"div",
							{ className: "dsy-inline" },
							e("input", {
								className: "dsy-input",
								type: "password",
								style: { flex: "1 1 220px" },
								value: tokenDraft,
								placeholder: "思源 → 设置 → 关于 → API token",
								disabled: state.token.writable !== true,
								onChange: (event) => setTokenDraft(event.target.value)
							}),
							e("button", { className: "dsy-btn primary", type: "button", disabled: busy || state.token.writable !== true, onClick: saveToken }, "保存 token"),
							e("button", { className: "dsy-btn", type: "button", disabled: busy || state.token.configured !== true || state.token.writable !== true, onClick: clearToken }, "清除")
						),
						state.token.writable !== true
							? e("p", { className: "dsy-note" }, "当前 token 来自只读来源（环境变量或部署配置），无法在此覆盖。")
							: e("p", { className: "dsy-note" }, "保存后会写到宿主凭据库；轮换 token 无需重启。")
					),
					e(
						"div",
						{ className: "dsy-inline" },
						e("button", { className: "dsy-btn primary", type: "button", disabled: busy, onClick: saveConfig }, "保存设置"),
						e("button", { className: "dsy-btn", type: "button", disabled: busy, onClick: testConnection }, "测试连接"),
						e("button", { className: "dsy-btn", type: "button", disabled: busy, onClick: load }, "重新读取")
					),
					probe === null
						? null
						: e(
								"div",
								{ className: "dsy-probes" },
								probe.probes.map((item, index) =>
									e(
										"div",
										{ className: "dsy-probe", key: "probe-" + index },
										e("span", { className: "name" }, (item.ok ? "✓ " : "✗ ") + item.label),
										e("span", { className: "detail" }, item.detail)
									)
								)
							)
				),

				// 默认笔记本
				e(
					"div",
					{ className: "dsy-card" },
					e("div", { className: "dsy-inline" }, e("h3", null, "默认笔记本"), e("button", { className: "dsy-btn", type: "button", disabled: busy, onClick: loadNotebooks }, notebooks === null ? "加载笔记本" : "刷新笔记本")),
					e(
						"select",
						{
							className: "dsy-input",
							value: draft.defaultNotebook,
							onChange: (event) => patchDraft({ defaultNotebook: event.target.value })
						},
						selectedNotebookKnown ? null : e("option", { value: draft.defaultNotebook }, draft.defaultNotebook + "（不在当前列表中）"),
						notebookOptions.map((option) => e("option", { key: "nb-" + option.id, value: option.id }, option.name))
					),
					e("p", { className: "dsy-note" }, "写入、日记与按路径列文档会用它；工具调用里也可以显式传 notebook 覆盖。")
				),

				// 工具开关
				e(
					"div",
					{ className: "dsy-card" },
					e("div", { className: "dsy-inline" }, e("h3", null, "工具开关"), e("button", { className: "dsy-btn", type: "button", disabled: busy, onClick: () => setAllTools(false) }, "全关"), e("button", { className: "dsy-btn", type: "button", disabled: busy, onClick: () => setAllTools(true) }, "全开")),
					GROUP_ORDER.map((key) =>
						e(
							"label",
							{ className: "dsy-check", key: "tool-" + key },
							e("input", {
								type: "checkbox",
								checked: draft.tools[key] === true,
								onChange: (event) => patchTool(key, event.target.checked)
							}),
							e("span", null, GROUP_LABELS[key])
						)
					),
					e("p", { className: "dsy-note" }, "改动在「保存设置」后即时生效：工具会按开关重新注册，不需要重启 dsh。已启用 " + enabledToolCount + " / 共 " + toolNames.length + " 个工具定义。")
				)
			);
		}

		//#region plugin
		const inject = ["slots"];
		function apply(ctx) {
			// `inject = ["slots"]` 保证服务已就绪；直接读 ctx.slots，兼容只暴露 get() 的场景。
			const slots = ctx.slots ?? (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
			if (slots === undefined) return;
			slots.inject("settings.section", () =>
				slots.register({ name: "settings.section", id: "siyuan", order: 40, label: "思源笔记" }, SiYuanSection)
			);
		}
		exports.inject = inject;
		exports.apply = apply;
		//#endregion

		return module.exports;
	}
});
