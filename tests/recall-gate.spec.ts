import { expect, test } from 'vitest'
import { recallGate } from '../src/app/sessions.js'

const accept = { name: 'orchestrator_route', arguments: { decisions: [{ kind: 'accept' }] } }

test('refuses the first accept without a recall, then lets the retry through', () => {
  const gate = recallGate()
  expect(gate(accept)).toMatch(/recall_facts/)
  expect(gate(accept)).toBeUndefined()
  expect(gate(accept)).toMatch(/recall_facts/)
})

test('passes an accept after recall_facts, and ignores non-accept calls', () => {
  const gate = recallGate()
  expect(gate({ name: 'recall_facts', arguments: {} })).toBeUndefined()
  expect(gate(accept)).toBeUndefined()
  expect(gate({ name: 'orchestrator_route', arguments: { decisions: [{ kind: 'reject' }] } })).toBeUndefined()
  expect(gate({ name: 'bash', arguments: {} })).toBeUndefined()
})
