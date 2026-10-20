//#region lib/types/client/index.js
/**
 * Auto-think (browser half).
 *
 * DSH renders each assistant reasoning block as a collapsed disclosure row
 * (`div[data-variant="think"][data-state=running|ok]` wrapping a
 * `[data-disclosure-row]` with `aria-expanded`). While the model is thinking the
 * reader has to open the row by hand to watch the reasoning stream, and close it
 * again afterwards.
 *
 * This plugin watches the conversation DOM and:
 *   1. opens a reasoning row as soon as it starts streaming (`data-state="running"`,
 *      collapsed) — once per block, so a manual collapse is respected;
 *   2. closes it again shortly after the reasoning settles (`data-state="ok"`) —
 *      only for rows it opened itself, never for rows the reader opened;
 *   3. animates both directions (height + opacity) in every case — automatic or
 *      manual, switch on or off — unless the reader asked for reduced motion, so
 *      the block never flashes open or shut;
 *   4. exposes an on/off switch in the left sidebar (`sidebar.footer.action`),
 *      persisted in localStorage; the switch governs automation only, never the
 *      animation.
 *
 * It touches nothing else: no host code, no network, no data collection.
 */
window.__ModuleLoader__.load({
	id: "dsh-auto-think",
	factory: (require) => {
		"use strict";
		const React = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { IconThinkOutlineRegular } = primitives;

		/** Locale namespace owned by this plugin. */
		const NS = "autoThink";
		/** Browser-local switch state. */
		const STORAGE_KEY = "dsh-auto-think/enabled";
		/** Wait this long after reasoning settles before folding it back. */
		const COLLAPSE_DELAY_MS = 350;
		/** Reasoning row root rendered by the chat plugin. */
		const REASONING_SELECTOR = '[data-variant="think"]';
		/** Clickable disclosure header inside a reasoning row. */
		const ROW_SELECTOR = "[data-disclosure-row]";
		/** Unfolding animation length. */
		const ANIM_OPEN_MS = 200;
		/** Folding animation length. */
		const ANIM_CLOSE_MS = 180;
		/** Easing used for both directions. */
		const ANIM_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
		/** Marks a row whose click must not be intercepted again. */
		const PASS_FLAG = "autoThinkPass";

		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"label": "自动展开思考",
			"on": "自动展开思考：开（思考时展开，结束后折叠）",
			"off": "自动展开思考：关"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"label": "Auto-expand thinking",
			"on": "Auto-expand thinking: on (open while thinking, fold when done)",
			"off": "Auto-expand thinking: off"
		};

		/** Styles for the sidebar switch (injected once, removed on dispose). */
		const CSS = `
.dat-toggle{position:relative;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto}
.dat-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dat-toggle[data-on="true"]{color:var(--dsw-alias-label-primary)}
.dat-dot{position:absolute;right:7px;bottom:7px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.55}
.dat-toggle[data-on="true"] .dat-dot{background:var(--dsw-alias-accent, #3b82f6);opacity:1}
`;

		//#region switch state
		let enabled = readEnabled();
		const listeners = new Set();

		/** Read the persisted switch state; defaults to on. */
		function readEnabled() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				return raw === null ? true : raw === "1";
			} catch {
				return true;
			}
		}

		/** Persist and broadcast the switch state. */
		function setEnabled(next) {
			const value = next !== false;
			if (value === enabled) return;
			enabled = value;
			try {
				window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
			} catch {
				// Storage may be unavailable (private mode); the running session still works.
			}
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					// A broken subscriber must not stop the switch.
				}
			}
		}

		/** Subscribe to switch changes; returns the unsubscribe function. */
		function subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
		//#endregion

		//#region reasoning auto open/close
		/** Per-block bookkeeping: only rows this plugin opened are folded back. */
		const records = new WeakMap();
		/** Pending collapse timers, keyed by block. */
		const timers = new WeakMap();
		let observer = null;
		let scheduled = false;

		/** True when the disclosure row currently reports itself open. */
		function isOpen(row) {
			return row !== null && row.getAttribute("aria-expanded") === "true";
		}

		/** Readers who asked for reduced motion get the instant toggle. */
		function prefersReducedMotion() {
			try {
				return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
			} catch {
				return false;
			}
		}

		/** The expanded body sitting right after the disclosure row, if any. */
		function contentOf(row) {
			if (row === null) return null;
			const content = row.nextElementSibling;
			if (content === null || content === undefined) return null;
			return typeof content.getBoundingClientRect === "function" ? content : null;
		}

		/** Run a callback on the next frame (twice: after the style write is flushed). */
		function nextFrame(callback) {
			if (typeof window.requestAnimationFrame === "function") {
				window.requestAnimationFrame(() => window.requestAnimationFrame(callback));
			} else {
				setTimeout(callback, 0);
			}
		}

		/**
		 * Unfold a freshly mounted reasoning body: height + opacity from closed to
		 * open, then hand the height back to the browser so streaming text can grow.
		 * Called synchronously from the mutation callback (before paint), so the
		 * body never flashes at full height.
		 * @param content - the body element the disclosure just mounted.
		 */
		function animateOpen(content) {
			if (content === null || prefersReducedMotion()) return;
			const style = content.style;
			if (style === undefined) return;
			const height = content.getBoundingClientRect().height;
			style.overflow = "hidden";
			style.height = "0px";
			style.opacity = "0";
			style.transition = `height ${ANIM_OPEN_MS}ms ${ANIM_EASE}, opacity ${ANIM_OPEN_MS}ms ease`;
			nextFrame(() => {
				style.height = `${height}px`;
				style.opacity = "1";
			});
			const finish = () => {
				style.height = "";
				style.overflow = "";
				style.opacity = "";
				style.transition = "";
				content.removeEventListener?.("transitionend", finish);
			};
			content.addEventListener?.("transitionend", finish, { once: true });
			setTimeout(finish, ANIM_OPEN_MS + 80);
		}

		/**
		 * Fold a reasoning body before React unmounts it: height + opacity down to
		 * zero, then run the callback that actually clicks the row.
		 * @param content - the body element about to be unmounted.
		 * @param done - runs once the shrink animation has played.
		 */
		function animateCollapse(content, done) {
			const style = content?.style;
			if (content === null || style === undefined || prefersReducedMotion()) {
				done();
				return;
			}
			const height = content.getBoundingClientRect().height;
			style.overflow = "hidden";
			style.height = `${height}px`;
			style.transition = `height ${ANIM_CLOSE_MS}ms ease, opacity ${ANIM_CLOSE_MS}ms ease`;
			nextFrame(() => {
				style.height = "0px";
				style.opacity = "0";
			});
			setTimeout(done, ANIM_CLOSE_MS + 20);
		}

		/** Click a row outside the manual-click interception below. */
		function clickRow(row) {
			try {
				row.dataset[PASS_FLAG] = "1";
			} catch {
				// Detached or exotic nodes still take a plain click.
			}
			row.click();
			setTimeout(() => {
				try {
					delete row.dataset[PASS_FLAG];
				} catch {
					// Ignore: the row may be gone already.
				}
			}, 0);
		}

		/** A block that the reader closed by hand must not be re-opened by us. */
		function recordOf(block) {
			let record = records.get(block);
			if (record === undefined) {
				record = { opened: false, closed: false };
				records.set(block, record);
			}
			return record;
		}

		/** Cancel a pending auto-collapse (the block started streaming again). */
		function cancelCollapse(block) {
			const timer = timers.get(block);
			if (timer !== undefined) {
				clearTimeout(timer);
				timers.delete(block);
			}
		}

		/** Open one reasoning row; marks it so a later settle folds it back. */
		function openRow(block, row, record) {
			record.opened = true;
			clickRow(row);
		}

		/** Fold a settled row back after a short beat, re-checking it is still ours to close. */
		function scheduleCollapse(block, row, record) {
			cancelCollapse(block);
			const timer = setTimeout(() => {
				timers.delete(block);
				if (record.closed) return;
				// The row may have been replaced, closed by hand, or resumed meanwhile.
				if (typeof document.contains === "function" && !document.contains(block)) return;
				const current = block.querySelector(ROW_SELECTOR);
				if (current === null || !isOpen(current)) return;
				if (block.getAttribute("data-state") !== "ok") return;
				record.closed = true;
				animateCollapse(contentOf(current), () => {
					const fresh = block.querySelector(ROW_SELECTOR);
					if (fresh !== null && isOpen(fresh)) clickRow(fresh);
				});
			}, COLLAPSE_DELAY_MS);
			timers.set(block, timer);
		}

		/**
		 * Capture-phase listener: a reader folding an open reasoning row gets the
		 * same shrink animation the automatic fold uses. Live in both switch
		 * states — the switch governs automation only, not the motion. The click is
		 * held back until the animation ends, then re-dispatched with the pass flag
		 * so this listener steps aside and React's own onClick toggles the row.
		 * @param event - the click event on the document.
		 */
		function onDocumentClick(event) {
			const target = event.target;
			if (!target || typeof target.closest !== "function") return;
			const row = target.closest(ROW_SELECTOR);
			if (row === null) return;
			const block = typeof row.closest === "function" ? row.closest(REASONING_SELECTOR) : null;
			if (block === null) return;
			if (row.dataset?.[PASS_FLAG] === "1") return;
			// Opening: let React mount the body; the mutation callback animates it.
			if (!isOpen(row)) return;
			const content = contentOf(row);
			if (content === null || prefersReducedMotion()) return;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation?.();
			animateCollapse(content, () => {
				const fresh = block.querySelector(ROW_SELECTOR);
				if (fresh !== null && isOpen(fresh)) clickRow(fresh);
			});
		}

		/** Run one pass over every reasoning block in the document. */
		function sweep() {
			if (!enabled) return;
			const blocks = document.querySelectorAll(REASONING_SELECTOR);
			for (const block of blocks) {
				const row = block.querySelector(ROW_SELECTOR);
				if (row === null) continue;
				const record = recordOf(block);
				const state = block.getAttribute("data-state");
				if (state === "running") {
					cancelCollapse(block);
					if (!record.opened && !isOpen(row)) openRow(block, row, record);
				} else if (state === "ok" && record.opened && !record.closed && isOpen(row)) {
					scheduleCollapse(block, row, record);
				}
			}
		}

		/** Coalesce bursts of DOM mutations into one sweep per frame. */
		function schedule() {
			if (scheduled) return;
			scheduled = true;
			const run = () => {
				scheduled = false;
				sweep();
			};
			if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
			else setTimeout(run, 16);
		}

		/**
		 * Mutation callback: animate bodies React just mounted, then sweep.
		 * Runs as a microtask before paint, which is what keeps a freshly expanded
		 * body from flashing at its full height for one frame. The animation runs in
		 * both switch states — the switch governs automation only.
		 * @param mutations - records delivered by the observer.
		 */
		function onMutations(mutations) {
			for (const mutation of mutations) {
				if (mutation.type !== "childList") continue;
				for (const node of mutation.addedNodes) {
					if (!node || typeof node.getBoundingClientRect !== "function") continue;
					const parent = node.parentElement;
					if (parent === null || parent === undefined) continue;
					const first = parent.firstElementChild;
					if (first === null || first === undefined || typeof first.matches !== "function") continue;
					if (!first.matches(ROW_SELECTOR)) continue;
					if (typeof parent.closest !== "function" || parent.closest(REASONING_SELECTOR) === null) continue;
					animateOpen(node);
				}
			}
			schedule();
		}

		/** Start observing the document; returns the dispose function. */
		function start() {
			document.addEventListener?.("click", onDocumentClick, true);
			if (typeof MutationObserver !== "function") {
				return () => document.removeEventListener?.("click", onDocumentClick, true);
			}
			observer = new MutationObserver(onMutations);
			observer.observe(document.body, {
				subtree: true,
				childList: true,
				attributes: true,
				attributeFilter: ["data-state", "data-expanded", "data-open", "aria-expanded"]
			});
			sweep();
			return () => {
				observer?.disconnect();
				observer = null;
				document.removeEventListener?.("click", onDocumentClick, true);
			};
		}
		//#endregion

		//#region sidebar switch component
		/** Subscribe a component to switch changes (React 18+ useSyncExternalStore). */
		function useEnabled() {
			if (typeof React.useSyncExternalStore === "function") {
				return React.useSyncExternalStore(subscribe, () => enabled, () => enabled);
			}
			const [, force] = React.useReducer((n) => n + 1, 0);
			React.useEffect(() => subscribe(force), []);
			return enabled;
		}

		/**
		 * Sidebar footer switch.
		 * @param props.wide - sidebar fold state from the owner (`false` = 36px rail).
		 * @param props.t - locale lookup bound to this plugin's dictionary.
		 */
		function AutoThinkToggle({ wide, t }) {
			const on = useEnabled();
			const label = on ? t("on") : t("off");
			return jsx("button", {
				type: "button",
				className: "dat-toggle",
				"data-on": on ? "true" : "false",
				"data-auto-think-toggle": "",
				"aria-pressed": on,
				"aria-label": label,
				title: label,
				onClick: () => setEnabled(!on),
				children: [jsx(IconThinkOutlineRegular, { size: wide ? 16 : 18 }), jsx("span", { className: "dat-dot", "aria-hidden": "true" })]
			});
		}
		//#endregion

		//#region plugin body
		/**
		 * Register dictionaries, the sidebar switch and the DOM observer.
		 * @param ctx - Client root context carrying effects, slots and locale.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "auto-think: dictionaries");
			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-auto-think";
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "auto-think: styles");
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "auto-think.toggle",
						order: 40,
						locale: NS
					},
					AutoThinkToggle
				)
			);
			ctx.effect(() => start(), "auto-think: reasoning observer");
		}

		/** Services this plugin needs before it can register its UI. */
		const inject = ["slots", "locale"];
		/** Test/debug hook: lets a harness drive the switch and one sweep. */
		// Debug hook for the smoke test and live troubleshooting; opt-in, so the
		// page keeps a clean global namespace by default.
		if (window.__DSH_AUTO_THINK_DEBUG__ === true) {
			window.__dshAutoThink = {
				sweep,
				setEnabled,
				isEnabled: () => enabled
			};
		}
		return { inject, apply };
	}
});
//#endregion
