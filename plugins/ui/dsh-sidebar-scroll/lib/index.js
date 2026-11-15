/**
 * dsh-sidebar-scroll —— 宿主半。
 *
 * 这个插件只贡献浏览器端的一段样式表，宿主侧什么都不用做：空的 apply 只是让
 * Loader 拿到一行宿主条目，浏览器半通过 exports["./client"] 下发。
 */
/** 宿主插件体：本包只贡献浏览器端表现。 */
function apply() {}

export { apply };
