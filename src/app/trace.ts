/**
 * Append-only ticket trace. Domain events, worker Session events, and reply delivery outcomes are projected into
 * `<stateDir>/trace/tickets.jsonl` so the management API and panel can show one timeline without querying the
 * SQLite store or reconstructing Sessions.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DomainEvent } from '../core/index.ts'
import { ticketOfSession, workerSessionId } from '../executor/dsh.ts'
import type { Receipt } from './store.ts'
import type { ModelPrice, TraceMetricsView, TraceStageMetrics, TicketTimelineView, TraceEvent } from './views/trace.ts'

/** Input and output prices in USD per million tokens. Change these constants when the deployed model prices change. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-chat': { input: 0.28, output: 0.42 },
  'deepseek-reasoner': { input: 0.28, output: 2.19 },
}
/** Fallback price for a model route without an explicit entry in `MODEL_PRICES`. */
export const DEFAULT_MODEL_PRICE: ModelPrice = { input: 0.28, output: 0.42 }
/** Outcome of an outbound reply delivery attempt, as `Outbox` settles its receipt. */
export type DeliveryResult = 'sent' | 'channelGone' | 'channelIgnored'
/** The narrow delivery hook `Outbox` uses to record a settled receipt in the trace. */
export interface DeliveryTracer { delivery(receipt: Receipt, result: DeliveryResult): void }

/** Configuration for one `Trace`: where to write and which Session ID domain-level records belong to. */
export interface TraceHost {
  readonly stateDir: string
  /** The main Session ID, recorded on host-level domain events. */
  readonly sessionId: string
  /** Receives non-fatal trace write/read failures; the caller decides how to log them. */
  report?(error: unknown): void
}

interface PendingModel { at: number; provider?: string; model?: string; turn: number; step: number }
interface PendingTool { at: number; name: string; turn: number; step: number }
interface Lifecycle { started: number; admission?: number; workerStart?: number; ended?: number }
interface DispatchCall { callId: string; recall: boolean }

/** The memory tool the router calls before dispatching work, and the tools whose accept dispatches a ticket. */
const RECALL_TOOL = 'recall_facts'
const DISPATCH_TOOLS = new Set(['orchestrator_route', 'orchestrator_eval_decide'])

const now = (): string => new Date().toISOString()
/** ISO timestamp of a Session event time, tolerating malformed or out-of-range times instead of throwing inside a listener. */
const timeStamp = (time: number): string => Number.isFinite(time) && Math.abs(time) <= 8.64e15
  ? new Date(time).toISOString() : now()
const stamp = (at?: string): string => {
  if (!at) return now()
  const time = Date.parse(at)
  return Number.isFinite(time) ? new Date(time).toISOString() : at
}
const timeOf = (event: TraceEvent): number | undefined => {
  const time = Date.parse(event.ts)
  return Number.isFinite(time) ? time : undefined
}
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const textOf = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** Human-readable message of an unknown error or structured failure. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  try { return JSON.stringify(error) } catch { return String(error) }
}
/** Stable map key for one model request, which is bound to a Session turn and step until its message or attempt lands. */
const modelKey = (sessionId: string, turn: number, step: number): string => `${sessionId}\u0000${turn}:${step}`
/** Nearest-rank linear-interpolation percentile over sorted samples; `null` when no sample completed. */
export function percentile(samples: number[], fraction: number): number | null {
  if (!samples.length) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position), upper = Math.ceil(position)
  const value = lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  return Math.round(value)
}
function stage(samples: number[]): TraceStageMetrics {
  return { samples: samples.length, p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95) }
}
function priceOf(provider: string, model: string): ModelPrice {
  return MODEL_PRICES[`${provider}/${model}`] ?? MODEL_PRICES[model] ?? DEFAULT_MODEL_PRICE
}
function isTraceEvent(value: unknown): value is TraceEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.ts === 'string' && typeof record.ticket_id === 'string' && typeof record.session_id === 'string'
    && typeof record.kind === 'string'
}

/**
 * Writes and reads the unified ticket trace. Each line has `ts`, `ticket_id`, `session_id`, `kind`, and kind-specific
 * fields. Writes are synchronous and best-effort: tracing must never fail a ticket operation.
 */
