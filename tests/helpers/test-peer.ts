/**
 * Spawn helper for tests that talk to a real child process (issue #5, #7).
 *
 * Root cause this primitive enforces: awaiting a peer's response with a bare
 * `once(child.stdout, 'data')` / resolver-queue promise silently hangs forever
 * when the peer dies, and node:test then reports the still-pending test as
 * `cancelledByParent` ("Promise resolution is still pending but the event loop
 * has already resolved") with `fail 0` — a run-to-run flip that hides the real
 * trigger (peer exit) instead of reporting it. Tying every peer wait to the
 * peer's lifetime here makes that failure mode impossible to write: a dead
 * peer fails the awaiting test immediately with its exit code, signal and
 * captured stderr. Healthy peers behave exactly like a plain `spawn`.
 *
 * Exit waits ride the exit binding captured at spawn time (`awaitExit` /
 * `stop`): a bare `once(process, 'exit')` registered after the peer already
 * died never settles, and `exitCode === null` cannot detect that state — a
 * signal-killed process keeps `exitCode === null` after exit (issue #7).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export interface TestPeerExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface TestPeer {
  readonly process: ChildProcess
  /** Everything the peer has written to stderr so far, for failure messages. */
  stderrText(): string
  /**
   * Await a response the peer must produce while alive. Resolves with the
   * wait's value; rejects immediately when the peer exits first, so peer
   * death is a loud, diagnosable failure instead of a silent cancellation.
   */
  awaitResponse<T>(wait: Promise<T>, what: string): Promise<T>
  /**
   * Await the peer's natural exit. The wait rides the exit binding captured
   * at spawn, so it can never miss an exit that already happened. Resolves
   * with the exit code; death by signal or failed spawn rejects with pid,
   * code, signal and stderr.
   */
  awaitExit(what: string): Promise<TestPeerExit>
  /** Kill the peer if it is still alive and resolve once it is gone. */
  stop(): Promise<void>
}

export function spawnTestPeer(command: string, args: readonly string[], options: SpawnOptions = {}): TestPeer {
  const peer = spawn(command, args, options)
  let stderr = ''
  peer.stderr?.setEncoding('utf8')
  peer.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  // A failed spawn emits 'error' and never 'exit' (e.g. ENOENT); both must
  // settle `exited` or the guard itself would hang on the same footgun.
  let spawnError = ''
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    peer.once('exit', (code, signal) => resolve({ code, signal }))
    peer.once('error', (error: Error) => {
      spawnError = error.message
      resolve({ code: null, signal: null })
    })
  })
  return {
    process: peer,
    stderrText: () => stderr,
    awaitResponse(wait, what) {
      // The losing promise must never surface as an unhandled rejection.
      wait.then(
        () => {},
        () => {},
      )
      const peerDied = exited.then(({ code, signal }) => {
        const diagnostics = stderr ? `\npeer stderr:\n${stderr}` : ''
        const failure = spawnError ? ` spawn error: ${spawnError}` : ''
        throw new Error(
          `test peer (pid ${peer.pid}) exited before ${what} arrived: code=${code} signal=${signal}${failure}${diagnostics}`,
        )
      })
      peerDied.catch(() => {})
      return Promise.race([wait, peerDied])
    },
    // `once(exit)` on an already-exited peer never settles (the event was
    // emitted in the past), which is the same silent-hang footgun the guard
    // exists to remove — so cleanup goes through here, never through a bare
    // `once(process, 'exit')` after the peer may have died. Liveness is
    // `exitCode === null && signalCode === null`: a signal-killed peer has
    // `exitCode === null` forever, so exitCode alone cannot decide aliveness.
    async awaitExit(what: string): Promise<TestPeerExit> {
      const { code, signal } = await exited
      if (code !== null) return { code, signal }
      const diagnostics = stderr ? `\npeer stderr:\n${stderr}` : ''
      const failure = spawnError ? ` spawn error: ${spawnError}` : ''
      throw new Error(
        `test peer (pid ${peer.pid}) died instead of ${what}: code=${code} signal=${signal}${failure}${diagnostics}`,
      )
    },
    async stop() {
      if (peer.exitCode === null && peer.signalCode === null) peer.kill()
      await exited
    },
  }
}

/**
 * Some production timers are deliberately unref'd — the Remote Git
 * coordinator's queue-timeout timer, so a queued entry never holds the host
 * process open. In an otherwise quiet event loop such a timer never fires and
 * a promise that settles only through it never settles: the process exits
 * underneath the await (issue #7 repro: exit 13, "unsettled top-level await").
 * A test awaiting that kind of promise must declare its own liveness instead
 * of riding ambient handles: this holds one ref'd timer for the duration of
 * the wait, keeping the loop — and only the loop — explicitly alive.
 */
export async function withEventLoopLiveness<T>(awaited: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 60_000)
  try {
    return await awaited
  } finally {
    clearInterval(keepAlive)
  }
}
