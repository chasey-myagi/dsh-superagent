import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { DomainEvent } from '../src/core/index.ts'
import type { Receipt } from '../src/app/store.ts'
import { Trace, percentile } from '../src/app/trace.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function traceAt(): Trace {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-trace-'))
  directories.push(stateDir)
  return new Trace({ stateDir, sessionId: 'master' })
}
const lines = (trace: Trace): Record<string, unknown>[] => readFileSync(trace.file, 'utf8').trim().split('\n').filter(Boolean)
  .map(line => JSON.parse(line) as Record<string, unknown>)
const domain = (trace: Trace, event: Record<string, unknown>): void => trace.domain(event as unknown as DomainEvent)
const receipt = (ticketId?: string): Receipt => ({ id: 'm1', ticketId, text: 'done', kind: 'reply',
  channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: { chat: 'oc_1' } }, status: 'pending' })

it('appends one JSON line per event with the required base fields that fields cannot override', () => {
  const trace = traceAt()
  trace.append('t1', 'master', 'admission', { ticket_id: 'wrong', kind: 'wrong', strength: 'explicit' }, '2026-09-21T08:00:00Z')
  expect(lines(trace)).toEqual([{ strength: 'explicit', ts: '2026-09-21T08:00:00.000Z', ticket_id: 't1', session_id: 'master',
    kind: 'admission' }])
})

it('projects ticket lifecycle domain events and reply delivery outcomes', () => {
  const trace = traceAt()
  domain(trace, { type: 'ticket.created', at: '2026-09-21T08:00:00Z', data: { ticketId: 't1', decisionId: 'd1', strength: 'explicit' } })
  domain(trace, { type: 'ticket.resumed', at: '2026-09-21T08:01:00Z', data: { ticketId: 't1', triggerId: 'e1' } })
  domain(trace, { type: 'assignment.started', at: '2026-09-21T08:02:00Z', data: { ticketId: 't1', assignmentId: 'a1' } })
  domain(trace, { type: 'assignment.ended', at: '2026-09-21T08:03:00Z', data: { ticketId: 't1', assignmentId: 'a1', reason: 'failed' } })
  domain(trace, { type: 'ticket.ended', at: '2026-09-21T08:04:00Z', data: { ticketId: 't1', by: 'person', outcome: 'stopped' } })
  trace.delivery(receipt('t1'), 'sent')
  trace.delivery(receipt('t1'), 'channelIgnored')
  trace.delivery(receipt(), 'sent')
  expect(lines(trace).map(line => [line.kind, line.session_id])).toEqual([['admission', 'master'], ['resume', 'master'],
    ['worker.started', 'worker-t1'], ['worker.ended', 'worker-t1'], ['ticket.ended', 'master'], ['reply.delivered', 'outbox'],
    ['reply.dropped', 'outbox']])
  expect(lines(trace).at(-1)).toMatchObject({ ticket_id: 't1', message_id: 'm1', message_kind: 'reply', channel_source: 'feishu',
    thread: 'feishu:oc_1:om_1', reason: 'channelIgnored' })
})

it('projects worker Session model, tool, turn and error events outside the Session stream', () => {
  const trace = traceAt()
  const handlers = new Map<string, (session: { id: string }, event: unknown) => void>()
  trace.install({ on: (name: string, handler: (session: { id: string }, event: unknown) => void) => {
    handlers.set(name, handler)
    return () => {}
  } } as never)
  const emit = (type: string, data: unknown, time: number) => handlers.get('session/event')!({ id: 'worker-t1' }, { type, time, data })
  const t = Date.parse('2026-09-21T08:00:00Z')
  emit('turn/start', { turn: 1 }, t)
  emit('step/start', { turn: 1, step: 2 }, t)
  emit('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } }, t + 1000)
  emit('assistant/message', { turn: 1, step: 2, message: {}, usage: { inputTokens: 100, outputTokens: 20 } }, t + 2500)
  emit('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } }, t + 3000)
  emit('assistant/message', { turn: 1, step: 2, message: {}, interrupted: true }, t + 4000)
  emit('tool/call', { turn: 1, step: 2, callId: 'c1', name: 'Bash', arguments: {} }, t + 5000)
  emit('tool/result', { turn: 1, step: 2, message: { toolCallId: 'c1' }, error: { name: 'Bash', code: 'FAILED', reason: 'exit 1' } }, t + 6500)
  emit('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_RATE', message: 'slow down' } } }, t + 7000)
  // Events from the main Session or another non-worker Session are not part of a ticket.
  handlers.get('session/event')!({ id: 'master' }, { type: 'turn/start', time: t, data: { turn: 1 } })
  expect(lines(trace)).toMatchObject([
    { ticket_id: 't1', session_id: 'worker-t1', kind: 'turn.started', turn: 1 },
    { kind: 'model.call', provider: 'deepseek', model: 'deepseek-chat', input_tokens: 100, output_tokens: 20, latency_ms: 1500 },
    { kind: 'model.call', usage_missing: true, interrupted: true, input_tokens: 0, output_tokens: 0, latency_ms: 1000 },
    { kind: 'tool.call', call_id: 'c1', name: 'Bash', ok: false, latency_ms: 1500, error_code: 'FAILED', error_name: 'Bash',
      error: 'exit 1' },
    { kind: 'turn.ended', status: 'error', error_code: 'E_RATE', error: 'slow down' },
    { kind: 'error', source: 'turn', code: 'E_RATE', error: 'slow down' },
  ])
})

