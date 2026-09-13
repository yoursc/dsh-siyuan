/**
 * 导航图标兜底：设置面板挂载后，把「思源笔记」那一行的齿轮换成思源 logo。
 *
 * 这段逻辑只在浏览器里跑（外壳 DOM + MutationObserver），Node 侧没有 DOM，所以这里按外壳
 * 真实结构（`div.panel > nav > div.navList > button > [svg.navIcon, span.navLabel]`，
 * 见 @deepseek-ai/dsh-client-ui-settings-general/lib/client.js）搭一个最小 DOM 替身，
 * 只实现被测代码用到的那几个 API。**真机效果要等 dsh web 挂载后刷页面才能确认**；
 * 替身只是顺序/形状的守门人，外壳改结构时这里得跟着改。
 *
 * 用法：node test/client-navicon.mjs
 */

import { loadClientModule } from './client-harness-lib.mjs'

const failures = []
function check(label, condition, detail) {
	if (condition === true) console.log(`  ok   ${label}`)
	else {
		failures.push(label)
		console.log(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}`)
	}
}

//#region DOM 替身
/** 变更通知钩子：由 createDocument() 接到 MutationObserver 替身上。 */
let notifyMutation = null

class FakeElement {
	constructor(tag, attrs = {}, text = null) {
		this.tagName = tag.toUpperCase()
		this.attributes = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]))
		this.childNodes = []
		this.parentNode = null
		this.ownText = text
		this.dataset = {}
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value))
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null
	}
	appendChild(child) {
		child.parentNode = this
		this.childNodes.push(child)
		notifyMutation()
		return child
	}
	replaceWith(next) {
		const index = this.parentNode === null ? -1 : this.parentNode.childNodes.indexOf(this)
		if (index === -1) throw new Error('replaceWith：节点不在文档里')
		next.parentNode = this.parentNode
		this.parentNode.childNodes[index] = next
		this.parentNode = null
		notifyMutation()
	}
	querySelectorAll(selector) {
		return select(this, selector)
	}
	querySelector(selector) {
		return select(this, selector)[0] ?? null
	}
	get textContent() {
		const parts = []
		if (this.ownText !== null) parts.push(this.ownText)
		for (const child of this.childNodes) parts.push(child.textContent)
		return parts.join('')
	}
	set textContent(value) {
		// bundle 用 `tag.textContent = css` 注入样式；没有 setter 会在严格模式下抛错。
		this.ownText = String(value)
	}
}

/** 只支持 `<标签>` 与 `<祖先> <后代>` 两种形状——被测代码只用得到这两种。 */
function select(root, selector) {
	const parts = selector.trim().split(/\s+/).map((part) => part.toUpperCase())
	const matches = (node, index) => {
		if (node.tagName !== parts[index]) return false
		if (index === 0) return true
		for (let ancestor = node.parentNode; ancestor !== null; ancestor = ancestor.parentNode) {
			if (matches(ancestor, index - 1)) return true
		}
		return false
	}
	const found = []
	const walk = (node) => {
		for (const child of node.childNodes) {
			if (matches(child, parts.length - 1)) found.push(child)
			walk(child)
		}
	}
	walk(root)
	return found
}

function createDocument() {
	const body = new FakeElement('body')
	const head = new FakeElement('head')
	// 真实浏览器里 DOM 变更会通知 MutationObserver；替身里手动把这条线接上，
	// 否则「面板挂载 → 观察回调 → 排帧」这条被测链路根本跑不到。
	notifyMutation = () => {
		for (const observer of observers) {
			if (observer.observing !== null && !observer.disconnected) observer.callback()
		}
	}
	return {
		body,
		head,
		querySelectorAll: (selector) => select(body, selector),
		querySelector: (selector) => {
			// bundle 的去重查询：style[data-plugin-css="<id>"]（真的属性选择器，替身只认这一种形状）。
			const owned = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
			if (owned !== null) {
				const found = head.childNodes.find((node) => node.tagName === 'STYLE' && node.dataset.pluginCss === owned[1])
				return found ?? null
			}
			return select(body, selector)[0] ?? null
		},
		createElementNS: (namespace, tag) => new FakeElement(tag),
		createElement: (tag) => new FakeElement(tag),
	}
}

/** 一行导航：button > [svg.navIcon（齿轮）, span.navLabel（文案）]。 */
function createNavCell(label) {
	const cell = new FakeElement('button', { class: 'VOzbGW_navCell', type: 'button' })
	const gear = new FakeElement('svg', { class: 'VOzbGW_navIcon', width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none' })
	gear.appendChild(new FakeElement('path', { d: 'M8 1v14M1 8h14', stroke: 'currentColor' }))
	cell.appendChild(gear)
	cell.appendChild(new FakeElement('span', { class: 'VOzbGW_navLabel' }, label))
	return { cell, gear }
}

/** 设置面板：panel > nav > [navTitle, navList > 各行]。 */
function createPanel(rows) {
	const nav = new FakeElement('nav', { class: 'VOzbGW_nav' })
	nav.appendChild(new FakeElement('div', { class: 'VOzbGW_navTitle' }, '设置'))
	const list = new FakeElement('div', { class: 'VOzbGW_navList' })
	for (const row of rows) list.appendChild(row.cell)
	nav.appendChild(list)
	const panel = new FakeElement('div', { class: 'VOzbGW_panel', role: 'dialog' })
	panel.appendChild(nav)
	return panel
}
//#endregion

//#region 浏览器环境替身
const observers = []
const frames = []
globalThis.MutationObserver = class {
	constructor(callback) {
		this.callback = callback
		this.observing = null
		this.disconnected = false
		observers.push(this)
	}
	observe(target, options) {
		this.observing = { target, options }
	}
	disconnect() {
		this.disconnected = true
		this.observing = null
	}
}
globalThis.requestAnimationFrame = (callback) => frames.push(callback)
/** 只跑**当前**排队的那一帧：替换图标自身也是一次变更，会再排一帧，要能分开观察。 */
const flushFrames = () => {
	for (const frame of frames.splice(0)) frame()
}

const doc = createDocument()
globalThis.document = doc
//#endregion

// 这一套件是**唯一**在装载时就挂上假 document 的：模块作用域的样式注入分支会真的跑一遍，
// 于是样式标签的属性（CSS 热更新的前提）与样式文本都能在这里断言。
const { exportsObject, bundleId } = await loadClientModule(() => ({
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
}))
const internals = exportsObject.internals

console.log('— 样式标签（CSS 热更新的前提）—')
const styleTag = doc.head.childNodes.find((node) => node.tagName === 'STYLE')
const cssText = styleTag?.textContent ?? ''
check('样式标签已注入', styleTag !== undefined)
check('data-plugin 用**模块 id（包名）**：client-hmr 按它删旧样式，写裸名会永远删不掉', styleTag?.dataset.plugin === bundleId, `${String(styleTag?.dataset.plugin)} vs ${bundleId}`)
check('data-plugin-css 用 <包名>/client.css（同页去重键）', styleTag?.dataset.pluginCss === bundleId + '/client.css', String(styleTag?.dataset.pluginCss))
const plainOnColor = /\n\.dsy-switch\.on\{background:([^}]+)\}/.exec(cssText)?.[1]
const masterOnColor = /\n\.dsy-switch\.master\.on\{background:([^}]+)\}/.exec(cssText)?.[1]
check('组总开关 ON 的颜色与逐工具开关不同（换了色）', typeof plainOnColor === 'string' && typeof masterOnColor === 'string' && plainOnColor !== masterOnColor, `${String(plainOnColor)} vs ${String(masterOnColor)}`)
check('组说明行缩进到文字列（padding-left:50px）', /\.dsy-group-hint\{padding-left:50px\}/.test(cssText))
check('危险组的组开关 ON 用琥珀（红标题不配绿开关）', cssText.includes('.dsy-switch.master.dsy-tone-danger.on{background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary))}'))
check('整行 hover 有底纹（长列表不串行）', cssText.includes('.dsy-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}'))
check('工具行之间有细分隔线', cssText.includes('.dsy-tool + .dsy-tool{border-top:.5px solid var(--dsw-alias-border-l1)}'))

console.log('— 图标常量 —')
check('internals 暴露导航图标实现', internals !== undefined && typeof internals.patchNavCell === 'function' && typeof internals.watchNavIcon === 'function')
check('用思源官方 1024 网格', internals?.NAV_ICON_VIEW_BOX === '0 0 1024 1024')
check('四段路径齐备（官方 logo 的四块）', Array.isArray(internals?.NAV_ICON_PATHS) && internals.NAV_ICON_PATHS.length === 4)
check('单色：路径里没有残留品牌色', !JSON.stringify(internals?.NAV_ICON_PATHS).includes('#'))

console.log('— 插件装载 —')
const registrations = []
const effects = []
const slotsService = {
	inject(name, callback) {
		registrations.push(name)
		callback()
	},
	register(contract) {
		registrations.push(contract)
		return () => {}
	},
}
const ctx = {
	slots: slotsService,
	effect(callback, label) {
		const dispose = callback()
		effects.push({ label, dispose })
		return dispose
	},
}
exportsObject.apply(ctx)

const contract = registrations.find((entry) => typeof entry === 'object')
check('注册文案与图标匹配用的文案同源', contract?.label === internals.SECTION_LABEL, String(contract?.label))
check('挂在 ctx.effect 上（插件卸载时能断开）', effects.length === 1 && /导航图标/.test(effects[0].label), JSON.stringify(effects.map((entry) => entry.label)))
const observer = observers[0]
check('观察 body 的 childList + subtree', observer?.observing?.target === doc.body && observer.observing.options.childList === true && observer.observing.options.subtree === true, JSON.stringify(observer?.observing?.options))
check('面板没挂载时首帧扫描什么也不做', frames.length === 1)
flushFrames()
check('首帧扫描后不残留排队的帧', frames.length === 0)

console.log('— 面板挂载后替换图标 —')
const general = createNavCell('通用')
const siyuan = createNavCell('思源笔记')
doc.body.appendChild(createPanel([general, siyuan]))
check('挂载变更触发观察回调，且一帧内只排一次（rAF 合并）', frames.length === 1)
flushFrames()
check('替换动作本身也是一次变更，会再排一帧', frames.length === 1)
flushFrames()
check('第二次扫描没有可改的东西，不再排帧（收敛）', frames.length === 0)

const icon = siyuan.cell.querySelector('svg')
check('「思源笔记」行换成了我们的图标', icon.getAttribute('data-dsy-icon') === 'siyuan')
check('原齿轮已从文档里摘掉', siyuan.gear.parentNode === null)
check('沿用外壳的 class（尺寸/对齐/颜色令牌挂在它上面）', icon.getAttribute('class') === 'VOzbGW_navIcon', String(icon.getAttribute('class')))
check('viewBox 用官方网格', icon.getAttribute('viewBox') === internals.NAV_ICON_VIEW_BOX)
check('16x16，与外壳其余导航图标一致', icon.getAttribute('width') === '16' && icon.getAttribute('height') === '16')
check('fill 用 currentColor（深浅色主题自适应）', icon.getAttribute('fill') === 'currentColor')
check('四段 path 按官方顺序写入', icon.childNodes.length === 4 && icon.childNodes.every((node, index) => node.tagName === 'PATH' && node.getAttribute('d') === internals.NAV_ICON_PATHS[index].d))
check('原本深灰的两段用透明度保留层次', icon.childNodes.filter((node) => node.getAttribute('fill-opacity') !== null).length === 2)
check('不误伤别的分区（「通用」行的齿轮原样保留）', general.cell.querySelector('svg') === general.gear)

console.log('— 幂等与卸载 —')
observer.callback()
flushFrames()
check('重复扫描不叠加、不二次替换', siyuan.cell.querySelector('svg') === icon && icon.childNodes.length === 4)
check('没有文案行的按钮不动', internals.patchNavCell(new FakeElement('button'), doc) === false)
const noIconCell = new FakeElement('button')
noIconCell.appendChild(new FakeElement('span', {}, '思源笔记'))
check('只有文案没有图标时不抛错', internals.patchNavCell(noIconCell, doc) === false)
// 外壳哪天在导航行里加个角标 span，文案就不是第一个 span 了——不能因此认不出我们的行。
const badgeCell = new FakeElement('button')
const badgeGear = new FakeElement('svg', { class: 'VOzbGW_navIcon' })
badgeCell.appendChild(badgeGear)
badgeCell.appendChild(new FakeElement('span', { class: 'VOzbGW_navBadge' }, 'Beta'))
badgeCell.appendChild(new FakeElement('span', { class: 'VOzbGW_navLabel' }, '思源笔记'))
check('文案前面还有别的 span 时照样认得出', internals.patchNavCell(badgeCell, doc) === true && badgeGear.parentNode === null)
check('没有 document 时退化成空实现（Node 侧套件走这条路）', typeof internals.watchNavIcon(undefined) === 'function')
effects[0].dispose()
check('卸载时断开观察', observer.disconnected === true)

console.log('')
if (failures.length === 0) {
	console.log('全部通过 ✅')
	process.exit(0)
}
console.log(`${failures.length} 项失败：`)
for (const failure of failures) console.log(' - ' + failure)
process.exit(1)
