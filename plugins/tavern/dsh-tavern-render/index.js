/**
 * Host 侧入口。
 *
 * 视觉逻辑全部在 client.js（跑在浏览器里）。Host 侧只需要存在一个可激活的
 * 插件行，让 bundle 被识别、客户端 bundle 被投递到页面。
 * 这里刻意什么都不做：不注册工具、不改上下文、不占事件。
 */

export const name = 'dsh-tavern-render';

export function apply() {
  // 无 Host 行为：渲染层在 Web 页面中完成。
}