export class Trace implements DeliveryTracer {
  readonly file: string
  private readonly report: (error: unknown) => void
  private readonly pendingModels = new Map<string, PendingModel>()
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly currentSteps = new Map<string, { turn: number; step: number }>()
  private readonly disposers: (() => void)[] = []
  /** Time of the newest `recall_facts` call in the main Session, and of the newest dispatch call before the one in flight. */
  private lastRecallAt: number | undefined
  private lastDispatchAt = 0
  /** The dispatch call in flight, with whether a recall call came after the previous dispatch call. */
  private dispatchCall: DispatchCall | undefined

  constructor(private readonly host: TraceHost) {
    this.file = join(host.stateDir, 'trace', 'tickets.jsonl')
    this.report = host.report ?? (() => {})
    try { mkdirSync(join(host.stateDir, 'trace'), { recursive: true, mode: 0o700 }) } catch (error) { this.report(error) }
  }

  /** Subscribe to worker Session events and agent errors. Returns an uninstall function. */
  install(ctx: Context): () => void {
    // A trace projection must never break the event it observes, so listener failures are reported and swallowed.
    this.disposers.push(ctx.on('session/event', (session, event) => {
      try { this.session(session.id, event) } catch (error) { this.report(error) }
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      try {
        const ticketId = ticketOfSession(agent.id)
        if (ticketId) this.append(ticketId, agent.id, 'error', { source: 'agent', error: errorText(error) })
      } catch (failure) { this.report(failure) }
    }))
    return () => { for (const dispose of this.disposers.splice(0)) dispose() }
  }

  /**
   * Track the main Session's memory and dispatching tool calls. A dispatch records a recall only when `recall_facts` was
   * called after the previous dispatch call, so a batch accepted from one route call shares its single recall.
   */
  private mainSession(event: SessionEvent): void {
    switch (event.type) {
      case 'tool/call': {
        if (event.data.name === RECALL_TOOL) this.lastRecallAt = event.time
        else if (DISPATCH_TOOLS.has(event.data.name)) {
          this.dispatchCall = { callId: event.data.callId, recall: this.lastRecallAt !== undefined && this.lastRecallAt > this.lastDispatchAt }
          this.lastDispatchAt = event.time
        }
        break
      }
      case 'tool/result':
        if (this.dispatchCall?.callId === event.data.message.toolCallId) this.dispatchCall = undefined
        break
      default:
        break
    }
  }

