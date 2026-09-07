/** Workflow-only baseline preview and issue dependency guidance. */
import { requestedRemoteBase } from '../agent/baseline.ts'

export {
  frozenBaseHash,
  frozenRemoteBase,
  requestedRemoteBase,
  resolveSelectedRemoteBase,
  updateBaseTip,
} from '../agent/baseline.ts'

/** Default sentinel first; remaining fetched remote branches are stable and unique. */
export function baselinePreviewOptions(actualDefault: string, remoteRefs: string[]): string[] {
  const refs = new Set<string>()
  for (const candidate of [actualDefault, ...remoteRefs]) {
    try {
      const ref = requestedRemoteBase(candidate)
      if (ref !== 'origin/HEAD') refs.add(ref)
    } catch {
      // Git output is treated as data; malformed entries are excluded from the preview.
    }
  }
  // Codepoint order (git's own refname ordering), not localeCompare: the collation
  // follows the host locale (e.g. zh pinyin orders 发布/二期 before main), which
  // made the preview order — and its tests — flip from machine to machine.
  return ['origin/HEAD', ...[...refs].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))]
}

/** Recognize a selected ClickVibe issue-development branch for dependency guidance. */
export function baselineDependencyIssue(remoteBase: string): number | null {
  const match = requestedRemoteBase(remoteBase).match(/(?:^|\/)clickvibe-issue-(\d+)$/)
  if (!match) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
