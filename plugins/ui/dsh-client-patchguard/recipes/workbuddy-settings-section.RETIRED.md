# workbuddy-settings-section 配方退役说明

退役日期：2026-11-11 · 上游版本：dsh-connect-workbuddy **5.21.3**（配方原记录 5.16.0）

## 结论

**这份配方不能「更新锚点」，只能退役。** 它想做的三件事，上游已经全部原生实现了，
而且实现得比配方更完整。强行更新锚点等于把过时的、更差的逻辑重新打回上游产物。

## 逐条核对

| # | 配方原本要做什么 | 上游 5.21.3 现状 |
|---|---|---|
| op1 `add registerSection()` | 注入一个 `registerSection()` 函数，注册 `settings.section` | **已原生实现** `registerSettingsSection()`（位置 @847596 起）。比配方多的部分：额外注册了 `settings.section.icon` 导航图标，且用 `locale: namespace` 让标题走 i18n，`order: 35`，并带 `surface: "settings"` |
| op2 `call registerSection()` | 在 `registerAllSlots()` 里调用它 | **已原生调用**：`registerAllSlots = () => [registerSettingsSection(), ...]`（@871887）。而且配方的老锚点 `WORKBUDDY_CARD_KEYS.map((key) => registerCard(...))` 整段已不存在 |
| op3 `card root li -> div` | 把卡片根节点从 `<li>` 改成 `<div>` | **上游用了更正确的方式**：不再靠改标签名，而是在 `WorkBuddyCardBody` 里按 `surface` 分支——`pageSurface \|\| settingsSurface` 时直接返回 `<div className="dsm-workbuddy-page ...">`，只有插件列表那种场景才走 `<li className="dsm-plugin-card">` |

关键证据（上游源码注释，@871702 附近）：

```
The former `plugins.bundle.config` / `plugins.row.config` pair is GONE with
5.19.0: the same configuration must not have two editing entries.
```

即：从 5.19.0 起，配置入口统一收拢到 `settings.section`，插件列表里那两个 keyed slot
被有意移除。配方的存在前提（「上游从不注册 settings.section」）已经不成立了。

## 为什么必须退役而不是改写

1. op1 / op2 的锚点已消失（返回 False 实测），`applyOps()` 会在第一个 op 就抛错，
   整份配方永远打不上 —— 这就是 11-11 那两份启动崩溃日志里的告警来源。
2. 即便勉强找到新锚点把 `registerSection()` 塞进去，它会和上游原生的
   `registerSettingsSection()` **重复注册同一个 `settings.section`** ——
   上游代码明确写了「同一份配置不能有两个编辑入口」，这正是它 5.19.0 删掉旧槽位的原因。
3. op3 如果照旧强行把 `<li>` 全改成 `<div>`，会破坏插件列表页的 `<ul>` 语义结构；
   上游现在是按 `surface` 精确分支，比配方正确。

## 操作

- 原文件已重命名为 `workbuddy-settings-section.json.retired`
  （patchguard 的 `loadRecipes()` 只读 `*.json`，因此会自动跳过，无需改代码）
- 原始备份：`workbuddy-settings-section.json.bak-20261111-151144`
- 验证：`node index.js --dry` 退出码 **1 → 0**，workbuddy 那条失败告警消失

## 回滚

上游若哪天又退回到不注册 `settings.section`（或想对照旧逻辑）：

```powershell
cd D:\DeepSeek-Workspace\dsh-client-patchguard\recipes
Move-Item workbuddy-settings-section.json.retired workbuddy-settings-section.json
```

但请同时确认 `testedWith` 已对上新版本、`pristineMarkers` / `appliedMarkers` 与新产物一致，
否则仍会 anchor-miss。

## 顺带发现（未处理，供你判断）

`imagegen-settings-section` 配方报「已是补丁状态，但整份 sha256 与配方记录不同（上游有其它改动）」。
补丁本身还在、语法校验通过，属于**可接受的漂移**，本次未动。
若想让它恢复「哈希精确匹配」，需要同步更新配方里的 `patchedSha256`。
