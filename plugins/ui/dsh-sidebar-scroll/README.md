# dsh-sidebar-scroll

给 DSH 右侧栏加「上下滑动」的极小插件：只注入一段样式表，不注册插槽、不加按钮、不改任何数据。

## 它修的是什么

DSH 核心 `@deepseek-ai/dsh-client-ui-sidebar-right` 给每个 tab 的正文容器写死了：

```css
.OUqwTW_tabBody { height: 100%; overflow: hidden; }
```

正文一旦比 pane 高（最典型的就是「开始」这个 guide：注册的 tab 类型一多，条目列表就超出可视区），
超出的部分被直接裁掉；而外层 dockkit 的 `.paneBody` 虽然写着 `overflow: auto`，它自己却没有溢出可滚
—— 滚动它没有任何反应 —— 于是列表上下两头都够不到。

## 它做了什么

```css
div[data-sidebar-right-tab] {                     /* 每个 tab 的正文（div，不是标题 span） */
  overflow-y: auto !important;                    /* 自己成为滚动容器 */
  overflow-x: hidden !important;
  overscroll-behavior: contain;
}
div[data-sidebar-right-tab] [data-sidebar-right-guide] {
  justify-content: flex-start !important;         /* 溢出时从顶部排起，顶部内容才滚得回去 */
}
div[data-sidebar-right-tab] [data-sidebar-right-guide]::before {
  content: ""; flex: 1 1 0 !important; min-height: 0 !important;
}
div[data-sidebar-right-tab] [data-sidebar-right-guide]::after {
  flex: 1 1 0 !important; min-height: 0 !important;   /* 覆盖核心原本的 flex: 0 10% */
}
```

前后两个垫片在「内容比容器短」时平分空白，所以条目少的时候观感依旧居中；内容超高时垫片高度为 0，
列表从顶部开始、底部可滚到底。选择器只用核心输出的 `data-*` 属性，不用构建哈希类名。

## 安装 / 卸载

安装（在 profile 里登记本包）：

```
dsh plugin --profile desktop add link:D:\DeepSeek-Workspace\dsh-sidebar-scroll
```

实测（2026-10-09）：这条命令底层是 pnpm，但它会把依赖写进 profile 的 `dependencies`，
**并自动**把 `dsh-sidebar-scroll` 追加进 `dsh.profile.bundles`（29 → 30 项），不需要手工改。

然后重启 DSH 生效：新插件的 bundle 只有在宿主启动时的扫描里才会进模块图，刷新窗口不够。

卸载：从 `dsh.profile.bundles` 里删掉 `dsh-sidebar-scroll`，再 `dsh plugin --profile desktop remove dsh-sidebar-scroll`。
样式随包一起消失，不会留下痕迹。

## 验证记录

真机 GUI 取不到 DOM，所以用本地复现页验证（`..\dsh-sidebar-scroll-test\harness.html`：
真实 `dockkit.module.css` + 核心构建产物里导出的 CSS，DOM 复刻 pane → paneBody → tabBody → guide，
20 条目测）：

| | tabBody 可滚 | 滚到顶 | 滚到底 |
| --- | --- | --- | --- |
| 未修复 | 高度写死、overflow:hidden | hero 顶部 −304（够不到） | 末条底线 1134 > pane 底 805（够不到） |
| 修复后 | client 767 / scroll 1452 | hero 顶部 52（可见） | 末条底线 805 = pane 底（可见） |

3 条目的短列表也对照过：内容中心 422，pane 中心 421.5 —— 依旧是居中的。
