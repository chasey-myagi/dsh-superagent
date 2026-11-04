/**
 * Pre-dispatch dedupe: refuse a new ticket for a topic an open ticket already covers, or one a recently merged ticket
 * covered a moment ago.
 *
 * This is the dispatch-path counterpart of the operator script `scripts/local/stop-duplicates`, which only runs after a
 * merge: both compare GitHub issue numbers and titles after stop-word removal, with a Jaccard threshold of 0.4 or a
 * shared code-like token (`D16`, `parse_since`, ...). Here the comparison happens before `Tickets.create` queues
 * `executor.start`, so a duplicate never gets a worktree, an acknowledgement or an assignment.
 *
 * A match on the same issue number only counts for an open ticket. After a ticket merged or closed, a new comment on
 * that issue may be a legitimate follow-up ("the fix missed this case"), so a recently merged ticket only blocks a
 * request whose title is about the same topic.
 */
import type { Ticket, Trigger } from './model.ts'
import { liveTicket } from './model.ts'

/** Titles count as the same topic at or above this Jaccard similarity, matching `stop-duplicates`. */
const TITLE_THRESHOLD = 0.4
/** How long a merged ticket keeps making its topic a duplicate; later requests may be genuinely new work. */
export const MERGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Common words that make unrelated Chinese/English task titles look similar; mirrors `stop-duplicates`. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by',
  'from', 'is', 'are', 'be', 'as', 'at', 'this', 'that', 'it', 'not', 'do',
  'does', 'did', 'but', 'if', 'then', 'so', 'than', 'into', 'via', 'use',
  'using', 'add', 'new', 'fix', 'update', 'support', 'test', 'tests',
  '的', '了', '和', '与', '及', '或', '在', '是', '有', '为', '对', '把',
  '被', '从', '到', '中', '上', '下', '后', '前', '并', '也', '都', '就',
  '而', '且', '请', '需要', '一个', '这个',
])
const ASCII_TOKEN = /[a-z0-9][a-z0-9_+#.-]*/g
const CJK_RUN = /[\u3400-\u9fff]+/g

/** Lowercase ASCII terms and CJK bigrams of a title, without stop words or bare two-digit issue references. */
export function titleTokens(title: string | undefined): Set<string> {
  const normalized = (title ?? '').normalize('NFKC').toLowerCase()
  const tokens = new Set<string>()
  for (const [token] of normalized.matchAll(ASCII_TOKEN)) {
    const trimmed = token.replace(/^[._#+-]+/, '').replace(/[._#+-]+$/, '')
    if (!trimmed || STOPWORDS.has(trimmed)) continue
    // Bare two-digit numbers are usually issue references, not topic words.
    if (/^\d+$/.test(trimmed) && trimmed.length < 3) continue
    tokens.add(trimmed)
  }
  for (const [run] of normalized.matchAll(CJK_RUN)) {
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) tokens.add(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (!STOPWORDS.has(bigram)) tokens.add(bigram)
    }
  }
  return tokens
}

/** Distinctive identifiers such as `D16`, `D17`, `parse_since` or `v2_api`. */
function codeTokens(tokens: Iterable<string>): string[] {
  return [...tokens].filter(token => /^[\x00-\x7f]+$/.test(token) && (
    (token.includes('_') && token.length >= 4) ||
    (/[0-9]/.test(token) && /[a-z]/.test(token) && token.length >= 3)
  ))
}

/** Similarity of two titles when they are about the same topic, with the Jaccard score and whether a code token matched. */
export function titleMatch(left: string | undefined, right: string | undefined): { score: number; code: boolean } | undefined {
  const a = titleTokens(left)
  const b = titleTokens(right)
  if (!a.size || !b.size) return undefined
  const shared = [...a].filter(token => b.has(token))
  if (!shared.length) return undefined
  const score = shared.length / (a.size + b.size - shared.length)
  const code = codeTokens(shared).length > 0
  return score >= TITLE_THRESHOLD || code ? { score, code } : undefined
}

/** Whether two titles are about the same topic. */
export function titleMatches(left: string | undefined, right: string | undefined): boolean {
  return titleMatch(left, right) !== undefined
}

/** What a request is about: the titles a new ticket would carry, and the GitHub issues or pull requests it concerns. */
export interface DuplicateCandidate {
  titles: string[]
  issues: number[]
}

/** The numbers of the GitHub issues or pull requests a Ticket belongs to, from the Channels it was accepted from. */
export function ticketIssues(ticket: Pick<Ticket, 'channels'>): number[] {
  const numbers = new Set<number>()
  for (const channel of ticket.channels) {
    const value = channel.address.number
    if (value !== undefined && /^\d+$/.test(value)) numbers.add(Number(value))
  }
  return [...numbers]
}

/** The request a Trigger would start a ticket for: the accepted title, the issue or PR title, and its issue numbers. */
export function candidateOf(trigger: Trigger, title: string): DuplicateCandidate {
  const titles = [title]
  const kind = trigger.meta?.kind
  if (kind === 'issue' || kind === 'pull') {
    // `text` starts with the issue or PR title followed by its body; the title is the part worth comparing.
    const sourceTitle = trigger.text.split('\n', 1)[0]?.trim()
    if (sourceTitle && !titles.includes(sourceTitle)) titles.push(sourceTitle)
  }
  const issues = new Set<number>()
  const address = trigger.channel?.address.number
  if (address !== undefined && /^\d+$/.test(address)) issues.add(Number(address))
  const meta = trigger.meta?.number
  if (typeof meta === 'number' && Number.isSafeInteger(meta)) issues.add(meta)
  return { titles, issues: [...issues] }
}

export interface DuplicateMatch {
  ticket: Ticket
  state: 'open' | 'merged'
  /** The same issue number, or a similar title. */
  via: 'issue' | 'title'
  /** Jaccard similarity of the matched titles; only when `via` is `title`. */
  score?: number
}

/**
 * The open or recently merged Ticket a candidate duplicates, if any. An open ticket for the same issue wins over any
 * title match; otherwise the best title match wins, preferring an open ticket over a merged one.
 */
export function findDuplicate(candidate: DuplicateCandidate, tickets: readonly Ticket[], at: number): DuplicateMatch | undefined {
  const issues = new Set(candidate.issues)
  for (const ticket of tickets) {
    if (liveTicket(ticket) && ticketIssues(ticket).some(number => issues.has(number))) return { ticket, state: 'open', via: 'issue' }
  }
  let best: DuplicateMatch | undefined
  for (const ticket of tickets) {
    const state: DuplicateMatch['state'] | undefined = liveTicket(ticket) ? 'open'
      : ticket.ended?.outcome === 'merged' && mergedRecently(ticket.ended.at, at) ? 'merged' : undefined
    if (!state) continue
    for (const title of candidate.titles) {
      const match = titleMatch(title, ticket.title)
      if (!match) continue
      const better = !best || (state === 'open' && best.state === 'merged') || (state === best.state && match.score > (best.score ?? 0))
      if (better) best = { ticket, state, via: 'title', score: match.score }
      break
    }
  }
  return best
}

function mergedRecently(endedAt: string, at: number): boolean {
  const time = Date.parse(endedAt)
  return Number.isFinite(time) && time >= at - MERGED_WINDOW_MS
}

/** The comment a duplicate skip leaves on the source, so the person who asked knows why no worker started. */
export function duplicateNotice(match: DuplicateMatch): string {
  const state = match.state === 'open' ? '在跑' : '已合并'
  const via = match.via === 'issue' ? '同一 issue' : '标题相近'
  return 'This is by an automated agent, not a human.\n\n' +
    `未派单：与${state}工单 ${match.ticket.id}《${match.ticket.title}》同题（${via}）。如确属不同工作，请说明差异后再请求开工。`
}