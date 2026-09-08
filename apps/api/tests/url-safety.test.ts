import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveValidatedHost } from '../src/lib/url-safety.js'
import { pinnedLookup } from '../src/lib/push-transport.js'

const blocked = [
  'https://127.0.0.1',
  'https://169.254.169.254/latest/meta-data',
  'https://10.0.0.1',
  'https://192.0.2.1',
  'https://198.18.0.1',
  'https://[::1]',
  'https://[fe80::1]',
  'https://[2001:db8::1]',
  'https://[::ffff:127.0.0.1]',
  'https://[::ffff:10.0.0.1]',
]

for (const url of blocked) {
  test(`rejects private or local literal ${url}`, async () => {
    await assert.rejects(
      resolveValidatedHost(url, ['https:'], false),
      /disallowed address/,
    )
  })
}

test('accepts public IPv4 and IPv6 literals', async () => {
  assert.deepEqual(await resolveValidatedHost('https://1.1.1.1', ['https:'], false), {
    address: '1.1.1.1',
    family: 4,
  })
  assert.deepEqual(await resolveValidatedHost('https://[2606:4700:4700::1111]', ['https:'], false), {
    address: '2606:4700:4700::1111',
    family: 6,
  })
})

test('pinned lookup returns only the validated address', async () => {
  const lookup = pinnedLookup({ address: '203.0.113.8', family: 4 })
  const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup('attacker.example', {}, (error, address, family) => {
      if (error) reject(error)
      else resolve({ address: address as string, family: family as number })
    })
  })
  assert.deepEqual(result, { address: '203.0.113.8', family: 4 })
})
