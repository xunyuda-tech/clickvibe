import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureWorktree } from '../src/agent/worktree.ts'
import { issueKey, loadWorkflow } from '../src/infra/state.ts'
import { activateV02Home, initFixtureRepository } from './helpers/v02-home.ts'

interface Gate {
  command: string
  release: () => void
}

/**
 * Controllable fake shell: every response is canned like worktree-branches's
 * harness, but `git worktree list --porcelain` parks on an external gate so a
 * test can hold one ensureWorktree call mid-preparation.
 */
function makeShell(scenario: { records: () => string }) {
  const commands: string[] = []
  const gates: Gate[] = []
  let unparked = false
  const shell = {
    resolve(spec: unknown) {
      return spec
    },
    async run(spec: { command: string }) {
      commands.push(spec.command)
      if (spec.command === 'git worktree list --porcelain') {
        await new Promise<void>((resolve) => {
          // Only the first probe parks; later probes pass so a cross-workflow
          // call can complete while the first is still held.
          if (unparked || gates.length > 0) {
            resolve()
            return
          }
          gates.push({ command: spec.command, release: resolve })
        })
      }
      if (spec.command === 'git fetch origin --prune')
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD')
        return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
      if (spec.command.endsWith('; echo $?')) return { exitCode: 0, stdout: { text: '0' }, stderr: { text: '' } }
      if (spec.command.startsWith('git rev-parse --short'))
        return { exitCode: 0, stdout: { text: 'abc1234' }, stderr: { text: '' } }
      if (spec.command.startsWith('git merge-base --is-ancestor'))
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command === 'git worktree list --porcelain')
        return { exitCode: 0, stdout: { text: scenario.records() }, stderr: { text: '' } }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    },
  }
  return {
    commands,
    gates,
    shell,
    /** Release parked calls and let any later probe pass straight through. */
    unparkAll() {
      unparked = true
      for (const gate of gates.splice(0)) gate.release()
    },
  }
}

async function setupEnvironment(tag: string) {
  const root = await mkdtemp(join(tmpdir(), `clickvibe-worktree-${tag}-`))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const worktreeRoot = join(root, 'worktrees')
  const previousHome = process.env.HOME
  process.env.HOME = home
  await mkdir(join(home, '.clickvibe'), { recursive: true })
  await initFixtureRepository(repo)
  await activateV02Home(home, { 'o/r': repo }, { worktreeRoot })
  return {
    root,
    home,
    repo,
    worktreeRoot,
    restore: async () => {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await chmod(join(home, '.clickvibe', 'state'), 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

test('concurrent worktree preparation for one workflow is serialized', async () => {
  const env = await setupEnvironment('mutex')
  const harness = makeShell({ records: () => '' })
  try {
    const first = ensureWorktree({ shell: harness.shell } as never, { owner: 'o', repo: 'r', number: '31' })
    // Park the first call at the worktree-list probe.
    for (let attempt = 0; attempt < 100 && harness.gates.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(harness.gates.length, 1, 'first call must reach the worktree-list probe')
    const mark = harness.commands.length
    const second = ensureWorktree({ shell: harness.shell } as never, { owner: 'o', repo: 'r', number: '31' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(
      harness.commands.length,
      mark,
      'a second preparation for the same workflow must not run commands while the first is in flight',
    )
    harness.unparkAll()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
  } finally {
    await env.restore()
  }
})

test('concurrent worktree preparation across workflows does not block on each other', async () => {
  const env = await setupEnvironment('cross')
  const harness = makeShell({ records: () => '' })
  try {
    const first = ensureWorktree({ shell: harness.shell } as never, { owner: 'o', repo: 'r', number: '32' })
    for (let attempt = 0; attempt < 100 && harness.gates.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(harness.gates.length, 1)
    const mark = harness.commands.length
    const second = ensureWorktree({ shell: harness.shell } as never, { owner: 'o', repo: 'r', number: '33' })
    // The other workflow is a different lock: it must complete fully while the
    // first is still parked.
    const other = await second
    assert.equal(other.ok, true)
    assert.ok(harness.commands.length > mark, 'cross-workflow preparation proceeds concurrently')
    harness.unparkAll()
    assert.equal((await first).ok, true)
  } finally {
    await env.restore()
  }
})

test('baseline persistence failure keeps git facts and the retry recovers idempotently', async () => {
  const env = await setupEnvironment('idempotent')
  const target = join(env.worktreeRoot, 'repo', 'repo-issue-34')
  let registered = false
  const harness = makeShell({
    records: () =>
      registered
        ? `worktree ${target}\nHEAD abc1234\nbranch refs/heads/repo-issue-34\n\n`
        : `worktree ${env.repo}\nHEAD base000\nbranch refs/heads/main\n\n`,
  })
  // This scenario does not need interleaving control — let probes pass through.
  harness.unparkAll()
  try {
    await chmod(join(env.home, '.clickvibe', 'state'), 0o500)
    const failed = await ensureWorktree({ shell: harness.shell } as never, { owner: 'o', repo: 'r', number: '34' })
    assert.equal(failed.ok, false)
    if (!failed.ok) assert.match(failed.error, /无法定格开发基线/)
    assert.equal(
      harness.commands.some((command) => command.startsWith('git worktree remove --force')),
      false,
      'persistence failure must not tear the created worktree back down',
    )
    assert.equal(
      harness.commands.some((command) => command.startsWith('git branch -D')),
      false,
      'persistence failure must not delete the created branch',
    )
    const addCount = () => harness.commands.filter((command) => command.startsWith('git worktree add')).length
    assert.equal(addCount(), 1, 'the first attempt did create the worktree')

    // Git-side facts now exist: the retry must reuse them instead of recreating.
    registered = true
    await chmod(join(env.home, '.clickvibe', 'state'), 0o700)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'keep.txt'), 'git facts')
    const recovered = await ensureWorktree({ shell: harness.shell } as never, { owner: 'o', repo: 'r', number: '34' })
    assert.equal(recovered.ok, true)
    assert.equal(addCount(), 1, 'the retry reuses the existing worktree instead of re-adding it')
    const stored = await loadWorkflow(issueKey('o/r', '34'))
    assert.equal(stored?.baseRef, 'origin/main @ abc1234')
  } finally {
    await env.restore()
  }
})
