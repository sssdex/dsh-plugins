/**
 * 冲刺·sprint 预设的工具收窄器。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 这份插件为什么存在
 * ────────────────────────────────────────────────────────────────────────
 * 本机 2026-11-11 实测（320 会话 / 25,750 步 / 30,164 次工具调用，DSH 0.2.2-rc.1）：
 *   一步往返中位 6.3 秒、均值 19.7 秒；一轮中位 12 步、均值 32.7 步。
 *   工具 schema 是**每一步**的固定 prefill 开销：standard 会话的 request/header
 *   平均 102,610 B ≈ 25,399 tok（233 个 standard 样本逐工具均值求和，n=233）。
 *   其中 preset YAML 行能管的只有 25.4%（6,448 tok），剩下 74.6%（18,938 tok）
 *   是宿主平面/三方插件挂的，删 YAML 行删不掉 —— fast-solver 预设一行工具都不声明，
 *   header 仍是 84 个工具 / 109,143 B ≈ 27,016 tok，这就是铁证。
 *
 * 唯一能碰那 74.6% 的合法手段就是 ctx.tools.restrict()。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 这版比 file-fast 多做了什么
 * ────────────────────────────────────────────────────────────────────────
 * file-fast 只 deny 了「启动时已注册」的名字。它的实测 header 是 24 个工具 /
 * 23,962 B ≈ 5,931 tok，但里面还剩 interrupt_agent / list_agents / send_message /
 * spawn_teammate / team_task_* / wait_agent 这 9 个 —— 它们不是漏 deny，而是
 * **preset 作用域的 restrict() 根本 deny 不掉**：
 *
 *   @deepseek-ai/dsh-experimental-tool-agent-team 的 apply() 在有 Team 成员的
 *   agent 上往 **agent 自己的 scope** 注册工具（scoped.tools.register），而
 *   dsh-tools 的 view() 里写着「the viewing scope's own registrations remain
 *   exempt」—— 自己的注册不受限制。所以这 9 个工具永久占 4,799 B ≈ 1,188 tok，
 *   任何 preset 层手段都拿不掉，只能关 profile bundle。
 *
 * 本插件在 file-fast 的基础上补两件事：
 *   1. 显式 KEEP 一份「模型真正需要的」清单（22 个），并且对**每一个** KEEP 名字
 *      写清楚依据（见下表），不凭感觉；
 *   2. 把 71 个宿主平面工具全部 deny（cg、stg、ego_ 前缀 35 个、mcp__ 前缀 83 个、
 *      mcp_connector_ 前缀 30 个、remote_ 前缀 11 个、session_ 前缀、image-gen、
 *      meme、team_task_、schedule_、plugin_、workflow、subagent_fork、goal、plan-mode），
 *      只留 22 个在 header 里真实出现过、且实测有调用记录的。
 *   另外把「本预设 YAML 行自己挂的工具」也纳入统一 KEEP 校验：YAML 里少挂一个包，
 *   对应工具就不存在，restrict 因其不可见而不会报错——静默失效。verify.mjs 会查。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 为什么用 deny 不用 allow
 * ────────────────────────────────────────────────────────────────────────
 * dsh-tools 里 ToolLayer.admits() 的语义是「所有 filter 都要 admit 才可见」，即取交集。
 * allow 反复施加会越收越窄（第二轮的 allow 不会把第一轮挡掉的放回来）；
 * deny 反复施加是并集，天然可累积。所以这里维护一份「保留清单」，
 * 每轮把「已知的、且不在保留清单里的」全部写进 deny —— 单调收敛，重复安全。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 时间尺度：为什么这点 token 值得写 300 行 JS
 * ────────────────────────────────────────────────────────────────────────
 * 诚实地说：restrict() 省下的是 prefill，而本机缓存命中率 96.16%，
 * 热请求 TTFT 斜率只有 12.80 ms/1k tok（r²=0.014）。21,500 tok 在热步上
 * 只值 ~0.28 秒。真正值钱的是**冷请求**（94.95 ms/1k，r²=0.502）：
 * 会话首轮 / 破 cache 那一刻，21,500 tok ≈ 2.0 秒。
 * 剩下的收益是认知面：70 个用不上的工具不参与选型，模型不会在「要不用 cg 试试」上
 * 浪费一次往返 —— 少一步 = 中位 6.3 秒。这条比 token 值钱，但无法用静态校验证明。
 */