  /** Append one trace record. Base fields cannot be overridden by `fields`. */
  append(ticketId: string, sessionId: string, kind: string, fields: Record<string, unknown> = {}, at?: string): void {
    const record = { ...fields, ts: stamp(at), ticket_id: ticketId, session_id: sessionId, kind }
    try { appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 }) } catch (error) { this.report(error) }
  }

  /** Project one engine domain event into ticket lifecycle trace records. */
  domain(event: DomainEvent): void {
    try { this.projectDomain(event) } catch (error) { this.report(error) }
  }

  private projectDomain(event: DomainEvent): void {
    switch (event.type) {
      case 'ticket.created':
        this.append(event.data.ticketId, this.host.sessionId, 'admission',
          { decision_id: event.data.decisionId, strength: event.data.strength }, event.at)
        this.append(event.data.ticketId, this.host.sessionId, 'dispatch',
          { decision_id: event.data.decisionId, strength: event.data.strength, recall: this.dispatchCall?.recall === true }, event.at)
        break
      case 'ticket.resumed':
        this.append(event.data.ticketId, this.host.sessionId, 'resume', { trigger_id: event.data.triggerId }, event.at)
        break
      case 'assignment.started':
        this.append(event.data.ticketId, workerSessionId(event.data.ticketId), 'worker.started', { assignment_id: event.data.assignmentId }, event.at)
        break
      case 'assignment.ended':
        this.append(event.data.ticketId, workerSessionId(event.data.ticketId), 'worker.ended',
          { assignment_id: event.data.assignmentId, reason: event.data.reason }, event.at)
        break
      case 'ticket.ended':
        this.append(event.data.ticketId, this.host.sessionId, 'ticket.ended',
          { by: event.data.by, outcome: event.data.outcome, ...event.data.reason ? { reason: event.data.reason } : {} }, event.at)
        break
      default:
        break
    }
  }

  /** Record a settled reply receipt under its ticket. Messages without a ticket are not part of a ticket timeline. */
  delivery(receipt: Receipt, result: DeliveryResult): void {
    try {
      if (!receipt.ticketId) return
      const kind = result === 'sent' ? 'reply.delivered' : 'reply.dropped'
      this.append(receipt.ticketId, 'outbox', kind, { message_id: receipt.id, message_kind: receipt.kind,
        channel_source: receipt.channel.source, thread: receipt.channel.thread,
        ...result === 'sent' ? {} : { reason: result } })
    } catch (error) { this.report(error) }
  }

  /** Project one worker Session event; the main Session's tool calls only decide the recall metric of dispatches. */
  private session(sessionId: string, event: SessionEvent): void {
    if (sessionId === this.host.sessionId) {
      this.mainSession(event)
      return
    }
    const ticketId = ticketOfSession(sessionId)
    if (!ticketId) return
    const at = timeStamp(event.time)
    switch (event.type) {
      case 'turn/start':
        this.append(ticketId, sessionId, 'turn.started', { turn: event.data.turn }, at)
        break
      case 'turn/end': {
        const reason = event.data.reason
        const error = reason.kind === 'error' ? reason.error : undefined
        this.append(ticketId, sessionId, 'turn.ended', { turn: event.data.turn, status: reason.kind,
          ...error ? { error_code: error.code, error: error.message } : {} }, at)
        if (error) this.append(ticketId, sessionId, 'error', { source: 'turn', turn: event.data.turn, code: error.code,
          error: error.message }, at)
        break
      }
      case 'step/start':
        this.currentSteps.set(sessionId, { turn: event.data.turn, step: event.data.step })
        break
      case 'request/header': {
        const current = this.currentSteps.get(sessionId) ?? { turn: 0, step: 0 }
        this.pendingModels.set(modelKey(sessionId, current.turn, current.step), { at: event.time,
          provider: event.data.header.config.provider, model: event.data.header.config.model, turn: current.turn, step: current.step })
        break
      }
      case 'assistant/message': {
        const key = modelKey(sessionId, event.data.turn, event.data.step)
        const pending = this.pendingModels.get(key)
        this.pendingModels.delete(key)
        const usage = event.data.usage
        const latency = pending ? Math.max(0, Math.round(event.time - pending.at)) : undefined
        this.append(ticketId, sessionId, 'model.call', {
          turn: event.data.turn, step: event.data.step,
          provider: pending?.provider ?? 'unknown', model: pending?.model ?? 'unknown',
          input_tokens: finite(usage?.inputTokens) ?? 0, output_tokens: finite(usage?.outputTokens) ?? 0,
          ...usage ? {} : { usage_missing: true },
          ...latency === undefined ? {} : { latency_ms: latency },
          ...event.data.interrupted ? { interrupted: true } : {},
        }, at)
        break
      }
      case 'assistant/attempt': {
        const key = modelKey(sessionId, event.data.turn, event.data.step)
        const pending = this.pendingModels.get(key)
        this.pendingModels.delete(key)
        this.append(ticketId, sessionId, 'model.attempt', { turn: event.data.turn, step: event.data.step,
          provider: pending?.provider ?? 'unknown', model: pending?.model ?? 'unknown',
          ...pending ? { latency_ms: Math.max(0, Math.round(event.time - pending.at)) } : {} }, at)
        break
      }
      case 'tool/call':
        this.pendingTools.set(`${sessionId}\u0000${event.data.callId}`, { at: event.time, name: event.data.name, turn: event.data.turn, step: event.data.step })
        break
      case 'tool/result': {
        const key = `${sessionId}\u0000${event.data.message.toolCallId}`
        const pending = this.pendingTools.get(key)
        this.pendingTools.delete(key)
        const error = event.data.error
        const latency = pending ? Math.max(0, Math.round(event.time - pending.at)) : undefined
        this.append(ticketId, sessionId, 'tool.call', { call_id: event.data.message.toolCallId, name: pending?.name ?? 'unknown',
          turn: event.data.turn, step: event.data.step, ok: !error,
          ...latency === undefined ? {} : { latency_ms: latency },
          ...error ? { error_code: error.code, error_name: error.name, ...error.reason ? { error: error.reason } : {} } : {} }, at)
        break
      }
      default:
        break
    }
  }

  /** Read the trace file, skipping blank and malformed lines. */
  private read(): TraceEvent[] {
    let raw: string
    try { raw = readFileSync(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(error)
      return []
    }
    const events: TraceEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const value: unknown = JSON.parse(line)
        if (isTraceEvent(value)) events.push(value)
      } catch { /* A torn or hand-edited line does not hide later records. */ }
    }
    return events
  }

  /** Newest `limit` events of one ticket in chronological order. */
  timeline(ticketId: string, limit = 200): TicketTimelineView {
    const events = this.read().filter(event => event.ticket_id === ticketId)
    return { ticketId, events: limit > 0 ? events.slice(-limit) : [] }
  }

  /** Aggregate ticket counts, completed stage latencies, token usage, and estimated model cost over the whole trace. */
  metrics(): TraceMetricsView {
    const events = this.read()
    const lifecycles = new Map<string, Lifecycle>()
    const assignments = new Map<string, number>()
    const assignmentDurations: number[] = []
    const models = new Map<string, { provider: string; model: string; calls: number; input: number; output: number }>()
    let input = 0, output = 0
    const dispatches = new Set<string>(), recalledTickets = new Set<string>()
    const lifecycle = (ticketId: string): Lifecycle => {
      let value = lifecycles.get(ticketId)
      if (!value) { value = { started: Number.POSITIVE_INFINITY }; lifecycles.set(ticketId, value) }
      return value
    }
    for (const event of events) {
      const time = timeOf(event)
      if (time === undefined) continue
      const life = lifecycle(event.ticket_id)
      life.started = Math.min(life.started, time)
      switch (event.kind) {
        case 'admission': life.admission ??= time; break
        case 'worker.started': {
          life.workerStart ??= time
          const assignmentId = textOf(event.assignment_id)
          if (assignmentId) assignments.set(`${event.ticket_id}\u0000${assignmentId}`, time)
          break
        }
        case 'worker.ended': {
          const assignmentId = textOf(event.assignment_id)
          const key = assignmentId ? `${event.ticket_id}\u0000${assignmentId}` : undefined
          const started = key ? assignments.get(key) : undefined
          if (started !== undefined && key) {
            assignmentDurations.push(Math.max(0, time - started))
            assignments.delete(key)
          }
          break
        }
        case 'dispatch':
          dispatches.add(event.ticket_id)
          if (event.recall === true) recalledTickets.add(event.ticket_id)
          break
        case 'ticket.ended': life.ended = Math.max(life.ended ?? time, time); break
        case 'model.call': {
          const provider = textOf(event.provider) ?? 'unknown'
          const model = textOf(event.model) ?? 'unknown'
          const key = `${provider}\u0000${model}`
          const entry = models.get(key) ?? { provider, model, calls: 0, input: 0, output: 0 }
          const callInput = finite(event.input_tokens) ?? 0, callOutput = finite(event.output_tokens) ?? 0
          entry.calls++
          entry.input += callInput
          entry.output += callOutput
          input += callInput
          output += callOutput
          models.set(key, entry)
          break
        }
        default:
          break
      }
    }
    const admissionDurations: number[] = []
    const totalDurations: number[] = []
    for (const life of lifecycles.values()) {
      if (life.admission !== undefined && life.workerStart !== undefined) {
        admissionDurations.push(Math.max(0, life.workerStart - life.admission))
      }
      // Only a completed ticket has a total duration; an open ticket would grow with every request.
      if (life.admission !== undefined && life.ended !== undefined) totalDurations.push(Math.max(0, life.ended - life.admission))
    }
    const ended = [...lifecycles.values()].filter(life => life.ended !== undefined).length
    const modelRows = [...models.values()].map(entry => {
      const price = priceOf(entry.provider, entry.model)
      const cost = entry.input / 1_000_000 * price.input + entry.output / 1_000_000 * price.output
      return { provider: entry.provider, model: entry.model, calls: entry.calls, input_tokens: entry.input, output_tokens: entry.output,
        estimated_cost_usd: Math.round(cost * 1_000_000) / 1_000_000 }
    }).sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd || a.model.localeCompare(b.model))
    return {
      tickets: { total: lifecycles.size, ended, open: lifecycles.size - ended },
      stages: { admission: stage(admissionDurations), assignment: stage(assignmentDurations), total: stage(totalDurations) },
      recall: { dispatched: dispatches.size, used: recalledTickets.size,
        rate: dispatches.size ? Math.round(recalledTickets.size / dispatches.size * 10_000) / 10_000 : 0 },
      tokens: { input, output, total: input + output },
      models: modelRows,
      pricing: { currency: 'USD', unit: 'per 1M tokens', default: DEFAULT_MODEL_PRICE, models: { ...MODEL_PRICES } },
    }
  }
}
