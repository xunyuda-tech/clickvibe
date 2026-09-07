import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  classifyNullExit,
  commandCategory,
  type NullExitFacts,
  nullExitMessage,
  tailText,
} from '../src/infra/shell-failure.ts'
import { runCommand } from '../src/infra/runtime.ts'

function facts(overrides: Partial<NullExitFacts> = {}): NullExitFacts {
  return {
    category: 'git-worktree',
    timeoutMs: 60_000,
    durationMs: 500,
    signal: null,
    cancelled: false,
    hostStatus: null,
    stdoutTail: '',
    stderrTail: '',
    ...overrides,
  }
}

test('command categories derive from the program and first subcommand only', () => {
  assert.equal(commandCategory('git worktree add -b x /tmp/y abc'), 'git-worktree')
  assert.equal(commandCategory('git fetch origin --prune'), 'git-fetch')
  assert.equal(commandCategory('  gh   api repos/o/r'), 'gh-api')
  assert.equal(commandCategory('git'), 'git')
  assert.equal(commandCategory('/usr/bin/git status'), 'git-status')
  assert.equal(commandCategory('node scripts/upgrade-v0.2.mjs preview'), 'node')
  assert.equal(commandCategory(''), 'unknown')
})

test('pre-subcommand option values and operands collapse to the bare program (review F1)', () => {
  // `-c KEY=value` injects the value as the first non-flag token; the value may
  // carry a secret, so it must never become the category. `-C <path>` likewise
  // injects a filesystem path. Both fall back to the bare program name.
  const header = commandCategory('git -c http.extraheader=SECRET_TOKEN_ABC123 push origin main')
  assert.equal(header, 'git')
  assert.equal(header.includes('secret_token_abc123'), false)
  assert.equal(commandCategory('git -C /home/me/secret-project status'), 'git')
  assert.equal(commandCategory('gh repo set-default o/r --skip-confirmation'), 'gh-repo')
})

test('output tails keep the end of the stream and are capped', () => {
  assert.equal(tailText('short', 400), 'short')
  const long = `a`.repeat(600)
  const tailed = tailText(long, 400)
  assert.equal(tailed.length, 401)
  assert.ok(tailed.endsWith('a'))
  assert.equal(tailText(undefined, 400), '')
})

test('null exit classification ranks cancellation, timeout and signal evidence', () => {
  assert.equal(classifyNullExit(facts({ cancelled: true, durationMs: 90_000, signal: 'SIGKILL' })).kind, 'abort')
  assert.equal(classifyNullExit(facts({ durationMs: 60_120, signal: 'SIGKILL' })).kind, 'timeout')
  assert.equal(classifyNullExit(facts({ signal: 'SIGTERM' })).kind, 'signal')
  assert.equal(classifyNullExit(facts({ hostStatus: 'killed' })).kind, 'host-shell')
  assert.equal(classifyNullExit(facts({ stdoutTail: '', stderrTail: '' })).kind, 'host-shell')
  assert.equal(classifyNullExit(facts({ stdoutTail: 'partial output' })).kind, 'unknown')
})

test('classified reasons are readable and mention the concrete evidence', () => {
  const timeout = classifyNullExit(facts({ durationMs: 60_120, signal: 'SIGKILL' }))
  assert.match(timeout.reason, /60120ms/)
  assert.match(timeout.reason, /60000ms/)
  assert.match(timeout.reason, /SIGKILL/)
  const signal = classifyNullExit(facts({ signal: 'SIGTERM' }))
  assert.match(signal.reason, /SIGTERM/)
})

test('the null-exit error message carries category, classification and output tails', () => {
  const verdict = classifyNullExit(facts({ durationMs: 60_120, timeoutMs: 60_000 }))
  const message = nullExitMessage(
    facts({ durationMs: 60_120, timeoutMs: 60_000, stdoutTail: 'HEAD abc', stderrTail: 'fatal: lose' }),
    verdict,
  )
  assert.match(message, /命令退出码 null/)
  assert.match(message, /git-worktree/)
  assert.match(message, /timeout/)
  assert.match(message, /HEAD abc/)
  assert.match(message, /fatal: lose/)
})

function shellReturning(result: unknown & { commandGate?: never }) {
  return {
    resolve: (spec: unknown) => spec,
    run: async () => result,
  }
}

