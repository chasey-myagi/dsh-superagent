import { describe, expect, it } from 'vitest'
import { candidateOf, findDuplicate, MERGED_WINDOW_MS, ticketIssues, titleMatch, titleMatches, titleTokens } from '../src/core/dedupe.ts'
import type { Ticket, Trigger } from '../src/core/model.ts'

const AT = '2026-09-23T00:00:00.000Z'
const NOW = Date.parse(AT)
const chat = (thread: string) => ({ source: 'chat', thread, address: { message: thread } })
const gh = (number: number) => ({ source: 'github', thread: `github:${number}`, address: { number: String(number) } })
const member = { source: 'chat', id: 'alice' }
function ticket(id: string, title: string, options: { channels?: Ticket['channels']; ended?: Ticket['ended'] } = {}): Ticket {
  return { id, title, decisionId: `decision-${id}`,
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: member, scope: 'small' },
    channels: options.channels ?? [chat('t1')], assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: '1', triggerIds: ['1'] }, ...options.ended ? { ended: options.ended } : {} }
}
function issueTrigger(title: string, number: number, overrides: Partial<Trigger> = {}): Trigger {
  return { id: `github-issue-${number}`, source: 'github', threads: [{ source: 'github', id: String(number) }],
    actor: { source: 'github', id: 'chasey-myagi' }, human: true, at: AT, text: `${title}\n\nbody`, channel: gh(number),
    meta: { number, isPr: false, kind: 'issue' }, ...overrides }
}

describe('title matching', () => {
  it('tokenizes ASCII terms and CJK bigrams, dropping stop words and short numbers', () => {
    expect([...titleTokens('D16: recall 默认 limit')].sort()).toEqual(['d16', 'limit', 'recall', '默认'])
    expect(titleTokens('fix #12')).toEqual(new Set())
    expect(titleTokens('')).toEqual(new Set())
  })

  it('matches titles about the same topic and shares code tokens despite a lower Jaccard score', () => {
    expect(titleMatches('D16: recall 默认 limit', 'D16: recall 默认 limit（合成验证 stop-duplicates）')).toBe(true)
    expect(titleMatches('revert parse_since 截断行为', 'parse_since 的 querystring 解析')).toBe(true)
  })

  it('keeps different topics apart, including same-directory docs changes', () => {
    expect(titleMatches('docs/local-dogfood.md 增加 recall gate 说明', 'docs/local-dogfood.md 补充 stop/start 与 Node 24 MainThread 说明')).toBe(false)
    expect(titleMatches('D16: recall 默认 limit', '派单前去重')).toBe(false)
    expect(titleMatches('', 'anything')).toBe(false)
    expect(titleMatch('D16: recall 默认 limit', 'D16: recall 默认 limit（合成验证）')).toEqual({ score: expect.any(Number), code: true })
  })
})

describe('findDuplicate', () => {
  it('matches an open ticket by issue number whatever its title says', () => {
    expect(findDuplicate({ titles: ['另一个问题'], issues: [20] }, [ticket('4', 'D16: recall 默认 limit', { channels: [gh(20)] })], NOW))
      .toMatchObject({ ticket: { id: '4' }, state: 'open', via: 'issue' })
  })

  it('matches an open ticket by title and keeps the score for the audit', () => {
    expect(findDuplicate({ titles: ['D16: recall 默认 limit（合成验证）'], issues: [] }, [ticket('4', 'D16: recall 默认 limit')], NOW))
      .toMatchObject({ ticket: { id: '4' }, state: 'open', via: 'title', score: expect.any(Number) })
  })

  it('matches a ticket that merged inside the window, but not one that merged before it', () => {
    const merged = ticket('4', 'D16: recall 默认 limit', { ended: { at: AT, by: 'executor', outcome: 'merged' } })
    expect(findDuplicate({ titles: ['D16: recall 默认 limit'], issues: [] }, [merged], NOW + MERGED_WINDOW_MS))
      .toMatchObject({ state: 'merged', via: 'title' })
    expect(findDuplicate({ titles: ['D16: recall 默认 limit'], issues: [] }, [merged], NOW + MERGED_WINDOW_MS + 1)).toBeUndefined()
  })

  it('does not block a different request for the issue a ticket merged from', () => {
    const merged = ticket('4', 'D16: recall 默认 limit', { channels: [gh(20)], ended: { at: AT, by: 'executor', outcome: 'merged' } })
    expect(findDuplicate({ titles: ['召回在这里还漏了一种情况'], issues: [20] }, [merged], NOW + 60_000)).toBeUndefined()
  })

  it('does not consider tickets that ended without merging', () => {
    const dropped = ticket('4', 'D16: recall 默认 limit', { ended: { at: AT, by: 'executor', outcome: 'dropped' } })
    expect(findDuplicate({ titles: ['D16: recall 默认 limit'], issues: [] }, [dropped], NOW)).toBeUndefined()
  })

  it('prefers an open title match over a merged one', () => {
    const merged = ticket('4', 'D16: recall 默认 limit', { ended: { at: AT, by: 'executor', outcome: 'merged' } })
    const open = ticket('5', 'D16: recall 默认 limit 补充', { channels: [gh(21)] })
    expect(findDuplicate({ titles: ['D16: recall 默认 limit'], issues: [] }, [merged, open], NOW)).toMatchObject({ ticket: { id: '5' }, state: 'open' })
  })
})

describe('candidateOf', () => {
  it('compares both the accepted title and the issue title, with the issue number', () => {
    expect(candidateOf(issueTrigger('D16: recall 默认 limit', 20), '召回默认 limit')).toEqual({ titles: ['召回默认 limit', 'D16: recall 默认 limit'], issues: [20] })
  })

  it('takes no issue title from a comment trigger, whose text is just the comment', () => {
    const comment = issueTrigger('ignored', 20, { meta: { number: 20, isPr: false, kind: 'issue_comment', commentId: 1 } })
    expect(candidateOf(comment, '修一下')).toEqual({ titles: ['修一下'], issues: [20] })
  })
})

describe('ticketIssues', () => {
  it('collects the numeric GitHub channel addresses of a ticket', () => {
    expect(ticketIssues(ticket('4', 'Fix', { channels: [chat('t1'), gh(20), { source: 'github', thread: 'github:21', address: {} }] }))).toEqual([20])
  })
})