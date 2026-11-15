/**
 * file-fast 预设的「工具收窄器」。
 *
 * 实测依据（2026-11-11，本机 254 个历史会话）：
 *   standard 会话每步注入 82~112 个工具，schema 约 104KB ≈ 3 万 token，
 *   其中 29 个工具在 254 个会话里一次都没被调用过。
 *   工具 schema 是每一步的固定开销，且数量越多选错工具的概率越高——
 *   GitHub Copilot 把工具从 40 降到 13，首 token 延迟 -190ms、成功率 +2~5pp。
 *
 * 为什么用 deny 而不是 allow：
 *   掩码语义是「所有 filter 都要 admit 才可见」，即取交集。
 *   allow 反复施加会越收越窄（第二轮的 allow 不会把第一轮挡掉的放回来）；
 *   deny 反复施加是并集，天然可累积。所以这里维护一份「保留清单」，
 *   每轮把「已知的、且不在保留清单里的」全部写进 deny——单调收敛，重复安全。
 *
 * 为什么要在 tools/change 上重跑：
 *   preset 是启动期激活的，激活那一刻 MCP、灵枢、各类全局插件可能还没注册完；
 *   allow 名字未知会让 restrict() 直接抛错，所以只处理「此刻已知」的名字，
 *   等新工具注册进来时再补一轮 deny。
 */

/** 保留给模型可见的工具面。改这里就是改这个预设的能力边界。 */
const KEEP = new Set([
  // 文件读写主力
  'read',
  'write',
  'edit',
  'read_image',
  // 定位：先找再读
  'glob',
  'grep',
  // 执行：跑脚本 / python / 批量处理
  'pwsh',
  'bash',
  // 非纯文本读入
  'convert_to_markdown',
  'read_pdf',
  'async_parse_pdf',
  // pdf-mineru 的 async_parse_pdf 只返回 job_id，结果必须靠 job_output 取回。
  // 少了这一个，扫描件会「提交成功但拿不到内容」——2026-11-11 实际会话里
  // 模型就是这样拿不到结果，转而去 pip install OCR 自己搭流水线。
  'job_output',
  'job_kill',
  'job_list',
  // 交付 / 提问 / 打开文件
  'present',
  'open_local_file',
  'ask_user_question',
  // 取本机 python / node 路径
  'load_workspace_dependencies',
  // 技能：office-* 系列是 docx/xlsx/pptx 的正路
  'skill',
]);

/** restrict() 明确拒绝点名的保留名（PTC 传输层），必须从 deny 里剔除。 */
const RESERVED = new Set(['run_code']);

export const inject = ['tools'];
export const name = 'file-fast-restrict';

/**
 * 重入与幂等守卫（2026-11-11 实机事故的修复）。
 *
 * 症状：把这个预设加进 profile bundles 后，桌面端每次启动 host 满核空转，
 *   一直不 ready，约两分半后被外壳掐掉（崩溃日志只有一行 patchguard warn）。
 *
 * 原因：ctx.tools.restrict({ deny }) 自身会触发一次 tools/change。而 restrict.js
 *   正是在 tools/change 上重跑 denyTheRest —— 于是「restrict → change → restrict」
 *   构成无出口的微任务循环：事件是异步派发的，所以不会栈溢出，只会一直占满一个核，
 *   也不打任何日志。
 *
 * 修法（两道闸，缺一不可）：
 *   1. applying：restrict 期间再收到 tools/change 直接返回，切断自触发；
 *   2. lastDeny：deny 名单与上次下发完全一致时不再调用 restrict —— 幂等，
 *      工具面没变化就不该再产生事件。
 */
let applying = false;
let lastDenyKey = '';

/**
 * 把当前已知且不在保留清单里的工具全部 deny 掉。
 * @param ctx - preset scope 上的插件上下文
 * @param warn - 出错时的记录函数；不传就静默（首次同步调用时 logger 可能还没好）
 * @returns 本次新 deny 的数量（仅用于日志）
 */
function denyTheRest(ctx, warn) {
  let known;
  try {
    // 全局视图：preset scope 能限制的名字 = 全局 + 祖先链，全局是它的子集，
    // 所以用全局视图取名字永远不会凑进「此 scope 不可限制」的项。
    known = ctx.tools.view(undefined).knownNames;
  } catch (error) {
    warn?.(`读取工具清单失败: ${error?.message ?? error}`);
    return 0;
  }
  const deny = [];
  for (const toolName of known) {
    if (KEEP.has(toolName) || RESERVED.has(toolName)) continue;
    deny.push(toolName);
  }
  if (deny.length === 0) return 0;
  // 幂等：与上次下发完全相同的名单不再 restrict（restrict 自身会再发 tools/change）。
  const key = [...deny].sort().join('\n');
  if (key === lastDenyKey) return 0;
  if (applying) return 0;
  applying = true;
  try {
    ctx.tools.restrict({ deny });
    lastDenyKey = key;
    return deny.length;
  } catch (error) {
    warn?.(`restrict() 被拒绝: ${error?.message ?? error}`);
    return 0;
  } finally {
    applying = false;
  }
}

export function apply(ctx) {
  // 关键：这里的 catch 曾经是全空的，导致「API 用错」和「正常无工具可挡」
  // 在日志里长得一模一样。现在失败会打一条 warn。
  const warn = (message) => {
    try {
      ctx.logger('file-fast-restrict').warn(message);
    } catch {
      // logger 服务不可用就算了，不要因为打日志把预设搞挂。
    }
  };

  denyTheRest(ctx, warn);
  // 后注册的工具（MCP 服务器、灵枢、各类全局插件）在这里被挡在模型视野之外。
  ctx.on('tools/change', () => {
    denyTheRest(ctx, warn);
  });
}