/**
 * 保留给模型可见的工具面。**改这里就是改这个预设的能力边界。**
 *
 * 每条后面的「依据」= 本机 25,657 步 / 30,164 次调用里的实测频次，
 * 以及 header 中该工具的序列化字节（standard 样本逐工具均值，n=233）。
 * 频次为 0 的一律不留 —— 这是这份清单唯一可复现的入选标准。
 */
const KEEP = new Set([
  // ── 文件读写核心：8,011 次调用，占全部调用的 26.6% ──────────────────
  'read',        // 2,632 次 / 421 B —— 一切编辑的前提；complete:true 下没有 read 就没有内容来源
  'write',       // 1,303 次 / 800 B —— 新建文件与整文件重写的唯一途径
  'edit',        // 2,196 次 / 1,077 B —— 局部改；比 write 省 token（不用复述全文）
  'read_image',  // 1,896 次 / 376 B —— 用户级 AGENTS.md 明确要求默认走原生视觉读图

  // ── 定位：先找再读 ──────────────────────────────────────────────────
  'glob',        //    99 次 / 721 B —— 按名找文件；不开就无法定位未知路径
  'grep',        //   995 次 / 675 B —— 按内容找；不开就只能靠 glob+read 硬扫

  // ── 执行：全部工具里调用最多的一个 ─────────────────────────────────
  'pwsh',        // 13,599 次 / 3,367 B —— 占全部调用的 45.1%，占工具墙钟 56.1%。
                 //   schema 最贵（3,367 B ≈ 833 tok），但删掉这个预设就没法干活。
                 //   注意它也是最大的单点收益：persona 里「批量任务用脚本一次跑完」
                 //   比砍 schema 值钱得多（pwsh 中位 1,750 ms / p90 11,244 ms）。
  'bash',        //     2 次 / win32 不进 header（0 B）
                 //   非 win32 上由 tool-bash 行注册、替代 pwsh。KEEP 必须成对写：
                 //   只留 pwsh 的话，linux/mac 上唯一的 shell 会被自己的 deny 掩掉。
                 //   在 Windows 上它不是注册项，restrict() 看不到它，写进 KEEP 零代价。

  // ── 后台作业：async_parse_pdf 的正确性依赖 ──────────────────────────
  'job_output',  //   237 次 / 589 B —— mineru 的 async_parse_pdf 只返回 job_id，
                 //   结果必须靠它取回。2026-11-11 的实际会话里，file-fast 第一版
                 //   漏了 job_* → 「提交成功但拿不到内容」→ 模型转去 pip install
                 //   rapidocr 自己搭 OCR 流水线（被用户批评过的那次）。
  'job_list',    //     9 次 / 161 B —— 便宜的兜底：job_output 拿错 id 时要列清单
  'job_kill',    //    69 次 / 354 B —— 长任务失控时要能停；没有它模型会去翻进程

  // ── 交付 / 澄清 ─────────────────────────────────────────────────────
  'present',          //  94 次 / 808 B —— 交付物分卡展示，是 web 端的主要交付通道
  'ask_user_question',// 144 次 / 1,243 B —— 实测中位阻塞 27.7 秒（在等你，不是在算）。
                      //   它是最贵的一个 KEEP，但删了模型会改用纯文字反问，
                      //   结果多跑一步往返（6.3 秒）来等同一个答案。留。

  // ── 任务清单：长任务的进度载体 ─────────────────────────────────────
  'todo_write',  //   121 次 / 821 B —— 只在多步任务里用；配合 persona 的「别复述进度」，
                 //   它是「不写进度汇报」的替代通道。留。

  // ── 查资料：极便宜 ─────────────────────────────────────────────────
  'web_search',  //   216 次 / 314 B —— 58 tok，全表单位 token 收益最高的工具之一
  'web_fetch',   //   745 次 / 234 B —— 58 tok，同上；两个加起来 136 tok

  // ── 技能：office-* 系列的正路 ──────────────────────────────────────
  'skill',       //    60 次 / 318 B —— docx/xlsx/pptx 盲写 OOXML 的失败成本远超 79 tok

  // ── 非纯文本读入：全部走 mineru，禁止自建流水线 ────────────────────
  'read_pdf',        //   7 次 / 991 B —— 用户级 AGENTS.md 指定的 PDF 唯一入口
  'async_parse_pdf', //   3 次 / 216 B —— 扫描件必须走它（同步版在长文档上会超时）
  'convert_to_markdown', // 3 次 / 653 B —— docx/pptx/xlsx/html 转 md 的官方通道。
                     //   频次低但替代成本高（模型会用 python-docx 手搓，慢很多）

  // ── 本机运行时路径 ─────────────────────────────────────────────────
  'load_workspace_dependencies', // 75 次 / 632 B —— 拿 python/node 绝对路径。
                     //   缺了它，pwsh 里 `python` 找不到 → 模型开始猜路径 → 多跑 2~3 步
  'working_directory', // 6 次 / 205 B —— 51 tok，且是「cd 到目录」的干净做法
  'open_local_file',  // 11 次 / 772 B —— 用户点开文件的通道；191 tok 换一次少走一步

  // ── 压缩组的工具行不放这里 ────────────────────────────────────────
  // tool-result-pruner 的阈值刻意保持 8192，不调小：
  // surfaceOp: replace 会重写历史消息 → 破 cache → 每步退回冷请求价格。
]);

