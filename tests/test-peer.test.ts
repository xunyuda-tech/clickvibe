/**
 * Regression tests for the issue #5 root cause: a test awaiting a spawned
 * peer's response used to hang silently when the peer died, surfacing as
 * `cancelledByParent` with `fail 0` only when the event loop drained — the
 * exact flake that flipped the gate between 842/842 and 840+2 cancelled.
 * These tests pin the contract that peer death must fail loudly instead.
 *
 * Issue #7 extends the same contract to exit/cleanup waits (`awaitExit`,
 * `stop`) and to promises settling through unref'd production timers
 * (`withEventLoopLiveness`): a SIGKILLed peer keeps `exitCode === null`
 * after exit, so `exitCode === null` + bare `once(exit)` cleanup hangs
 * forever — injected below, it must fail loudly with cancelled=0.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnTestPeer, withEventLoopLiveness } from './helpers/test-peer.ts'

test('awaitResponse resolves with the peer value while the peer is alive', async () => {
  const peer = spawnTestPeer(process.execPath, [
    '--input-type=module',
    '-e',
    "console.log('hello'); setTimeout(() => {}, 60_000)",
  ])
  try {
    const wait = new Promise<string>((resolve) => {
      peer.process.stdout.setEncoding('utf8')
      peer.process.stdout.once('data', (chunk: string) => resolve(chunk.trim()))
    })
    assert.equal(await peer.awaitResponse(wait, 'stdout line'), 'hello')
    assert.equal(peer.stderrText(), '')
  } finally {
    await peer.stop()
  }
})

test('awaitResponse rejects with exit code and stderr when the peer exits first', async () => {
  const peer = spawnTestPeer(process.execPath, [
    '--input-type=module',
    '-e',
    "console.error('boom-details'); process.exit(7)",
  ])
  const never = new Promise<never>(() => {})
  await assert.rejects(peer.awaitResponse(never, 'stdout line'), (error: unknown) => {
    assert.match(String(error), /exited before stdout line arrived/)
    assert.match(String(error), /code=7/)
    assert.match(String(error), /boom-details/)
    return true
  })
  await peer.stop()
})

test('awaitResponse rejects with the signal when the peer is killed', async () => {
  const peer = spawnTestPeer(process.execPath, [
    '--input-type=module',
    '-e',
    "console.log('READY'); setInterval(() => {}, 1_000)",
  ])
  const ready = new Promise<string>((resolve) => {
    peer.process.stdout.setEncoding('utf8')
    peer.process.stdout.once('data', (chunk: string) => resolve(chunk.trim()))
  })
  assert.equal(await peer.awaitResponse(ready, 'READY on stdout'), 'READY')
  const never = new Promise<never>(() => {})
  peer.process.kill('SIGKILL')
  await assert.rejects(peer.awaitResponse(never, 'next stdout line'), /signal=SIGKILL/)
  // Cleanup after an already-exited peer must not hang waiting for an event
  // that was emitted in the past (the pre-fix `once(exit)` footgun).
  await peer.stop()
})

test('awaitResponse rejects when the peer cannot be spawned at all', async () => {
  const peer = spawnTestPeer('/nonexistent-clickvibe-test-peer', [])
  await assert.rejects(peer.awaitResponse(new Promise<never>(() => {}), 'stdout line'), /spawn error/)
  await peer.stop()
})

test('awaitExit resolves the natural exit code whenever it is awaited', async () => {
  const peer = spawnTestPeer(process.execPath, ['--input-type=module', '-e', 'process.exit(3)'])
  // Awaited only after the peer has already exited: the binding was captured
  // at spawn, so this must still resolve (a bare `once(exit)` would hang).
  const exit = await peer.awaitExit('natural exit with code 3')
  assert.equal(exit.code, 3)
  assert.equal(exit.signal, null)
})

test('awaitExit rejects with pid, signal and stderr when the peer is SIGKILLed', async () => {
  const peer = spawnTestPeer(process.execPath, [
    '--input-type=module',
    '-e',
    "console.error('kill-injection'); console.log('READY'); setInterval(() => {}, 1_000)",
  ])
  const ready = new Promise<string>((resolve) => {
    peer.process.stdout.setEncoding('utf8')
    peer.process.stdout.once('data', (chunk: string) => resolve(chunk.trim()))
  })
  assert.equal(await peer.awaitResponse(ready, 'READY on stdout'), 'READY')
  peer.process.kill('SIGKILL')
  await assert.rejects(peer.awaitExit('natural exit'), (error: unknown) => {
    assert.match(String(error), /died instead of natural exit/)
    assert.match(String(error), /signal=SIGKILL/)
    assert.match(String(error), /pid \d+/)
    assert.match(String(error), /kill-injection/)
    return true
  })
})

test('stop settles promptly after the peer already died by signal', async () => {
  const peer = spawnTestPeer(process.execPath, [
    '--input-type=module',
    '-e',
    "console.log('READY'); setInterval(() => {}, 1_000)",
  ])
  const ready = new Promise<string>((resolve) => {
    peer.process.stdout.setEncoding('utf8')
    peer.process.stdout.once('data', (chunk: string) => resolve(chunk.trim()))
  })
  assert.equal(await peer.awaitResponse(ready, 'READY on stdout'), 'READY')
  peer.process.kill('SIGKILL')
  // The pre-issue-#7 cleanup shape (`exitCode === null` guard + bare
  // `once(exit)`) hangs exactly here: the signal-killed peer has
  // `exitCode === null` but its exit event was already emitted.
  await peer.stop()
})

test('withEventLoopLiveness settles a promise that only an unref’d timer resolves', async () => {
  const released = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5)
    timer.unref?.()
  })
  await withEventLoopLiveness(released)
})
