# dsh-auto-think

The assistant's reasoning block **opens by itself** while the model is thinking and
**folds back** when thinking ends — no manual clicking. Both directions animate
(**200/180 ms height + opacity**), whether the switch is on or off and whether the
toggle was automatic or manual, so the block never flashes open or shut. The switch
at the bottom of the left sidebar controls automation only, never the animation.

[中文说明](README.md)

## Behaviour

| Situation | Behaviour |
| --- | --- |
| Reasoning starts streaming (`data-state="running"`) while collapsed | Opens automatically (once per block) |
| Reasoning settles (`data-state="ok"`) after ~350 ms | Folds automatically |
| You collapse it mid-stream | It is not reopened |
| A row you opened yourself | Stays open after settling |
| Settled rows from history | Never touched |
| Manual open / manual collapse | Also animated (click intercepted → animation → handed back to React) |
| Switch off | No automatic open/close, but manual toggles stay animated |
| System "reduce motion" | Animation skipped, instant toggle |

The switch defaults to on and is persisted in the browser (`localStorage`, key
`dsh-auto-think/enabled`).

## How the animation works

The reasoning body is conditionally rendered: React mounts it on expand and unmounts
it on collapse, so a plain CSS transition cannot cover it.

- **Expand**: the `MutationObserver` catches the inserted body in a microtask
  (**before paint**), pins it to `height:0; opacity:0`, then transitions to the
  measured height and `opacity:1`; afterwards the inline styles are cleared so
  streaming text can grow naturally. No full-height flash.
- **Collapse**: measure the height → transition to `height:0; opacity:0` → only then
  click the row (React unmounts the body).
- **Manual click**: a capture-phase document listener holds back the collapse click
  (`preventDefault + stopPropagation`), plays the animation, then re-dispatches the
  click with a pass flag so React's own `onClick` toggles the row.
- Easing `cubic-bezier(0.2, 0.8, 0.2, 1)`; 200 ms open, 180 ms close.

## Sidebar switch

Registered in `sidebar.footer.action` (the row above the settings button) as a
36×36 icon button:

- small dot in the corner: accent = on, grey = off;
- tooltip: "Auto-expand thinking: on (open while thinking, fold when done)" / "…off";
- click to flip; takes effect immediately, no reload.

## How it works

| Part | Approach |
| --- | --- |
| Find reasoning blocks | `document.querySelectorAll('[data-variant="think"]')` (the chat plugin's ReasoningRow root) |
| State | `data-state` = `running` / `ok` |
| Expanded? | `aria-expanded` on the inner `[data-disclosure-row]` |
| Toggle | `click()` on that row — the same React onClick path a user click takes |
| React to changes | `MutationObserver` with `attributeFilter: [data-state, data-expanded, data-open, aria-expanded]`, coalesced to one sweep per frame |
| Don't fight the user | per-block `WeakMap` recording "opened by us" and "already folded" |
| Switch state | module store + `useSyncExternalStore`, written to `localStorage` |

Never reads conversation content, never touches the network; only `react`,
`react/jsx-runtime` and the primitives thinking icon.

## Test

`test/smoke.mjs` loads `client.js` against a minimal DOM stub and covers 25 checks:
registration, default switch state, auto-open while running, the open animation,
manual collapse not undone, fold after settle, settled untouched rows left alone,
manual collapse interception and animation, off means no automation but **manual
toggles still animate**, back on resumes, dispose disconnects the observer and the
click interceptor.

```bash
node test/smoke.mjs
# [auto-think] PASS
```

## Install

From the public repo, install the dependency first:

```bash
dsh plugin --profile web add github:yezitotempeace/dsh-auto-think
```

Then add `dsh-auto-think` to `dsh.profile.bundles` in the profile `package.json` and
restart the Web app. (`plugin add` only installs the dependency; bundles are not
mounted automatically.)

For local development you can link instead: put the repo at `/root/dsh-auto-think`,
set `"dsh-auto-think": "link:/root/dsh-auto-think"` in `dependencies`, add
`dsh-auto-think` to `dsh.profile.bundles`, link `node_modules/dsh-auto-think`, and
restart the Web app.

## Disable / uninstall

1. remove `dsh-auto-think` from `dsh.profile.bundles` (or set `disabled: true` in the
   profile `cordis.patch.yml`);
2. restart the Web app.

Turning the switch off only stops automation; the plugin keeps loading and the
animation stays.

## License

MIT