/**
 * restrict() 明确拒绝点名的保留名（PTC 传输层）。
 *
 * dsh-tools 源码里写死：`[...allow, ...deny].includes("run_code")` 直接 throw
 * 「tools.restrict() cannot name reserved PTC mode presentation transport」。
 * 所以 run_code 必须从 deny 名单里剔除 —— 但**不要**把它写进 KEEP：
 * 它的可见性由 PTC executor 决定，不归我们管；写进 KEEP 只会让日志误以为我们在放行它。
 */
const RESERVED = new Set(['run_code']);

export const inject = ['tools'];
export const name = 'sprint-restrict';

/**
 * 重入与幂等守卫（2026-11-11 实机死循环事故的修复，一字不改地沿用 file-fast）。
 *
 * 症状：预设装进 profile bundles 后，每次启动 host 满核空转、一直不 ready，
 *   约两分半被外壳掐掉（崩溃日志只有一行 patchguard warn，没有堆栈）。
 *
 * 原因：ToolsService 的 ScopedLayers 变更回调里写着
 *   `this.ctx.emit("tools/change")` —— 而 restrict() 正是往 layer.restrictions
 *   append 一项，等于「restrict → tools/change → restrict」构成无出口的微任务循环。
 *   事件是异步派发的，所以不栈溢出、不打日志，只持续占满一个核。
 *
 * 修法（两道闸，缺一不可）：
 *   1. applying：restrict 期间再收到 tools/change 直接返回，切断自触发；
 *   2. lastDenyKey：deny 名单与上次下发完全一致时不再调用 restrict —— 幂等。
 *      只靠 applying 不够：等异步派发回来时 applying 已经落回 false 了。
 *   只靠 lastDenyKey 也不够：第一次下发的瞬间就会重入，此时 key 还没写入。
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
    // 用**全局视图**取名字，这是本函数唯一安全的选择。
    //
    // 理由（读 dsh-tools/lib/index.js 的 view() 得到）：
    //   view(scope) 的 inherited = 全局层的工具 + 作用域链上各层工具（不含自己那层），
    //   knownNames = inherited + own，restrictableNames = inherited。
    //   restrict() 只接受 restrictableNames 里的名字，多一个就整批抛
    //   "tools.restrict() names unknown global tool ..."，一次 deny 全部作废。
    //
    //   view(undefined) 时 own 不存在，所以 knownNames === restrictableNames === 全局工具。
    //   而全局工具是**任何** scope 的 restrictableNames 的子集（inherited 从 global 起步），
    //   所以「取全局视图的名字」永远不可能触发那个拒绝条件。
    //
    // 代价（如实记）：作用域链上祖先层注册、但不在全局层的工具不会被 deny。
    //   本机实测这不成问题 —— 宿主平面那 74.6%（cg / ego_* / mcp__* / remote_* /
    //   send_meme / session_* / image-gen …）全部是 profile bundle 注册的**全局**工具，
    //   用全局视图就能全部挡掉（file-fast 的实测 header 24 工具 / 23,962 B 就是这么来的）。
    //
    //   另有一类**无论怎么改都挡不掉**的：agent 自己 scope 的注册。dsh-tools 的 view()
    //   注释写得很明确 "the viewing scope's own registrations remain exempt"。
    //   @deepseek-ai/dsh-experimental-tool-agent-team 在有 Team 成员的 agent 上正是用
    //   agent 自己的 agent.ctx 注册 interrupt_agent / list_agents / send_message /
    //   spawn_teammate / team_task_* / wait_agent 这 9 个 —— 实测 4,799 B ≈ 1,188 tok，
    //   永久留在 header 里，只有关掉 profile 的 agent-team bundle 才能去掉。
    const view = ctx.tools.view(undefined);
    known = view?.knownNames;
    if (!(known instanceof Set)) throw new TypeError('view(undefined).knownNames 不可用');
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
  // 排序后再比，避免 Set 迭代顺序变化造成假「变化」。
  const key = [...deny].sort().join('\n');
  if (key === lastDenyKey) return 0;
  if (applying) return 0;
  applying = true;
  try {
    ctx.tools.restrict({ deny });
    lastDenyKey = key;
    return deny.length;
  } catch (error) {
    // 这里以前是全空 catch，导致「API 用错」和「正常无工具可挡」在日志里一模一样。
    warn?.(`restrict() 被拒绝: ${error?.message ?? error}`);
    return 0;
  } finally {
    applying = false;
  }
}

export function apply(ctx) {
  // 注意：这里**不要**导出 Config。
  //
  // cordis 的 plugin.Config 必须是 StandardSchemaV1（带 `~standard.validate`）。
  // 本包是 link 安装、目录下没有 node_modules，import 不到
  // `@deepseek-ai/schemastery`，所以也写不出 z.object()。
  // 2026-11-11 的故障：file-fast 的 tune.js 曾用 schemastery 的 JSON 描述字面量
  // 当 Config，cordis 拿它去调 .validate，整个预设报
  // 「Cannot read properties of undefined (reading 'validate')」，两条预设行一起挂掉。
  // 本插件不读任何 config，所以连这个风险入口都没有。

  const warn = (message) => {
    try {
      ctx.logger('sprint-restrict').warn(message);
    } catch {
      // logger 服务不可用就算了，不要因为打日志把预设搞挂。
    }
  };

  denyTheRest(ctx, warn);
  // 后注册的工具（MCP 服务器、灵枢、各类全局插件）在这里被挡在模型视野之外。
  // 首次注册通常早于 MCP 完成握手，所以这一行不是可选项。
  ctx.on('tools/change', () => {
    denyTheRest(ctx, warn);
  });
}
