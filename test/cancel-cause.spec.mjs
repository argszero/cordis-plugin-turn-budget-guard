/**
 * Cancel-cause regression: this guard must never manufacture a null `turn/end`
 * reason.
 *
 * Discussions #8832 (jianger114) and #9156 (pedestrian757) report the same failure
 * from two directions: one `turn/end` whose `reason` is `null` makes the client's
 * turn rendering throw, and the slot error boundary then blanks the **whole
 * conversation pane — every session, including brand-new ones**. The record is
 * durably on disk and survives restarts. The reporter of #9156 traced one producer
 * to a plugin calling `agent.cancel()` with a `kind` outside the closed
 * `AgentCancelCause` union, and both producers turned out to be **this project's
 * own packages** (`thinking-loop-guard`, `turn-budget-guard`), which passed a bare
 * string.
 *
 * The chain, quoted from dsh `origin/master`:
 *
 *   // packages/core/session/src/types.ts — the closed union
 *   export type AgentCancelCause =
 *     | { readonly kind: 'user' } | { readonly kind: 'parent' }
 *     | { readonly kind: 'hook'; readonly reason: string }
 *     | { readonly kind: 'disposed' }
 *
 *   // packages/core/agent-loop/src/agent.ts — the reader, whose last branch throws
 *   function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
 *     if (!signal.aborted) return undefined
 *     const cause = signal.reason as AgentCancelCause
 *     switch (cause.kind) {
 *       case 'user': case 'parent': case 'disposed': return { kind: cause.kind }
 *       case 'hook': return { kind: 'hook', reason: cause.reason }
 *       /* v8 ignore next -- cancel accepts the closed AgentCancelCause union *\/
 *       default: return assertNever(cause)
 *     }
 *   }
 *
 *   // same file, the turn loop: the throw happens INSIDE the catch, so the
 *   // assignment never runs and `let turnEnds = null` survives into the finally
 *   } catch (error: unknown) {
 *     const cause = abortedCancelCause(signal)
 *     if (cause !== undefined) { turnEnds = { kind: 'aborted', reason: cause }; throw error }
 *     ...
 *   } finally {
 *     this.session.append('turn/end', { turn, reason: turnEnds! })
 *   }
 *
 * `Session.append` does not check the field (`validateSessionEventData` inspects
 * surface messages, `request/header` and `tool/result` only), so the null is
 * admitted and written.
 *
 * What this file cannot do is call the real `abortedCancelCause`: its package
 * (`@deepseek-ai/dsh-agent-loop`) is not a dependency of this plugin. The function
 * below therefore mirrors the quoted code — including its control flow, so the
 * control arm can reproduce the reported `{"reason":null}` — and the real-artifact
 * replay is `scripts/witness-cancel-cause.mjs`, which extracts the shipped function
 * out of the *published* `lib/index.js` and runs it. What is pinned here is the
 * part that can regress, namely the cause this plugin emits.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

/** Upstream `assertNever`'s effect, verbatim: a runtime value outside the type always throws. */
function assertNever(value) {
  throw new Error(`unreachable variant: ${JSON.stringify(value)}`)
}

/**
 * The upstream reader, mirrored: `abortedCancelCause(signal)` plus the turn loop's
 * `catch`/`finally` that turn its result into the persisted record.
 *
 * @param cause - what `agent.cancel()` handed the signal.
 * @returns the `turn/end` payload the loop would append.
 */
function persistedTurnEnd(cause) {
  const signal = { aborted: true, reason: cause }
  let turnEnds = null
  try {
    // Stands in for any error leaving the turn body once the signal aborted.
    throw new Error('turn aborted')
  } catch (error) {
    const read = (() => {
      if (!signal.aborted) return undefined
      switch (signal.reason.kind) {
        case 'user':
        case 'parent':
        case 'disposed':
          return { kind: signal.reason.kind }
        case 'hook':
          return { kind: 'hook', reason: signal.reason.reason }
        default:
          return assertNever(signal.reason)
      }
    })()
    if (read !== undefined) {
      turnEnds = { kind: 'aborted', reason: read }
      throw error
    }
    turnEnds = { kind: 'error', error: { message: String(error), code: 'UNKNOWN' } }
  } finally {
    // The loop appends `{ turn, reason: turnEnds }` here, with a non-null assertion
    // on a variable that the `catch` throw above left null.
    return { turn: 1, reason: turnEnds }
  }
}

