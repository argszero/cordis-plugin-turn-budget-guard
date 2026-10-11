import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

// The guard is a listener on `agent/pre-step`, so the meaningful test is against
// the REAL Cordis runtime: does it forward when it should, and does it replace
// the admitted batch when the budget lapses? The harness is stood in for by a
// minimal emitter, because the guard reads only `agent.session.id`,
// `agent.cancel`, and the four payload fields.

/**
 * The steady-state admitted batch: a tool result coming back into the loop. Real
 * user text only appears when a human actually types, so escalation tests must
 * use the tool shape — otherwise every step looks like a re-engagement and the
 * guard correctly rebases instead of firing.
 */
const toolResult = () => ({ source: { kind: 'tool' }, content: [{ type: 'tool-result' }] })

/** A stand-in for the harness Agent: only what the guard touches. */
function fakeAgent(id) {
  const cancelled = []
  return {
    session: { id },
    cancel: (cause, options) => cancelled.push({ cause, options }),
    cancelled,
  }
}

/** Mount the plugin and return a function that drives one proposed step. */
async function mount(config) {
  const ctx = new Context()
  const logged = []
  ctx.logger = { info: (m) => logged.push(m), debug: () => {}, warn: () => {}, error: () => {} }
  await ctx.plugin({ name: 'turn-budget-guard', apply: (c) => plugin.apply(c, config) })
  return { ctx, logged }
}

/** Run one `agent/pre-step` dispatch and return what the listener produced. */
function preStep(ctx, agent, messages, turn, step) {
  return ctx.waterfall('agent/pre-step', { agent, messages, turn, step }, () =>
    Promise.resolve({ kind: 'enter', messages }))
}

test('exposes the documented plugin surface', () => {
  assert.equal(plugin.name, 'turn-budget-guard')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
})

test('forwards every step until the budget lapses', async () => {
  const { ctx } = await mount(plugin.resolveConfig({ maxSteps: 3 }))
  const agent = fakeAgent('s1')
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }

  for (let step = 1; step <= 3; step++) {
    const decision = await preStep(ctx, agent, [user], 1, step)
    assert.equal(decision.messages.length, 1)
    assert.equal(decision.messages[0], user) // untouched
  }
  // A user interjection rebases the budget; the turn then has a full budget again
  // measured from that step, which is what the fresh-room assertion below pins.")
  assert.deepEqual(agent.cancelled, [])
})

test('on lapse it appends one notice after the admitted messages', async () => {
  const { ctx } = await mount(plugin.resolveConfig({ maxSteps: 3 }))
  const agent = fakeAgent('s2')
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }

  await preStep(ctx, agent, [toolResult()], 1, 3)
  const decision = await preStep(ctx, agent, [toolResult()], 1, 4)

  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.kind, 'tool') // the real input still leads
  const notice = decision.messages[1]
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.plugin, 'turn-budget-guard')
  assert.equal(notice.source.form, 'notice')
  // `session.append` rejects an unidentified user/message, so the id must be real.
  assert.equal(typeof notice.id, 'string')
  assert.ok(notice.id.length > 0)
  assert.match(notice.content[0].text, /4 steps/)
})

test('it escalates to cancel and keeps queued user input', async () => {
  const { ctx } = await mount(plugin.resolveConfig({ maxSteps: 2, maxFires: 1 }))
  const agent = fakeAgent('s3')

  await preStep(ctx, agent, [], 1, 2)
  await preStep(ctx, agent, [], 1, 3) // fire 1
  await preStep(ctx, agent, [], 1, 4) // maxFires spent -> stop

  assert.equal(agent.cancelled.length, 1)
  // The cause must be a member of the closed `AgentCancelCause` union: the loop's
  // `abortedCancelCause` ends in `assertNever`, so a bare string throws from inside
  // the turn's `catch` and persists `turn/end` with `reason: null` (#8832, #9156).
  // `hook` is the member a plugin owns, and the configured string is its reason.
  assert.deepEqual(agent.cancelled[0].cause, { kind: 'hook', reason: 'turn-budget' })
  // Discarding the user's queued work would be the opposite of this guard's job.
  assert.deepEqual(agent.cancelled[0].options, { keepInbox: true })
})

test('a downstream reject is never resurrected by the notice', async () => {
  const { ctx } = await mount(plugin.resolveConfig({ maxSteps: 1 }))
  const agent = fakeAgent('s4')

  await ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1 }, () =>
    Promise.resolve({ kind: 'enter', messages: [] }))
  const decision = await preStep(ctx, agent, [], 1, 2)
  assert.equal(decision.kind, 'enter')

  // Now make the default close the turn while the guard also wants to speak.
  const closed = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 3 },
    () => Promise.resolve({ kind: 'reject' }),
  )
  assert.deepEqual(closed, { kind: 'reject' })
})

test('budget state is per session', async () => {
  const { ctx } = await mount(plugin.resolveConfig({ maxSteps: 2 }))
  const a = fakeAgent('a')
  const b = fakeAgent('b')

  await preStep(ctx, a, [], 1, 2)
  await preStep(ctx, b, [], 1, 2)
  const a3 = await preStep(ctx, a, [], 1, 3) // a lapsed -> notice
  const b3 = await preStep(ctx, b, [], 1, 3) // b lapsed too, independently
  assert.equal(a3.messages.length, 1)
  assert.equal(b3.messages.length, 1)

  // b starting a fresh turn must not disturb a's counters.
  const bNext = await preStep(ctx, b, [], 2, 1)
  assert.equal(bNext.messages.length, 0)
})

test('a user typing mid-turn gives the turn a full budget from that step', async () => {
  const { ctx } = await mount(plugin.resolveConfig({ maxSteps: 3 }))
  const agent = fakeAgent('s5')
  const typed = { source: { kind: 'user' }, content: [{ type: 'text', text: 'you are going in circles' }] }

  // Spend the budget, then have the user interrupt at step 6.
  await preStep(ctx, agent, [toolResult()], 1, 3)
  await preStep(ctx, agent, [toolResult()], 1, 4) // fire 1
  const rebased = await preStep(ctx, agent, [typed], 1, 6)
  assert.equal(rebased.messages.length, 1) // forwarded untouched, no notice

  // The count restarts from the interruption: steps 7-9 are inside the budget.
  for (let step = 7; step <= 9; step++) {
    const d = await preStep(ctx, agent, [toolResult()], 1, step)
    assert.equal(d.messages.length, 1, `step ${step} should still be inside the budget`)
  }
  // And step 10 is the first one past it again.
  const after = await preStep(ctx, agent, [toolResult()], 1, 10)
  assert.equal(after.messages.length, 2)
  // Spend is measured from the interruption at step 6, so step 10 reports 4.
  assert.match(after.messages[1].content[0].text, /4 steps/)
})
