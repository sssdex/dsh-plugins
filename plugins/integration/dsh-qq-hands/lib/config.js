/**
 * 配置解析：不重复存密钥，直接沿用 IM Connect 已经配好的 QQ 账号。
 *
 * 依据（实测）：
 *   - 账号目录 DSH_HOME/dsh-im-connect/channels.json 里 qq_ 开头的渠道带
 *     config.appId / config.ownerOpenId / config.appSecretRef；
 *   - appSecret 不在 channels.json 里，而是走 DSH 的 credentials 服务
 *     （fs 落在 DSH_HOME/.credentials.yaml 的 refs 段），
 *     IM Connect 自己也是 `createServiceVault(ctx.credentials)` 这么取的。
 *
 * 所以这里优先用 ctx.credentials.resolve()，拿不到再退回解析 yaml —— 两条路都不通才报错。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function imConnectDir() {
  return path.join(dshHome(), 'dsh-im-connect')
}

/** DSH 的 credentials 服务在旧宿主上可能没有，全部包在 try 里。 */
async function resolveSecret(credentials, ref) {
  if (!ref) return ''
  try {
    if (credentials && typeof credentials.resolve === 'function') {
      const result = await credentials.resolve(ref)
      if (typeof result === 'string' && result.trim()) return result.trim()
      if (result && typeof result.value === 'string' && result.value.trim()) return result.value.trim()
    }
  } catch {
    // 服务不可用就走下面的文件兜底
  }
  return readYamlRef(ref)
}

/** .credentials.yaml 是简单的 `refs:` 缩进映射，不必为它引入 YAML 依赖。 */
function readYamlRef(ref) {
  const file = path.join(dshHome(), '.credentials.yaml')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (!inRefs) continue
    if (/^\S/.test(line)) break
    const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    if (match[1] !== ref) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return value.replace(/,\s*$/, '').trim()
  }
  return ''
}

/**
 * 找第一个启用的 QQ 账号。configOverride 来自插件配置（可以指定 accountId / 覆盖 openid）。
 */
export async function resolveQqAccount(options = {}, credentials) {
  const channelsFile = options.channelsFile || path.join(imConnectDir(), 'channels.json')
  let store
  try {
    store = JSON.parse(fs.readFileSync(channelsFile, 'utf8'))
  } catch (error) {
    throw new Error(`读不到 IM Connect 的账号配置 ${channelsFile}：${error?.message ?? error}。请先在「设置 → IM助理」里添加并启用 QQ 账号。`)
  }
  const channels = store?.channels && typeof store.channels === 'object' ? store.channels : {}
  const qqEntries = Object.entries(channels).filter(([, value]) => value && value.platform === 'qq')
  if (!qqEntries.length) throw new Error('IM Connect 里没有 QQ 账号，请先在「设置 → IM助理」添加 QQ 机器人账号。')

  const pick = options.accountId
    ? qqEntries.find(([id]) => id === options.accountId)
    : (qqEntries.find(([, value]) => value.enabled !== false) ?? qqEntries[0])
  if (!pick) throw new Error(`找不到 QQ 账号 ${options.accountId}`)

  const [accountId, channel] = pick
  const cfg = channel.config && typeof channel.config === 'object' ? channel.config : {}
  const appId = String(options.appId || cfg.appId || '').trim()
  if (!appId) throw new Error(`QQ 账号 ${accountId} 缺少 appId`)

  let appSecret = String(options.appSecret || cfg.appSecret || '').trim()
  if (!appSecret) appSecret = await resolveSecret(credentials, cfg.appSecretRef)
  if (!appSecret) {
    throw new Error(`QQ 账号 ${accountId} 缺少 appSecret（凭据 ${cfg.appSecretRef || '(未设置)'} 解析不到），请在 IM 助理里重新保存账号。`)
  }

  const openid = String(
    options.openid
    || cfg.ownerOpenId
    || store?.allowlist?.[accountId]?.[0]
    || '',
  ).trim()
  if (!openid) {
    throw new Error(`QQ 账号 ${accountId} 没有主人 openid（ownerOpenId/allowlist 都为空）。请先在 QQ 上给它发一句话完成绑定。`)
  }

  return {
    accountId,
    platform: 'qq',
    appId,
    appSecret,
    openid,
    cwd: channel.cwd || '',
    enabled: channel.enabled !== false,
  }
}
