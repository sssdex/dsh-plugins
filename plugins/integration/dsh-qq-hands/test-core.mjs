/**
 * 核心模块自测：状态账本 / QQ 客户端 / 回复拦截器 / 媒体类型判定 / 表情库检索。
 * 全程用 mock fetch，不发真实请求 —— 真发消息的验收在 e2e.mjs 里做。
 *
 * 跑法：node --test test-core.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createState } from './lib/state.js'
import { createQqClient, mediaFileType, QqApiError } from './lib/qq.js'
import { installQqInterceptor } from './lib/intercept.js'
import { searchMemes, memeLibraryInfo } from './lib/memes.js'
import { splitBubbles } from './lib/burst.js'

function tempStateFile(tag) {
  return path.join(os.tmpdir(), `dsh-qq-hands-test-${tag}-${process.pid}-${Date.now()}.json`)
}

function makeMockFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const href = String(url)
    const record = { url: href, init, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(record)
    // token 接口单独应答，否则每个用例都要重复写一遍。
    if (href.includes('getAppAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'FAKE', expires_in: 7200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const result = await handler(record, calls.length)
    if (result instanceof Response) return result
    return new Response(JSON.stringify(result?.body ?? {}), {
      status: result?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}

// ------------------------------------------------------------------ 状态账本

test('state: seq 单调递增且跨实例可续用', () => {
  const file = tempStateFile('seq')
  const a = createState(file)
  const s1 = a.nextSeq('dm:x')
  const s2 = a.nextSeq('dm:x')
  assert.deepEqual([s1, s2], [1, 2])
  a.flush()
  const b = createState(file)
  assert.equal(b.nextSeq('dm:x'), 3)
  fs.rmSync(file, { force: true })
})

test('state: 被动回复预算按 msg_id 记账，用完返回 0', () => {
  const file = tempStateFile('budget')
  const state = createState(file)
  state.recordInbound('dm:x', 'MSG1')
  assert.equal(state.passiveBudget('dm:x').remaining, 3)
  state.countReply('MSG1')
  state.countReply('MSG1')
  assert.equal(state.passiveBudget('dm:x').remaining, 1)
  state.countReply('MSG1')
  assert.equal(state.passiveBudget('dm:x').remaining, 0)
  // 凭据过期后同样不给额度
  state.recordInbound('dm:x', 'MSG2')
  const target = state.target('dm:x')
  target.lastMsgAt = Date.now() - 61 * 60 * 1000
  assert.equal(state.passiveBudget('dm:x').remaining, 0)
  fs.rmSync(file, { force: true })
})

// ------------------------------------------------------------------ 媒体类型

test('qq: 富媒体类型按魔数判定', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
  assert.equal(mediaFileType('a.png', png), 1, 'PNG 应为图片')
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
  assert.equal(mediaFileType('a.bin', jpeg), 1, '改名成 .bin 的 JPEG 仍应为图片')
  const silk = Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3'), Buffer.alloc(16)])
  assert.equal(mediaFileType('voice.bin', silk), 3, 'SILK 应为语音')
  assert.equal(mediaFileType('report.pdf', Buffer.from('%PDF-1.7')), 4, 'PDF 应为文件')
  assert.equal(mediaFileType('clip.mp4', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])), 2, 'MP4 应为视频')
})

// ------------------------------------------------------------------ QQ 客户端

test('qq: 发文字会按句拆成多条气泡并递增 msg_seq', async () => {
  const file = tempStateFile('burst')
  const state = createState(file)
  const mock = makeMockFetch(() => ({ body: { id: 'm1', timestamp: 1 } }))
  const client = createQqClient({ appId: '1', appSecret: 's', fetchImpl: mock, state })
  const target = client.target('dm', 'OPENID')
  const result = await client.sendText(target, '早餐吃了吗？我煮了饭。要不要一起看海？', { maxBubbles: 3, minGapMs: 0, maxGapMs: 0 })
  assert.equal(result.bubbles, 3)
  const posts = mock.calls.filter((call) => call.url.endsWith('/messages'))
  assert.equal(posts.length, 3, '应该有 3 次 messages 请求')
  const seqs = posts.map((call) => call.body.msg_seq)
  assert.deepEqual(seqs, [1, 2, 3], 'msg_seq 必须递增')
  // 没有被动凭据时必须走主动消息（不带 msg_id）
  assert.ok(posts.every((call) => !('msg_id' in call.body)), '无凭据时不应带 msg_id')
  fs.rmSync(file, { force: true })
})

test('qq: 有被动凭据时带 msg_id，额度用完自动转主动', async () => {
  const file = tempStateFile('passive')
  const state = createState(file)
  state.recordInbound('dm:OPENID', 'MSG9')
  const mock = makeMockFetch(() => ({ body: { id: 'm2' } }))
  const client = createQqClient({ appId: '1', appSecret: 's', fetchImpl: mock, state })
  const target = client.target('dm', 'OPENID')
  await client.sendText(target, '好呀。', { minGapMs: 0, maxGapMs: 0 }) // 单句 → 1 条
  assert.equal(mock.calls.filter((c) => c.url.endsWith('/messages')).length, 1, '1 次 messages 请求')
  const first = mock.calls.find((c) => c.url.endsWith('/messages'))
  assert.equal(first.body.msg_id, 'MSG9')
  // 把额度耗光后必须不再带 msg_id
  state.countReply('MSG9'); state.countReply('MSG9'); state.countReply('MSG9')
  const before = mock.calls.filter((c) => c.url.endsWith('/messages')).length
  await client.sendText(target, '再说一句。', { minGapMs: 0, maxGapMs: 0 })
  const next = mock.calls.filter((c) => c.url.endsWith('/messages'))[before]
  assert.ok(!('msg_id' in next.body), '额度用尽后应转主动消息')
  fs.rmSync(file, { force: true })
})

test('qq: 平台拒绝时抛出带 err_code 的错误', async () => {
  const file = tempStateFile('reject')
  const state = createState(file)
  const mock = makeMockFetch(() => ({ status: 400, body: { code: 40054009, message: '主动消息被拒绝' } }))
  const client = createQqClient({ appId: '1', appSecret: 's', fetchImpl: mock, state })
  await assert.rejects(
    () => client.sendText(client.target('dm', 'O'), '你好。', { minGapMs: 0, maxGapMs: 0 }),
    (error) => error instanceof QqApiError && error.errCode === 40054009,
  )
  fs.rmSync(file, { force: true })
})

test('qq: markdown 被拒会退回纯文本重发', async () => {
  const file = tempStateFile('md')
  const state = createState(file)
  let markdownAttempts = 0
  const mock = makeMockFetch((call) => {
    if (call.body.msg_type === 2) {
      markdownAttempts += 1
      return { status: 400, body: { code: 50056, message: 'no markdown permission' } }
    }
    return { body: { id: 'ok' } }
  })
  const client = createQqClient({ appId: '1', appSecret: 's', fetchImpl: mock, state })
  const result = await client.sendText(client.target('dm', 'O'), '一句话。', { markdown: true, minGapMs: 0, maxGapMs: 0 })
  assert.equal(markdownAttempts, 1)
  assert.equal(result.ok, true)
  assert.ok(mock.calls.some((c) => c.body.msg_type === 0), '应有一次纯文本兜底')
  fs.rmSync(file, { force: true })
})

// ------------------------------------------------------------------ 拦截器

test('intercept: 把适配器的一次文字发送拆成多条并接管 msg_seq', async () => {
  const file = tempStateFile('intercept')
  const state = createState(file)
  const inner = makeMockFetch(() => ({ body: { id: 'ok' } }))
  const fakeTarget = { fetch: inner }
  const interceptor = installQqInterceptor({ state, config: { maxBubbles: 3, minGapMs: 0, maxGapMs: 0 }, fetchTarget: fakeTarget })
  try {
    const url = 'https://api.sgroup.qq.com/v2/users/OPENID/messages'
    const res = await fakeTarget.fetch(url, {
      method: 'POST',
      headers: { authorization: 'QQBot t', 'content-type': 'application/json' },
      body: JSON.stringify({ content: '第一句。第二句。第三句。', msg_type: 0, msg_seq: 99, msg_id: 'USERMSG' }),
    })
    assert.equal(res.status, 200)
    assert.equal(inner.calls.length, 3, '一次调用应变成 3 次真实请求')
    assert.deepEqual(inner.calls.map((c) => c.body.msg_seq), [1, 2, 3], 'seq 由拦截器接管')
    assert.ok(inner.calls.every((c) => c.body.msg_id === 'USERMSG'), 'msg_id 必须保留')
    assert.ok(inner.calls.every((c) => !('content-length' in (c.init.headers || {}))), '不能带过期的 content-length')
    // msg_id 被记进账本，被动额度同步扣减
    assert.equal(state.passiveBudget('dm:OPENID').msgId, 'USERMSG')
    assert.equal(state.passiveBudget('dm:OPENID').remaining, 0, '3 条气泡吃掉 3 次额度')
  } finally {
    interceptor.dispose()
    assert.equal(fakeTarget.fetch, inner, 'dispose 必须还原 fetch')
    fs.rmSync(file, { force: true })
  }
})

test('intercept: 富媒体消息只校正 msg_seq，不拆分', async () => {
  const file = tempStateFile('media')
  const state = createState(file)
  const inner = makeMockFetch(() => ({ body: {} }))
  const fakeTarget = { fetch: inner }
  const interceptor = installQqInterceptor({ state, config: { maxBubbles: 3, minGapMs: 0, maxGapMs: 0 }, fetchTarget: fakeTarget })
  try {
    await fakeTarget.fetch('https://api.sgroup.qq.com/v2/users/O/messages', {
      method: 'POST',
      body: JSON.stringify({ msg_type: 7, media: { file_info: 'FI' }, msg_seq: 5 }),
    })
    assert.equal(inner.calls.length, 1)
    assert.equal(inner.calls[0].body.media.file_info, 'FI')
    assert.equal(inner.calls[0].body.msg_seq, 1)
  } finally {
    interceptor.dispose()
    fs.rmSync(file, { force: true })
  }
})

test('intercept: 第一条就被拒时把平台响应原样交回去', async () => {
  const file = tempStateFile('reject')
  const state = createState(file)
  const inner = makeMockFetch(() => ({ status: 400, body: { code: 50056 } }))
  const fakeTarget = { fetch: inner }
  const interceptor = installQqInterceptor({ state, config: { maxBubbles: 3, minGapMs: 0, maxGapMs: 0 }, fetchTarget: fakeTarget })
  try {
    const res = await fakeTarget.fetch('https://api.sgroup.qq.com/v2/users/O/messages', {
      method: 'POST',
      body: JSON.stringify({ content: '甲。乙。丙。', msg_type: 0, msg_seq: 1 }),
    })
    assert.equal(res.status, 400)
    assert.equal(inner.calls.length, 1, '第一条失败后不应继续发后面的气泡')
  } finally {
    interceptor.dispose()
    fs.rmSync(file, { force: true })
  }
})

// ------------------------------------------------------------------ 表情库

test('memes: 中文关键词能命中本机表情库', async () => {
  const info = await memeLibraryInfo()
  assert.ok(info.count > 0, `表情库应有图，实际 ${info.count}`)
  const hits = await searchMemes('生气', { limit: 3 })
  assert.ok(hits.length > 0, '「生气」应能搜到图')
  assert.ok(fs.existsSync(hits[0].file), '命中结果必须是真实存在的文件')
  const lazy = await searchMemes('干饭', { limit: 3 })
  assert.ok(lazy.length > 0, '「干饭」应能搜到图')
})

test('burst: splitBubbles 与客户端配合不会丢内容', () => {
  const input = '第一句。第二句！第三句？'
  const bubbles = splitBubbles(input, { maxBubbles: 2 })
  assert.ok(bubbles.length <= 2)
  assert.equal(bubbles.join('').replace(/\s/g, ''), input.replace(/\s/g, ''))
})
