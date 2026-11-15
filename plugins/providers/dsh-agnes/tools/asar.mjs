// Minimal Electron-ASAR reader: list entries / extract files, no dependencies.
// usage:
//   node asar.mjs list <prefix> <outFile>   -> write matching entry paths to outFile (never stdout)
//   node asar.mjs cat  <path>               -> print file content to stdout
//   node asar.mjs get  <path> <outFile>     -> write file content to outFile
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ASAR = 'D:/Programs/DeepSeek-Harness/resources/app.asar'

function readHeader() {
  const buf = readFileSync(ASAR)
  const start = buf.indexOf(0x7b, 8) // first '{' after the 8-byte size prefix
  const declared = buf.readUInt32LE(4)
  const text = buf.toString('utf8', start, start + declared)
  const json = text.slice(0, text.lastIndexOf('}') + 1)
  const header = JSON.parse(json)
  const baseOffset = start + Buffer.byteLength(json) // measured: 16 + 3392048
  return { buf, header, baseOffset }
}

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix === '' ? name : `${prefix}/${name}`
    if (value.files !== undefined) {
      out.push(`${p}/`)
      walk(value, p, out)
    } else {
      out.push(p)
    }
  }
  return out
}

function lookup(header, target) {
  const parts = target.split('/').filter((p) => p !== '')
  let node = header
  for (const part of parts) {
    node = node.files?.[part]
    if (node === undefined) return undefined
  }
  return node
}

const [cmd, arg1, arg2] = process.argv.slice(2)
const { buf, header, baseOffset } = readHeader()

if (cmd === 'list') {
  const all = walk(header, '', [])
  const prefix = (arg1 ?? '').replace(/\\/g, '/')
  const hits = all.filter((p) => p.includes(prefix))
  const out = arg2 ?? 'asar-list.txt'
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${hits.join('\n')}\n`, 'utf8')
  process.stdout.write(`total entries ${all.length}; matches ${hits.length}; written to ${out}\n`)
} else if (cmd === 'cat' || cmd === 'get') {
  const entry = lookup(header, arg1)
  if (entry === undefined || entry.offset === undefined) {
    process.stderr.write(`not found: ${arg1}\n`)
    process.exit(2)
  }
  const start = baseOffset + Number(entry.offset)
  const content = buf.subarray(start, start + Number(entry.size))
  if (cmd === 'cat') process.stdout.write(content)
  else {
    mkdirSync(dirname(arg2), { recursive: true })
    writeFileSync(arg2, content)
    process.stdout.write(`wrote ${arg2} (${entry.size} bytes)\n`)
  }
} else {
  process.stderr.write('usage: list <prefix> <outFile> | cat <path> | get <path> <outFile>\n')
  process.exit(1)
}
