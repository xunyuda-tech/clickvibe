/**
 * Null-exit evidence for foreground shell commands (issue #1).
 *
 * Invariant I1: the shell result is the only fact source for a command's
 * outcome. A null exit code is classified strictly from observable evidence
 * (cancelled marker, elapsed-vs-timeout, signal, host status, output tails);
 * when no evidence proves a cause the label is `unknown` — a cause label, not
 * a liveness verdict. Diagnostics carry the command *category*, never the raw
 * command line or any secret it might embed.
 */

export type NullExitKind = 'timeout' | 'abort' | 'signal' | 'host-shell' | 'unknown'

export interface NullExitFacts {
  /** Safe category derived via {@link commandCategory}; never the raw command. */
  category: string
  timeoutMs: number
  durationMs: number
  signal: string | null
  /** Host-reported cancellation/abort marker. */
  cancelled: boolean
  /** Host job status when the runtime result carries one (completed/killed/…). */
  hostStatus: string | null
  stdoutTail: string
  stderrTail: string
}

export interface NullExitVerdict {
  kind: NullExitKind
  reason: string
}

const TAIL_LIMIT = 400

/** Keep the tail of an output stream, capped, for diagnostics. */
export function tailText(text: string | undefined, limit = TAIL_LIMIT): string {
  if (!text) return ''
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `…${trimmed.slice(-limit)}`
}

/** Keep a token only if it is identifier-safe; option values (`KEY=secret`), paths and other operand shapes collapse to null. */
function safeToken(token: string): string | null {
  const normalized = token.toLowerCase()
  return /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : null
}

/**
 * Derive a safe command category: program (+ subcommand for git/gh), never
 * arguments. Program and subcommand tokens pass the *same* identifier
 * whitelist at this — the only — construction point, so an option value like
 * `-c KEY=secret` or a `-C /path` operand can never become part of the
 * category (issue #1 review F1).
 */
export function commandCategory(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 'unknown'
  const rawProgram = tokens[0].includes('/') ? tokens[0].slice(tokens[0].lastIndexOf('/') + 1) : tokens[0]
  const program = safeToken(rawProgram)
  if (!program) return 'unknown'
  if (program === 'git' || program === 'gh') {
    const sub = safeToken(tokens.slice(1).find((token) => !token.startsWith('-')) ?? '')
    return sub ? `${program}-${sub}` : program
  }
  return program
}

/**
 * Classify a null exit from evidence only. Ranking is cause-first: an explicit
 * cancellation outranks everything, a reached timeout outranks the kill signal
 * it provokes, a bare signal means an external kill, and a bare null exit with
 * no captured output points at the host shell itself.
 */
export function classifyNullExit(facts: NullExitFacts): NullExitVerdict {
  if (facts.cancelled) {
    return {
      kind: 'abort',
      reason: `命令被宿主取消${facts.hostStatus ? `(status=${facts.hostStatus})` : ''}`,
    }
  }
  if (facts.durationMs >= facts.timeoutMs) {
    const signalNote = facts.signal ? `,进程被信号 ${facts.signal} 终止` : ''
    return {
      kind: 'timeout',
      reason: `耗时 ${facts.durationMs}ms 已达超时配置 ${facts.timeoutMs}ms${signalNote}`,
    }
  }
  if (facts.signal) {
    return { kind: 'signal', reason: `进程被信号 ${facts.signal} 终止(未达超时)` }
  }
  if (facts.hostStatus === 'killed' || facts.hostStatus === 'failed') {
    return { kind: 'host-shell', reason: `宿主 shell 报告命令任务 ${facts.hostStatus},未捕获退出码` }
  }
  if (facts.stdoutTail === '' && facts.stderrTail === '') {
    return { kind: 'host-shell', reason: '无退出码、无信号、无输出捕获,疑为宿主 shell 生命周期故障' }
  }
  return { kind: 'unknown', reason: '无信号且未达超时,原因不可证明' }
}

/** Human-readable error message for a null exit; includes category, verdict and output tails. */
export function nullExitMessage(facts: NullExitFacts, verdict: NullExitVerdict): string {
  const parts = [`[${facts.category}] 分类 ${verdict.kind}:${verdict.reason}`]
  if (facts.signal && verdict.kind !== 'timeout' && verdict.kind !== 'signal') parts.push(`signal=${facts.signal}`)
  if (facts.stdoutTail) parts.push(`stdout 尾部: ${facts.stdoutTail}`)
  if (facts.stderrTail) parts.push(`stderr 尾部: ${facts.stderrTail}`)
  return `命令退出码 null(${parts.join('; ')})`
}

/**
 * Extract {@link NullExitFacts} from a shell result. The plugin-visible shell
 * type declares only { exitCode, stdout, stderr }; the runtime may attach
 * signal/cancelled/status fields, so read them through a wide assertion.
 */
export function nullExitFacts(input: {
  command: string
  timeoutMs: number
  startedAt: number
  endedAt: number
  result: unknown
  stdout: string
  stderr: string
}): NullExitFacts {
  const wide = input.result as { signal?: unknown; aborted?: unknown; cancelled?: unknown; status?: unknown }
  const signal = typeof wide.signal === 'string' && wide.signal !== '' ? wide.signal : null
  const hostStatus = typeof wide.status === 'string' && wide.status !== '' ? wide.status : null
  const cancelled =
    wide.aborted === true ||
    wide.cancelled === true ||
    (hostStatus !== null && /cancel|abort/i.test(hostStatus)) ||
    (typeof wide.aborted === 'string' && /cancel|abort/i.test(wide.aborted))
  return {
    category: commandCategory(input.command),
    timeoutMs: input.timeoutMs,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    signal,
    cancelled,
    hostStatus,
    stdoutTail: tailText(input.stdout),
    stderrTail: tailText(input.stderr),
  }
}