async function withCapturedDiagnostics<T>(body: () => Promise<T>): Promise<{ records: unknown[]; value: T }> {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-shell-failure-'))
  const previousHome = process.env.HOME
  const originalWarn = console.warn
  const lines: string[] = []
  process.env.HOME = home
  console.warn = (message?: unknown) => lines.push(String(message))
  try {
    await mkdir(join(home, '.clickvibe', 'state'), { recursive: true })
    const value = await body()
    return { records: lines.map((line) => JSON.parse(line)), value }
  } finally {
    console.warn = originalWarn
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

test('runCommand records full evidence for a signal-killed command without echoing the command line', async () => {
  const secret = 'ghp_definitely-secret-token'
  const { records } = await withCapturedDiagnostics(async () => {
    const shell = shellReturning({ exitCode: null, stdout: { text: '' }, stderr: { text: '' }, signal: 'SIGTERM' })
    await assert.rejects(
      runCommand({ shell } as never, `git worktree add --token ${secret} /tmp/x`, { timeoutMs: 60_000 }),
      /命令退出码 null.*signal.*SIGTERM/,
    )
  })
  const record = records.find((entry) => (entry as { event?: string }).event === 'shell-null-exit')
  assert.ok(record, 'a shell-null-exit diagnostic must be recorded')
  const fields = record as Record<string, unknown>
  assert.equal(fields.category, 'git-worktree')
  assert.equal(fields.kind, 'signal')
  assert.equal(fields.signal, 'SIGTERM')
  assert.equal(fields.timeoutMs, 60_000)
  assert.equal(typeof fields.startedAt, 'string')
  assert.equal(typeof fields.endedAt, 'string')
  assert.equal(typeof fields.durationMs, 'number')
  assert.ok(fields.reason)
  assert.equal(fields.stdoutTail, '')
  assert.equal(fields.stderrTail, '')
  // AC: secrets and the raw command line must never reach the record.
  assert.equal(JSON.stringify(record).includes(secret), false)
  assert.equal(JSON.stringify(record).includes('worktree add'), false)
})

test('runCommand classifies a null exit with no evidence as a host-shell failure', async () => {
  const { records } = await withCapturedDiagnostics(async () => {
    const shell = shellReturning({ exitCode: null, stdout: { text: '' }, stderr: { text: '' } })
    await assert.rejects(
      runCommand({ shell } as never, 'git worktree list --porcelain', { timeoutMs: 30_000 }),
      /命令退出码 null.*host-shell/,
    )
  })
  const record = records.find((entry) => (entry as { event?: string }).event === 'shell-null-exit') as Record<
    string,
    unknown
  >
  assert.equal(record.kind, 'host-shell')
})

test('runCommand classifies elapsed-past-timeout null exits as timeouts with tails attached', async () => {
  const shell = {
    resolve: (spec: unknown) => spec,
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return { exitCode: null, stdout: { text: 'creating worktree\n' }, stderr: { text: '' } }
    },
  }
  const { records } = await withCapturedDiagnostics(async () => {
    await assert.rejects(
      runCommand({ shell } as never, 'git worktree add -b b /tmp/w base', { timeoutMs: 1 }),
      /命令退出码 null.*timeout/,
    )
  })
  const record = records.find((entry) => (entry as { event?: string }).event === 'shell-null-exit') as Record<
    string,
    unknown
  >
  assert.equal(record.kind, 'timeout')
  assert.match(String(record.stdoutTail), /creating worktree/)
})

test('runCommand classifies a host-cancelled command as an abort with the marker recorded', async () => {
  const { records } = await withCapturedDiagnostics(async () => {
    const shell = shellReturning({
      exitCode: null,
      stdout: { text: '' },
      stderr: { text: '' },
      aborted: true,
      status: 'cancelled',
    })
    await assert.rejects(
      runCommand({ shell } as never, 'git fetch origin --prune', { timeoutMs: 60_000 }),
      /命令退出码 null.*abort/,
    )
  })
  const record = records.find((entry) => (entry as { event?: string }).event === 'shell-null-exit') as Record<
    string,
    unknown
  >
  assert.equal(record.kind, 'abort')
  assert.equal(record.cancelled, true)
  assert.equal(record.hostStatus, 'cancelled')
})

test('a null exit with secrets in option values leaks neither into diagnostics nor the error message', async () => {
  // Review F1 repro shape: the secret sits BEFORE the subcommand, where the
  // category token is selected. The diagnostic record and the thrown message
  // must carry the bare category and no trace of the token or path.
  const secret = 'SECRET_TOKEN_ABC123'
  const hiddenPath = '/home/me/secret-project'
  const { records } = await withCapturedDiagnostics(async () => {
    const shell = shellReturning({ exitCode: null, stdout: { text: '' }, stderr: { text: '' } })
    await assert.rejects(
      runCommand({ shell } as never, `git -c http.extraheader=${secret} -C ${hiddenPath} push`, {
        timeoutMs: 30_000,
      }),
      (error: Error) => {
        assert.equal(error.message.includes(secret), false)
        assert.equal(error.message.includes(hiddenPath), false)
        assert.match(error.message, /\[git\]/)
        return true
      },
    )
  })
  const record = records.find((entry) => (entry as { event?: string }).event === 'shell-null-exit') as Record<
    string,
    unknown
  >
  assert.equal(record.category, 'git')
  assert.equal(JSON.stringify(record).includes(secret), false)
  assert.equal(JSON.stringify(record).includes('secret-project'), false)
})

test('non-zero numeric exits keep the existing error shape without null-exit diagnostics', async () => {
  const { records } = await withCapturedDiagnostics(async () => {
    const shell = shellReturning({ exitCode: 128, stdout: { text: '' }, stderr: { text: 'not a git repository' } })
    await assert.rejects(
      runCommand({ shell } as never, 'git status', { timeoutMs: 10_000 }),
      /命令退出码 128: not a git repository/,
    )
  })
  assert.equal(
    records.some((entry) => (entry as { event?: string }).event === 'shell-null-exit'),
    false,
  )
})