/** The steady-state admitted batch: a tool result coming back into the loop. */
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

/** Mount the plugin on the real Cordis runtime. */
async function mount(config) {
  const ctx = new Context()
  ctx.logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }
  await ctx.plugin({ name: 'turn-budget-guard', apply: (c) => plugin.apply(c, config) })
  return ctx
}

/** Run one `agent/pre-step` dispatch. */
function preStep(ctx, agent, messages, turn, step) {
  return ctx.waterfall('agent/pre-step', { agent, messages, turn, step }, () =>
    Promise.resolve({ kind: 'enter', messages }))
}

/** Drive one agent past the budget until the guard cancels. */
async function escalateToCancel(ctx, agent) {
  await preStep(ctx, agent, [toolResult()], 1, 2)
  await preStep(ctx, agent, [toolResult()], 1, 3) // fire the wrap-up notice
  await preStep(ctx, agent, [toolResult()], 1, 4) // maxFires spent -> stop
}

test('the cancel hands the loop a member of the closed union, not the raw string', async () => {
  const ctx = await mount(plugin.resolveConfig({ maxSteps: 2, maxFires: 1 }))
  const agent = fakeAgent('cc1')
  await escalateToCancel(ctx, agent)

  assert.equal(agent.cancelled.length, 1, 'the spent budget must cancel exactly once')
  const cause = agent.cancelled[0].cause
  assert.equal(typeof cause, 'object', `a bare string is outside AgentCancelCause: ${JSON.stringify(cause)}`)
  assert.deepEqual(cause, { kind: 'hook', reason: 'turn-budget' })
  // Discarding the user's queued work would be the opposite of this guard's job.
  assert.deepEqual(agent.cancelled[0].options, { keepInbox: true })
})

test('the emitted cause round-trips instead of throwing in the loop', async () => {
  const ctx = await mount(plugin.resolveConfig({ maxSteps: 2, maxFires: 1 }))
  const agent = fakeAgent('cc2')
  await escalateToCancel(ctx, agent)

  const end = persistedTurnEnd(agent.cancelled[0].cause)
  assert.notEqual(end.reason, null, 'a null reason is the defect this guard must not produce')
  assert.deepEqual(end.reason, { kind: 'aborted', reason: { kind: 'hook', reason: 'turn-budget' } })
  // The reads the client performs on that record — each one used to be the
  // `reading 'kind'` of a null dereference.
  assert.equal(end.reason.kind, 'aborted')
  assert.equal(end.reason.reason.kind, 'hook')
  assert.equal(end.reason.reason.reason, 'turn-budget')
})

test('control: the reported producer reproduces {"reason":null}', () => {
  // Without this arm the two tests above are only as strong as the mirror: the
  // mirror has to be able to fail. A bare string is exactly what v0.1.1 sent
  // (`agent.cancel(action.cause, { keepInbox: true })`).
  const end = persistedTurnEnd('turn-budget')
  assert.equal(end.reason, null, 'the bare string must still produce the reported null')
  assert.throws(() => end.reason.kind, TypeError, 'and the client dereference throws on it')
})

test('cancelCauseFor keeps the configured string as the reason', () => {
  assert.deepEqual(plugin.cancelCauseFor('custom-cause'), { kind: 'hook', reason: 'custom-cause' })
  assert.equal(plugin.cancelCauseFor(plugin.DEFAULTS.cancelCause).reason, 'turn-budget')
  // The union member is stable whatever the caller put in: the config schema is the
  // only place that validates the string.
  assert.equal(typeof plugin.cancelCauseFor('').reason, 'string')
})

test('the schema ships the documented default and still accepts the key', () => {
  assert.equal(plugin.Config({}).cancelCause, 'turn-budget')
  assert.equal(plugin.Config({ cancelCause: 'x' }).cancelCause, 'x')
})
