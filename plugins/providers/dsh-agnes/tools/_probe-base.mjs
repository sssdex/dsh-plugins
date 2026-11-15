// Probe: determine ASAR header end / data base offset empirically.
import { readFileSync } from 'node:fs'
const ASAR = 'D:/Programs/DeepSeek-Harness/resources/app.asar'
const buf = readFileSync(ASAR)
const first = buf.indexOf(0x7b, 8) // '{'
console.log('first { at', first)
// scan candidate JSON lengths
const candidates = [buf.readUInt32LE(4), buf.readUInt32LE(8), buf.readUInt32LE(12)]
const out = []
for (const len of candidates) {
  const end = first + len
  const text = buf.toString('utf8', first, Math.min(end, buf.length))
  const close = text.lastIndexOf('}')
  let ok = false
  let header
  try { header = JSON.parse(text.slice(0, close + 1)); ok = true } catch (e) { out.push(`len ${len}: parse fail ${e.message.slice(0, 60)}`) }
  if (ok) {
    out.push(`len ${len}: JSON ok, jsonBytes=${Buffer.byteLength(text.slice(0, close + 1))}`)
    const jsonBytes = Buffer.byteLength(text.slice(0, close + 1))
    // root package.json entry
    const entry = header.files['package.json']
    out.push('root package.json entry: ' + JSON.stringify({ size: entry.size, offset: entry.offset }))
    for (const pad of [0, 4, 8, 16, 32, 4096, 8192]) {
      const base = first + jsonBytes + pad
      const content = buf.subarray(base + Number(entry.offset), base + Number(entry.offset) + Math.min(120, Number(entry.size))).toString('utf8')
      out.push(`  base=${base} (pad ${pad}): ${JSON.stringify(content.slice(0, 80))}`)
    }
  }
}
console.log(out.join('\n'))