it('reads a ticket timeline chronologically, skipping blank and malformed lines, and limits the newest events', () => {
  const trace = traceAt()
  for (const [ticket, at, kind] of [['t1', '2026-09-21T08:00:00Z', 'admission'], ['t2', '2026-09-21T08:01:00Z', 'admission'],
    ['t1', '2026-09-21T08:02:00Z', 'worker.started'], ['t1', '2026-09-21T08:03:00Z', 'ticket.ended']] as const) {
    trace.append(ticket, 'master', kind, {}, at)
  }
  writeFileSync(trace.file, `${readFileSync(trace.file, 'utf8')}\nnot json\n{"ts":"2026-09-21T08:04:00Z"}\n\n`)
  expect(trace.timeline('t1').events.map(event => event.kind)).toEqual(['admission', 'worker.started', 'ticket.ended'])
  expect(trace.timeline('t1', 2).events.map(event => event.kind)).toEqual(['worker.started', 'ticket.ended'])
  expect(trace.timeline('t1', 0)).toEqual({ ticketId: 't1', events: [] })
  expect(trace.timeline('missing')).toEqual({ ticketId: 'missing', events: [] })
})

it('computes stage percentiles, ticket counts, tokens, and estimated model cost with configurable prices', () => {
  const trace = traceAt()
  const at = (seconds: number) => new Date(Date.parse('2026-09-21T08:00:00Z') + seconds * 1000).toISOString()
  trace.append('t1', 'master', 'admission', {}, at(0))
  trace.append('t1', 'worker-t1', 'worker.started', { assignment_id: 'a1' }, at(10))
  trace.append('t1', 'worker-t1', 'worker.ended', { assignment_id: 'a1', reason: 'ready' }, at(20))
  trace.append('t1', 'master', 'model.call', { provider: 'deepseek', model: 'deepseek-chat', input_tokens: 1_000_000,
    output_tokens: 500_000 }, at(25))
  trace.append('t1', 'master', 'ticket.ended', { by: 'person', outcome: 'reviewed' }, at(30))
  trace.append('t2', 'master', 'admission', {}, at(60))
  trace.append('t2', 'worker-t1', 'worker.started', { assignment_id: 'a2' }, at(80))
  trace.append('t2', 'worker-t1', 'model.call', { provider: 'other', model: 'unknown-model', input_tokens: 1_000_000,
    output_tokens: 1_000_000 }, at(90))
  trace.append('t3', 'master', 'admission', {}, at(120))
  const metrics = trace.metrics()
  expect(metrics.tickets).toEqual({ total: 3, ended: 1, open: 2 })
  expect(metrics.stages.admission).toEqual({ samples: 2, p50_ms: 15_000, p95_ms: 19_500 })
  expect(metrics.stages.assignment).toEqual({ samples: 1, p50_ms: 10_000, p95_ms: 10_000 })
  expect(metrics.stages.total).toEqual({ samples: 1, p50_ms: 30_000, p95_ms: 30_000 })
  expect(metrics.tokens).toEqual({ input: 2_000_000, output: 1_500_000, total: 3_500_000 })
  expect(metrics.models).toEqual([
    // A model without an explicit price uses DEFAULT_MODEL_PRICE.
    { provider: 'other', model: 'unknown-model', calls: 1, input_tokens: 1_000_000, output_tokens: 1_000_000,
      estimated_cost_usd: 0.7 },
    { provider: 'deepseek', model: 'deepseek-chat', calls: 1, input_tokens: 1_000_000, output_tokens: 500_000,
      estimated_cost_usd: 0.49 },
  ])
  expect(metrics.pricing).toMatchObject({ currency: 'USD', unit: 'per 1M tokens', models: { 'deepseek-chat': { input: 0.28,
    output: 0.42 } } })
})

it('interpolates percentiles and reports none without samples', () => {
  expect(percentile([], 0.5)).toBeNull()
  expect(percentile([10], 0.95)).toBe(10)
  expect(percentile([10, 20], 0.5)).toBe(15)
  expect(percentile([10, 20], 0.95)).toBe(20)
})
