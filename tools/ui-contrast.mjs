#!/usr/bin/env node
/**
 * UI 对比度审计（opt-in，**不在 `npm test` 里**）
 *
 * 为什么住在 tools/ 而不是 test/：本项目测试的「三不」是自包含（不联网、不碰真实实例、
 * 不读环境变量）。本脚本必须读宿主 dsh 安装目录里的主题文件（@deepseek-ai/dsh-client-ui-theme）
 * 才能拿到设计 token 的真实色值，天然依赖本机安装，所以它是**开发者审计工具**，不是测试。
 *
 * 它覆盖「没有浏览器就验不了 UI」里**唯一能客观量化的那一半**：颜色对比度。
 * 它**不能**验证布局、间距、溢出、hover 视觉、真实排版 —— 那些只能靠真实渲染，
 * 见 docs/ui-design.md「验证方法」一节。
 *
 * 用法：
 *   node tools/ui-contrast.mjs                     # 自动探测 dsh 安装位置
 *   node tools/ui-contrast.mjs --dsh /path/to/dsh  # 显式指定
 *   node tools/ui-contrast.mjs --json              # 机读输出
 *   node tools/ui-contrast.mjs --all               # 连同「宿主参照」行一起计入失败数
 *
 * 退出码：有**插件缺陷**（kind=plugin）失败时为 1，否则 0。
 * 标着「宿主参照」的行（kind=reference）只报数不判fail —— 见文件末的分类说明。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// ── 定位宿主主题文件 ────────────────────────────────────────────────
function findThemeFile(explicit) {
	const require = createRequire(import.meta.url);
	const candidates = [];
	const rel = "node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js";
	if (explicit !== undefined) candidates.push(path.join(explicit, rel));
	try {
		candidates.push(require.resolve("@deepseek-ai/dsh-client-ui-theme/lib/client.js"));
	} catch {}
	candidates.push("/usr/local/lib/node_modules/@deepseek-ai/dsh/" + rel);
	try {
		const dshPkg = require.resolve("@deepseek-ai/dsh/package.json");
		candidates.push(path.join(path.dirname(dshPkg), rel));
	} catch {}
	for (const candidate of candidates) {
		if (candidate !== undefined && fs.existsSync(candidate)) return candidate;
	}
	console.error("找不到宿主主题文件。用 `--dsh <dsh 安装目录>` 显式指定。");
	console.error("试过：\n  " + candidates.filter(Boolean).join("\n  "));
	process.exit(2);
}

/** 从主题文件向上走，找到名为 @deepseek-ai/dsh 的 package.json。 */
function findDshVersion(themeFile) {
	let dir = path.dirname(themeFile);
	for (let i = 0; i < 8; i += 1) {
		const candidate = path.join(dir, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
			if (pkg.name === "@deepseek-ai/dsh") return pkg.version ?? "?";
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "?";
}

// ── 解析 CSS 变量（宿主的 alias → static 两层） ──────────────────────
function parseThemes(source) {
	const blocks = [];
	const re = /(body(?:\[data-ds-dark-theme\])?)\s*\{([^{}]*)\}/g;
	let match;
	while ((match = re.exec(source)) !== null) {
		if (!match[2].includes("--dsw-")) continue;
		const map = {};
		for (const decl of match[2].split(";")) {
			const colon = decl.indexOf(":");
			if (colon < 0) continue;
			const key = decl.slice(0, colon).trim();
			if (key.startsWith("--dsw-")) map[key] = decl.slice(colon + 1).trim();
		}
		blocks.push({ selector: match[1], map });
	}
	// 同一选择器下 static 与 alias 分属两个块，必须合并（去重会让 alias 整块丢失）
	const merged = new Map();
	for (const block of blocks) {
		const current = merged.get(block.selector) ?? {};
		Object.assign(current, block.map);
		merged.set(block.selector, current);
	}
	return [...merged.entries()].map(([selector, map]) => ({
		selector,
		label: selector.includes("dark") ? "暗色" : "亮色",
		vars: map
	}));
}

function resolveVar(value, vars, depth = 0) {
	if (depth > 8) return value;
	const match = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/.exec(String(value).trim());
	if (match === null) return value;
	const hit = vars[match[1]];
	if (hit === undefined) return match[2] !== undefined ? match[2] : value;
	return resolveVar(hit, vars, depth + 1);
}

function parseColor(raw) {
	const text = String(raw).trim();
	let match = /^#([0-9a-f]{3,8})$/i.exec(text);
	if (match !== null) {
		let hex = match[1];
		if (hex.length <= 4) hex = hex.split("").map((c) => c + c).join("");
		return {
			r: parseInt(hex.slice(0, 2), 16),
			g: parseInt(hex.slice(2, 4), 16),
			b: parseInt(hex.slice(4, 6), 16),
			a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
		};
	}
	match = /^rgba?\(([^)]+)\)$/i.exec(text);
	if (match !== null) {
		const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
		return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
	}
	return null; // 裸色 / currentColor：返回 null，由调用方报「不可判定」而不是瞎猜
}

const composite = (fg, bg) => {
	const a = fg.a + bg.a * (1 - fg.a);
	const channel = (f, b) => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
	return { r: channel(fg.r, bg.r), g: channel(fg.g, bg.g), b: channel(fg.b, bg.b), a };
};
const luminance = ({ r, g, b }) => {
	const f = (c) => {
		c /= 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};
const toHex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 };

/**
 * kind 的含义（这是本脚本最重要的一个字段）：
 *   "plugin"    = 本插件与**宿主已确立的约定冲突**，可据此改，计失败。
 *   "reference" = 用来定位事实的对照行：要么是宿主自己的实现，要么是宿主全站同款的
 *                 取舍。**不计失败** —— 单方面改它会让插件与宿主设计语言脱节。
 * 阈值：WCAG 1.4.3 正常文字 4.5:1；WCAG 1.4.11 非文字元件/焦点指示 3:1。
 */
const TEXT_CHECKS = [
	{ kind: "reference", label: ".dsy-tool .name / 卡片标题 label-primary", token: "--dsw-alias-label-primary", threshold: 4.5 },
	{ kind: "reference", label: ".dsy-label / .dsy-btn label-secondary", token: "--dsw-alias-label-secondary", threshold: 4.5 },
	{ kind: "reference", label: ".dsy-note/.dsy-count/.desc label-tertiary", token: "--dsw-alias-label-tertiary", threshold: 4.5 },
	{ kind: "reference", label: ".dsy-msg.ok / .dsy-badge.ok 文字", token: "--dsw-alias-state-success-primary", threshold: 4.5 },
	{ kind: "reference", label: ".dsy-msg.warn / .dsy-badge.warn 文字", token: "--dsw-alias-state-warn-primary", threshold: 4.5 },
	{ kind: "reference", label: ".dsy-msg.err / h4.dsy-danger 文字", token: "--dsw-alias-state-error-primary", threshold: 4.5 }
];

const SWITCH_CHECKS = [
	{
		kind: "plugin",
		label: "逐工具 ON 轨道=business + 球=label-primary-foreground",
		track: "--dsw-alias-state-business-primary",
		thumb: "--dsw-alias-label-primary-foreground"
	},
	{
		kind: "plugin",
		label: "组开关 ON 轨道=success + 球=label-primary-foreground",
		track: "--dsw-alias-state-success-primary",
		thumb: "--dsw-alias-label-primary-foreground"
	},
	{
		kind: "plugin",
		label: "危险组 ON 轨道=warn + 球=label-primary-foreground",
		track: "--dsw-alias-state-warn-primary",
		thumb: "--dsw-alias-label-primary-foreground"
	},
	{ kind: "reference", label: "组开关 OFF 轨道=border-l4 + 球=switch-thumb", track: "--dsw-alias-border-l4", thumb: "--dsw-alias-switch-thumb" },
	{
		kind: "reference",
		label: "[宿主] ON 轨道=brand + 球=label-primary-foreground",
		track: "--dsw-alias-brand-primary",
		thumb: "--dsw-alias-label-primary-foreground"
	},
	{ kind: "reference", label: "[宿主] OFF 轨道=border-l3 + 球=switch-thumb", track: "--dsw-alias-border-l3", thumb: "--dsw-alias-switch-thumb" }
];

const FOCUS_CHECKS = [
	{ kind: "reference", label: ".dsy-input 默认边框 border-l4（基线）", token: "--dsw-alias-border-l4" },
	{ kind: "plugin", label: ".dsy-input:focus 边框 state-business-primary", token: "--dsw-alias-state-business-primary" },
	{ kind: "plugin", label: ".dsy-tool:focus-visible outline=state-business-primary", token: "--dsw-alias-state-business-primary" },
	{ kind: "reference", label: "[宿主] focus 兜底 state-business-primary", token: "--dsw-alias-state-business-primary" }
];

const GROUP_TITLES = { 文字: "文字/背景", 开关: "开关：球 vs 轨道", focus: "焦点指示" };

function main() {
	const argv = process.argv.slice(2);
	const dshIndex = argv.indexOf("--dsh");
	const explicit = dshIndex >= 0 ? argv[dshIndex + 1] : undefined;
	const asJson = argv.includes("--json");
	const countAll = argv.includes("--all");

	const themeFile = findThemeFile(explicit);
	const themes = parseThemes(fs.readFileSync(themeFile, "utf8"));
	if (themes.length === 0) {
		console.error("解析不出主题块：" + themeFile);
		process.exit(2);
	}

	const results = [];
	const push = (theme, group, check, row) => results.push({ theme: theme.label, group, kind: check.kind, label: check.label, ...row });

	for (const theme of themes) {
		const get = (token) => {
			const raw = theme.vars[token];
			return raw === undefined ? null : parseColor(resolveVar(raw, theme.vars));
		};
		const bg = get("--dsw-alias-bg-base");
		if (bg === null) continue;

		for (const check of TEXT_CHECKS) {
			const fg = get(check.token);
			if (fg === null) {
				push(theme, "文字", check, { note: "token 未定义", pass: null });
				continue;
			}
			const solid = composite(fg, bg);
			const ratio = contrast(solid, bg);
			push(theme, "文字", check, { fg: toHex(solid), bg: toHex(bg), ratio, threshold: check.threshold, pass: ratio >= check.threshold });
		}

		for (const check of SWITCH_CHECKS) {
			const track = get(check.track);
			const thumbToken = check.thumb === null ? OPAQUE_WHITE : get(check.thumb);
			if (track === null || thumbToken === null) {
				push(theme, "开关", check, { note: "token 未定义", pass: null });
				continue;
			}
			const trackSolid = composite(track, bg);
			const thumb = composite(thumbToken, trackSolid);
			const ratio = contrast(thumb, trackSolid);
			push(theme, "开关", check, { fg: toHex(thumb), bg: toHex(trackSolid), ratio, threshold: 3, pass: ratio >= 3 });
		}

		for (const check of FOCUS_CHECKS) {
			const fg = get(check.token);
			if (fg === null) continue;
			const solid = composite(fg, bg);
			const ratio = contrast(solid, bg);
			push(theme, "focus", check, { fg: toHex(solid), bg: toHex(bg), ratio, threshold: 3, pass: ratio >= 3 });
		}
	}

	if (asJson) {
		console.log(JSON.stringify({ themeFile, dshVersion: findDshVersion(themeFile), results }, null, 2));
	} else {
		console.log("主题文件：" + themeFile);
		console.log("dsh 版本：" + findDshVersion(themeFile));
		for (const theme of themes) {
			for (const group of ["文字", "开关", "focus"]) {
				const rows = results.filter((r) => r.theme === theme.label && r.group === group);
				if (rows.length === 0) continue;
				console.log(`\n== ${theme.label} / ${GROUP_TITLES[group]} (门槛 ${rows[0].threshold}:1) ==`);
				for (const row of rows) {
					const mark = row.kind === "plugin" ? " " : "·";
					if (row.note !== undefined) {
						console.log(`  ${mark} ${row.label.padEnd(54)} ${row.note}`);
						continue;
					}
					console.log(`  ${mark} ${row.label.padEnd(54)} ${row.fg} on ${row.bg}  ${row.ratio.toFixed(2)}:1  ${row.pass ? "PASS" : "FAIL"}`);
				}
			}
		}
		const pluginRows = results.filter((r) => r.kind === "plugin");
		const failed = pluginRows.filter((r) => r.pass === false).length;
		console.log("\n（行首 · 为宿主参照行，不计失败：它记录的是宿主全站同款的取舍，单方面改会让插件脱节）");
		console.log(`插件检查项 ${pluginRows.length} 项，FAIL ${failed} 项；全部检查项 ${results.length} 项。`);
	}

	const rows = countAll ? results : results.filter((r) => r.kind === "plugin");
	process.exit(rows.some((r) => r.pass === false) ? 1 : 0);
}

main();
