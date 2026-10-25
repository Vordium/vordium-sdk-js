// A private key never appears in an error, a log line, a string form or a JSON form of what the SDK returns.
import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import * as sdk from '../dist/esm/index.js'

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const HEX = KEY.slice(2)

function noKey(text) {
  assert.ok(!String(text).toLowerCase().includes(HEX.slice(0, 40)), `the key appears in: ${String(text).slice(0, 120)}`)
}

test('a malformed key is refused without its value', () => {
  for (const bad of [KEY.slice(0, 64) + 'zz', HEX.slice(0, 62) + 'zz', KEY + '00', KEY.slice(0, 60), ' ' + KEY.slice(0, 65) + 'g']) {
    let err
    try { sdk.keySigner(bad) } catch (e) { err = e }
    assert.ok(err instanceof sdk.InvalidRequest, 'refused as InvalidRequest')
    noKey(err.message); noKey(String(err)); noKey(inspect(err, { depth: 5 })); noKey(err.stack)
  }
})

test('an out-of-range key is refused without its value', () => {
  let err
  try { sdk.keySigner('0x' + '0'.repeat(64)) } catch (e) { err = e }
  assert.ok(err instanceof sdk.InvalidRequest)
  noKey(String(err) + err.stack)
})

test('a signer from a key does not show the key in any printed form', async () => {
  const s = sdk.keySigner(KEY)
  const s2 = sdk.keySigner(HEX)
  assert.equal(await s.getAddress(), await s2.getAddress())
  for (const t of [inspect(s, { depth: 9, showHidden: true }), String(s), JSON.stringify(s)]) noKey(t)
})

test('no source file writes to the console', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = new URL('../src/', import.meta.url)
  const hits = readdirSync(dir).filter((f) => f.endsWith('.ts')).filter((f) => /console\.|process\.(stdout|stderr)/.test(readFileSync(new URL(f, dir), 'utf8')))
  assert.deepEqual(hits, [])
})
