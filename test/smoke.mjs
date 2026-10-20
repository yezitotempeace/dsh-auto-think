/**
 * Smoke test for the auto-think client bundle.
 *
 * The bundle is a browser module for `window.__ModuleLoader__`, so this harness
 * provides a tiny DOM: a registry of reasoning blocks (the `[data-variant="think"]`
 * rows shipped by the chat plugin), a `MutationObserver` stub the test fires by
 * hand, a capture-phase click listener the test dispatches through, and a fake
 * client context. It checks, in order:
 *   - registration and defaults;
 *   - auto-open of a running collapsed row (once), manual collapse respected;
 *   - open/collapse animations on the body element;
 *   - fold after settle, settled rows nobody opened left alone;
 *   - the sidebar switch turning everything off and back on;
 *   - dispose removing the observer and the click listener.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client.js"), "utf8");

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`  ok  ${name}`);
		return;
	}
	failures += 1;
	console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

//#region fake DOM
class FakeContent {
	constructor(parent) {
		this.parentElement = parent;
		this.style = {};
		this.listeners = new Map();
	}
	getBoundingClientRect() {
		return { height: 120 };
	}
	addEventListener(type, handler) {
		this.listeners.set(type, handler);
	}
	removeEventListener(type) {
		this.listeners.delete(type);
	}
}

class FakeRow {
	constructor(block) {
		this.block = block;
		this.attributes = { "data-disclosure-row": "", "aria-expanded": "false" };
		this.dataset = {};
		this.clicks = 0;
	}
	getAttribute(name) {
		return this.attributes[name] ?? null;
	}
	setAttribute(name, value) {
		this.attributes[name] = value;
	}
	matches(selector) {
		return selector === "[data-disclosure-row]";
	}
	closest(selector) {
		if (selector === "[data-disclosure-row]") return this;
		return selector === '[data-variant="think"]' ? this.block : null;
	}
	get parentElement() {
		return this.block;
	}
	get nextElementSibling() {
		return this.block.content;
	}
	click() {
		this.clicks += 1;
		if (this.attributes["aria-expanded"] === "true") {
			this.attributes["aria-expanded"] = "false";
			this.block.content = null;
			return;
		}
		this.attributes["aria-expanded"] = "true";
		this.block.content = new FakeContent(this.block);
	}
}

class FakeBlock {
	constructor(state = "running") {
		this.attributes = { "data-variant": "think", "data-state": state };
		this.row = new FakeRow(this);
		this.content = null;
	}
	getAttribute(name) {
		return this.attributes[name] ?? null;
	}
	setAttribute(name, value) {
		this.attributes[name] = value;
	}
	get firstElementChild() {
		return this.row;
	}
	querySelector(selector) {
		return selector === "[data-disclosure-row]" ? this.row : null;
	}
	closest(selector) {
		return selector === '[data-variant="think"]' ? this : null;
	}
}

const blocks = [];
const observers = [];
const documentListeners = new Map();
let loaderModule = null;

globalThis.window = {
	__DSH_AUTO_THINK_DEBUG__: true,
	localStorage: {
		store: new Map(),
		getItem(key) {
			return this.store.has(key) ? this.store.get(key) : null;
		},
		setItem(key, value) {
			this.store.set(key, String(value));
		}
	},
	requestAnimationFrame(callback) {
		setTimeout(callback, 0);
	},
	__ModuleLoader__: {
		load(definition) {
			loaderModule = definition;
		}
	}
};

globalThis.MutationObserver = class {
	constructor(callback) {
		this.callback = callback;
		this.connected = false;
		observers.push(this);
	}
	observe() {
		this.connected = true;
	}
	disconnect() {
		this.connected = false;
	}
};

globalThis.document = {
	body: {},
	head: { appendChild() {} },
	createElement() {
		return { dataset: {}, textContent: "", remove() {} };
	},
	querySelectorAll(selector) {
		return selector === '[data-variant="think"]' ? blocks.slice() : [];
	},
	contains(element) {
		return blocks.includes(element);
	},
	addEventListener(type, handler) {
		documentListeners.set(type, handler);
	},
	removeEventListener(type) {
		documentListeners.delete(type);
	}
};
//#endregion

//#region load the bundle
const requireStub = (id) => {
	switch (id) {
		case "react":
			return {
				useSyncExternalStore: (subscribe, get) => get(),
				useReducer: () => [0, () => {}],
				useEffect: () => {}
			};
		case "react/jsx-runtime":
			return { jsx: () => null, jsxs: () => null, Fragment: Symbol("fragment") };
		case "@deepseek-ai/dsh-client-ui-primitives":
			return { IconThinkOutlineRegular: () => null };
		default:
			throw new Error(`unexpected require: ${id}`);
	}
};

new Function("window", source)(globalThis.window);
if (loaderModule === null) {
	console.error("bundle did not call __ModuleLoader__.load");
	process.exit(1);
}
const plugin = loaderModule.factory(requireStub);
check("bundle exports inject + apply", Array.isArray(plugin.inject) && typeof plugin.apply === "function");
check("inject covers slots + locale", plugin.inject.includes("slots") && plugin.inject.includes("locale"));
//#endregion

//#region fake client context
const registered = [];
const disposers = [];
const ctx = {
	effect(makeEffect) {
		const dispose = makeEffect();
		if (typeof dispose === "function") disposers.push(dispose);
		return dispose;
	},
	locale: { register: () => () => {} },
	slots: {
		inject(_name, callback) {
			callback();
		},
		register(definition, component) {
			registered.push({ definition, component });
			return () => {};
		}
	}
};

plugin.apply(ctx);
check("registers the sidebar switch", registered.some((entry) => entry.definition.name === "sidebar.footer.action"));
check("switch id is auto-think.toggle", registered.some((entry) => entry.definition.id === "auto-think.toggle"));
check("exposes the debug hook", typeof window.__dshAutoThink?.sweep === "function");
check("observer created", observers.length === 1);
check("click interceptor installed", typeof documentListeners.get("click") === "function");

const fire = (records = []) => {
	for (const observer of observers) observer.callback(records);
};
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const contentRecord = (block) => [{ type: "childList", addedNodes: [block.content] }];
const dispatchClick = (target) => {
	const listeners = documentListeners.get("click");
	let prevented = false;
	const event = {
		target,
		preventDefault: () => {
			prevented = true;
		},
		stopPropagation: () => {},
		stopImmediatePropagation: () => {}
	};
	listeners(event);
	return prevented;
};
//#endregion

//#region behaviours
check("switch defaults to on", window.__dshAutoThink.isEnabled() === true);

// 1) running + collapsed -> opened exactly once
const first = new FakeBlock("running");
blocks.push(first);
fire();
await tick();
check("opens a running reasoning row", first.row.clicks === 1 && first.row.getAttribute("aria-expanded") === "true");

// The mounted body is animated open from zero height.
const firstContent = first.content;
fire(contentRecord(first));
await tick(30);
check("animates the body open", firstContent.style.height === "120px", `height=${firstContent.style.height}`);

// A manual collapse mid-stream must not be undone.
first.row.click();
fire();
await tick();
check("respects a manual collapse while streaming", first.row.clicks === 2 && first.row.getAttribute("aria-expanded") === "false");

// 2) opened by us, then settles -> folded back (animated, then clicked)
const second = new FakeBlock("running");
blocks.push(second);
fire();
await tick();
check("opens the second row", second.row.clicks === 1 && second.row.getAttribute("aria-expanded") === "true");
second.setAttribute("data-state", "ok");
fire();
await tick(700);
check("folds the row after it settles", second.row.clicks === 2 && second.row.getAttribute("aria-expanded") === "false");

// 3) a settled row nobody opened is left alone
const third = new FakeBlock("ok");
blocks.push(third);
fire();
await tick(700);
check("leaves settled rows untouched", third.row.clicks === 0 && third.row.getAttribute("aria-expanded") === "false");

// 4) a reader folding an open row is animated instead of flashing shut
const fourth = new FakeBlock("running");
blocks.push(fourth);
fire();
await tick();
const fourthContent = fourth.content;
const prevented = dispatchClick(fourth.row);
check("holds back the manual collapse click", prevented === true && fourth.row.getAttribute("aria-expanded") === "true");
check("starts the manual collapse animation", fourthContent.style.height === "120px", `height=${fourthContent.style.height}`);
await tick(260);
check("finishes the manual collapse", fourth.row.getAttribute("aria-expanded") === "false" && fourth.row.clicks === 2);

// 5) switch off -> no automation, but the motion stays
window.__dshAutoThink.setEnabled(false);
check("switch state persisted", window.localStorage.getItem("dsh-auto-think/enabled") === "0");
const fifth = new FakeBlock("running");
blocks.push(fifth);
fire();
await tick(500);
check("does not auto-open while switched off", fifth.row.clicks === 0 && fifth.row.getAttribute("aria-expanded") === "false");

// The reader opens it by hand: still animated.
fifth.row.click();
const fifthContent = fifth.content;
fire(contentRecord(fifth));
await tick(30);
check("animates a manual open while switched off", fifthContent.style.height === "120px", `height=${fifthContent.style.height}`);

// The reader folds it by hand: still animated.
const preventedOff = dispatchClick(fifth.row);
check("holds back a manual collapse while switched off", preventedOff === true);
await tick(260);
check("manual collapse completes while switched off", fifth.row.getAttribute("aria-expanded") === "false" && fifth.row.clicks === 2);

// 6) switch back on -> works again
window.__dshAutoThink.setEnabled(true);
const sixth = new FakeBlock("running");
blocks.push(sixth);
fire();
await tick();
check("resumes after switching back on", sixth.row.clicks === 1 && sixth.row.getAttribute("aria-expanded") === "true");

// 7) dispose removes the observer and the click listener
for (const dispose of disposers) dispose();
check("dispose disconnects the observer", observers.every((observer) => observer.connected === false));
check("dispose removes the click interceptor", documentListeners.size === 0);
//#endregion

console.log(failures === 0 ? "[auto-think] PASS" : `[auto-think] FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
