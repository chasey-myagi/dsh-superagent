/** Ticket trace timeline and aggregate metrics views served by the management API. */
/** One append-only trace record; `kind` selects the fields that accompany these base keys. */
export interface TraceEvent {
  ts: string
  ticket_id: string
  session_id: string
  kind: string
  [field: string]: unknown
}
/** The newest trace events of one ticket, in chronological order. */
export interface TicketTimelineView { ticketId: string; events: TraceEvent[] }
/** Input and output prices for one model, in USD per million tokens. */
export interface ModelPrice { input: number; output: number }
/** Latency distribution of one ticket stage over completed samples. */
export interface TraceStageMetrics { samples: number; p50_ms: number | null; p95_ms: number | null }
/** Token usage and estimated cost of one model route. */
export interface TraceModelMetrics {
  provider: string
  model: string
  calls: number
  input_tokens: number
  output_tokens: number
  estimated_cost_usd: number
}
/** Ticket counts, stage latencies, token usage, and estimated model cost aggregated from the trace file. */
export interface TraceMetricsView {
  tickets: { total: number; ended: number; open: number }
  stages: { admission: TraceStageMetrics; assignment: TraceStageMetrics; total: TraceStageMetrics }
  tokens: { input: number; output: number; total: number }
  models: TraceModelMetrics[]
  pricing: { currency: 'USD'; unit: 'per 1M tokens'; default: ModelPrice; models: Record<string, ModelPrice> }
}
