/**
 * dsh-sidebar-scroll —— 浏览器半。
 *
 * 只做一件事：往 <head> 插一段 <style>，让 DSH 右侧栏每个 tab 的正文可以上下滚动。
 * 不注册插槽、不依赖任何客户端包，所以 inject 为空。
 */
window.__ModuleLoader__.load({
	id: "dsh-sidebar-scroll",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 注入的样式表元素 id：重复装载时用来去重。 */
		const STYLE_ID = "dsh-sidebar-scroll-css";

		const CSS = `
/* dsh-sidebar-scroll —— 让 DSH 右侧栏每个 tab 的正文可以上下滚动。
 *
 * 起因：核心 @deepseek-ai/dsh-client-ui-sidebar-right 给 tab 正文容器写死了
 *   height: 100%; overflow: hidden;
 * 正文一旦比 pane 高（例如「开始」guide 里注册的 tab 类型一多），超出的部分就被直接裁掉；
 * 而外层 dockkit 的 .paneBody 虽然写着 overflow: auto，它自己却没有溢出可滚，
 * 于是列表上下两头都够不到。
 *
 * 修法分两步：
 *   1) 让每个 tab 正文自己成为滚动容器（overflow-y: auto）；
 *   2) guide 原本是 justify-content: center（条目少时要在正文里居中），内容超高时
 *      居中会把顶部内容顶到滚动区上边界之外、滚不回去 → 改成从顶部排起，并补上
 *      一对等分生长的前后垫片：内容比容器短时两个垫片平分空白，观感依然是居中的。
 *
 * 选择器只用核心输出的 data 属性（data-sidebar-right-tab / data-sidebar-right-guide），
 * 不用构建时的哈希类名，升级后也不容易失效。
 */
div[data-sidebar-right-tab] {
	overflow-y: auto !important;
	overflow-x: hidden !important;
	overscroll-behavior: contain;
}

div[data-sidebar-right-tab] [data-sidebar-right-guide] {
	justify-content: flex-start !important;
}

div[data-sidebar-right-tab] [data-sidebar-right-guide]::before {
	content: "";
	flex: 1 1 0 !important;
	min-height: 0 !important;
}

div[data-sidebar-right-tab] [data-sidebar-right-guide]::after {
	flex: 1 1 0 !important;
	min-height: 0 !important;
}
`;

		/**
		 * 把样式表插到 <head> 末尾（幂等：已存在就直接返回）。
		 * @param ctx - 客户端根上下文；本插件不需要它，留着是为了符合 apply(ctx) 的签名。
		 */
		function apply(ctx) {
			void ctx;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.append(style);
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
