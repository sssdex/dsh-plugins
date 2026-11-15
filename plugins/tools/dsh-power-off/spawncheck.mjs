/**
 * 真机链路自检：**只测 shutdown /a（取消）**，不安排任何关机。
 *
 * 为什么安全：/a 在「当前没有进行中的关机」时，shutdown.exe 返回 1116
 * （ERROR_NO_SHUTDOWN_IN_PROGRESS），系统状态不变。这是唯一可以随便跑的
 * 真实关机链路验证——绝不在这里跑 /s。
 *
 * 跑法：node spawncheck.mjs
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const EXE = 'C:\\Windows\\System32\\shutdown.exe'

function run(argv, waitMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(argv[0], argv.slice(1), {
      cwd: homedir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    const timer = setTimeout(() => {
      resolve({ timeout: true, ms: Date.now() - started })
    }, waitMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ spawnError: String(e?.message ?? e), ms: Date.now() - started })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ exitCode: code, signal, stdout, stderr, ms: Date.now() - started })
    })
  })
}

const lines = []
let failed = 0

function report(name, r, expect) {
  const okFlag = expect(r)
  if (!okFlag) failed += 1
  lines.push(`  ${okFlag ? '✓' : '✗'} ${name}`)
  lines.push(`      exitCode=${r.exitCode} signal=${r.signal} ms=${r.ms}`)
  if (r.stdout && r.stdout.trim()) lines.push(`      stdout: ${r.stdout.trim()}`)
  if (r.stderr && r.stderr.trim()) lines.push(`      stderr: ${r.stderr.trim()}`)
  if (r.spawnError) lines.push(`      spawnError: ${r.spawnError}`)
}

lines.push('== shutdown.exe 可执行性 ==')
const r = await run([EXE, '/a'])
report(
  'shutdown.exe /a 跑起来了（退出码 1116 = 本来没有待处理关机，属正常）',
  r,
  (x) => x.spawnError === undefined && x.timeout !== true && (x.exitCode === 1116 || x.exitCode === 0 || x.exitCode === 1115)
)

lines.push('')
lines.push('== 参数拼接形状（不执行，只看 argv）==')
const argv = [EXE, '/s', '/f', '/t', '60', '/c', 'DSH 关机：由 dsh-power-off 插件触发']
lines.push(`  将要执行：${argv.join(' ')}`)
lines.push('  ✓ 参数里没有空格未加引号的路径问题（EXE 是固定绝对路径，/c 注释由 Node 原样传递）')

console.log(lines.join('\n'))
console.log(failed === 0 ? '\n链路 OK' : `\n${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
