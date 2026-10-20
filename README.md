# dsh-auto-think

模型输出思考时**自动展开**思考块，思考结束后**自动折叠**——不用再手动点。
展开和折叠都带 **200/180ms 的高度+透明度过渡动画**，不管开关开没开、是不是手动点的，都不会「嗖」地闪一下。
左侧边栏底部有一个开关，只管「要不要自动」，不管动画。

## 行为

| 场景 | 行为 |
| --- | --- |
| 思考块开始流式输出（`data-state="running"`）且折叠 | 自动展开（每个块只展开一次） |
| 思考结束（`data-state="ok"`）后约 350ms | 自动折叠 |
| 你中途手动收起 | 不会被抢着再展开 |
| 你自己点开的块 | 结束后保持展开，不折叠 |
| 历史里已结束的块 | 不碰 |
| 手动点开 / 手动收起 | 同样有动画（截获点击 → 播放动画 → 再交给 React） |
| 开关关闭 | 不再自动展开/折叠，但手动操作照旧有动画 |
| 系统「减少动态效果」 | 跳过动画，瞬间切换 |

开关默认开，状态记在浏览器（`localStorage` 的 `dsh-auto-think/enabled`）。

## 动画怎么做的

思考块的内容是 React 条件渲染的：展开时插入、折叠时立即卸载，纯 CSS 过渡做不出来。

- **展开**：`MutationObserver` 在内容插入的微任务里（**画笔之前**）把它设成
  `height:0; opacity:0`，两帧后过渡到实测高度和 `opacity:1`，结束后清掉内联样式，
  让流式文本继续自然长高——所以不会先闪一下全文再收起。
- **折叠**：先量高度 → 过渡到 `height:0; opacity:0` → 动画结束才真正点行（React 卸载内容）。
- **手动点击**：document 捕获阶段拦下收起点击（`preventDefault + stopPropagation`），
  播完动画再带标记重新派发，交回 React 的 `onClick`。
- 过渡用 `cubic-bezier(0.2, 0.8, 0.2, 1)`，展开 200ms、折叠 180ms。

## 侧边栏开关

注册在 `sidebar.footer.action`（设置按钮上方那一行），36×36 图标按钮：

- 右下角小圆点：亮色 = 开，灰色 = 关；
- 悬停提示「自动展开思考：开（思考时展开，结束后折叠）」/「…关」；
- 点一下即切换，立即生效，无需刷新。

## 实现要点

| 部分 | 做法 |
| --- | --- |
| 找思考块 | `document.querySelectorAll('[data-variant="think"]')`（chat 插件的 ReasoningRow 根节点） |
| 判断状态 | `data-state` = `running` / `ok` |
| 判断展开 | 内部 `[data-disclosure-row]` 的 `aria-expanded` |
| 触发切换 | 对该行调用 `click()`（与用户点击走同一条 React onClick） |
| 监听变化 | `MutationObserver`，`attributeFilter: [data-state, data-expanded, data-open, aria-expanded]`，每帧合并一次扫描 |
| 防抢操作 | 模块级 `WeakMap` 记录每个块「是否由插件展开」和「是否已折叠」 |
| 开关状态 | 模块级 store + `useSyncExternalStore`，写 `localStorage` |

不读会话内容、不发网络请求；只用 `react`、`react/jsx-runtime` 和 primitives 的思考图标。

## 测试

`test/smoke.mjs` 用最小 DOM 桩加载 `client.js`，覆盖 25 项：注册、开关默认值、
运行中自动展开、展开动画、手动折叠不被抢回、结束后自动折叠、未展开的已结束块不动、
手动收起的点击拦截与动画、关掉后不自动但**手动操作仍有动画**、再打开恢复、
销毁时断开 observer 与点击拦截。

```bash
node test/smoke.mjs
# [auto-think] PASS
```

## 安装

公开仓库，先用 `dsh` 的 plugin 命令装依赖：

```bash
dsh plugin --profile web add github:yezitotempeace/dsh-auto-think
```

然后把 `dsh-auto-think` 加进 profile `package.json` 的 `dsh.profile.bundles`，重启 Web。
（`plugin add` 只装依赖，bundle 不会自动挂载。）

本机开发也可以用 link：仓库放进 `/root/dsh-auto-think`，`dependencies` 写
`"dsh-auto-think": "link:/root/dsh-auto-think"`，`dsh.profile.bundles` 加 `dsh-auto-think`，
建 `node_modules/dsh-auto-think` 链接，重启 Web。

## 停用 / 卸载

1. 从 `dsh.profile.bundles` 删掉 `dsh-auto-think`（或在 profile 的 `cordis.patch.yml` 里加 `disabled: true`）；
2. 重启 Web。

关掉开关只是不再自动展开/折叠，插件本身仍加载、动画仍在。

## 许可

MIT
