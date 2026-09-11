import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULTS,
  decide,
  hasUserText,
  initialState,
  resolveConfig,
} from '../lib/guard.js'

const cfg = resolveConfig(undefined)

test('defaults are the documented ones', () => {
  assert.deepEqual(DEFAULTS, {
    maxSteps: 20,
    gracefulSteps: 8,
    maxFires: 2,
    cancelCause: 'turn-budget',
  })
  assert.deepEqual(cfg, DEFAULTS)
})

test('resolveConfig rejects non-positive integers', () => {
  for (const bad of [{ maxSteps: 0 }, { gracefulSteps: -1 }, { maxFires: 1.5 }]) {
    assert.throws(() => resolveConfig(bad), /must be a positive integer/)
  }
})

test('stays silent while the budget is unspent', () => {
  const state = initialState(1)
  for (let step = 1; step <= cfg.maxSteps; step++) {
    assert.deepEqual(decide(state, { step, turn: 1, userSteered: false, config: cfg }), { kind: 'pass' })
  }
  assert.equal(state.fires, 0)
  // The first step past the budget asks for a wrap-up, it does not stop the turn.
  const action = decide(state, { step: cfg.maxSteps + 1, turn: 1, userSteered: false, config: cfg })
  assert.equal(action.kind, 'request-wrap-up')
  assert.equal(state.fires, 1)
  assert.equal(state.firstFireStep, cfg.maxSteps + 1)
})

test('re-fires within the grace window, then cancels', () => {
  const state = initialState(1)
  const at = (step) => decide(state, { step, turn: 1, userSteered: false, config: cfg })

  assert.equal(at(cfg.maxSteps + 1).kind, 'request-wrap-up') // fire 1
  assert.equal(at(cfg.maxSteps + 2).kind, 'request-wrap-up') // fire 2
  // maxFires is 2, so the next step past the budget is the hard stop.
  const stop = at(cfg.maxSteps + 3)
  assert.equal(stop.kind, 'cancel')
  assert.equal(stop.cause, cfg.cancelCause)
  assert.match(stop.text, /stopped without a reply/)
})

test('a long silence without new wrap-up requests also cancels on the grace window', () => {
  const state = initialState(1)
  const first = decide(state, { step: 21, turn: 1, userSteered: false, config: cfg })
  assert.equal(first.kind, 'request-wrap-up')
  // Steps 22..28 are inside `gracefulSteps` (8) but every one would fire again;
  // once maxFires is spent the guard must not keep talking forever.
  let last = first
  for (let step = 22; step <= 40; step++) {
    last = decide(state, { step, turn: 1, userSteered: false, config: cfg })
  }
  assert.equal(last.kind, 'cancel')
})

test('a new turn resets the budget', () => {
  const state = initialState(1)
  decide(state, { step: 21, turn: 1, userSteered: false, config: cfg })
  assert.equal(state.fires, 1)
  assert.equal(decide(state, { step: 1, turn: 2, userSteered: false, config: cfg }).kind, 'pass')
  assert.equal(state.turn, 2)
  assert.equal(state.fires, 0)
  assert.equal(state.firstFireStep, null)
})

test('a user interjection mid-turn resets the budget', () => {
  const state = initialState(1)
  decide(state, { step: 21, turn: 1, userSteered: false, config: cfg })
  assert.equal(state.fires, 1)
  // The user typed something: they re-engaged, so the turn gets fresh room.
  assert.equal(decide(state, { step: 22, turn: 1, userSteered: true, config: cfg }).kind, 'pass')
  assert.equal(state.fires, 0)
})

test('hasUserText only counts real user input', () => {
  assert.equal(hasUserText([]), false)
  assert.equal(hasUserText([
    { source: { kind: 'tool' }, content: [{ type: 'text', text: 'output' }] },
  ]), false)
  assert.equal(hasUserText([
    { source: { kind: 'plugin', plugin: 'turn-budget-guard' }, content: [{ type: 'text', text: 'wrap up' }] },
  ]), false)
  assert.equal(hasUserText([
    { source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] },
  ]), false)
  assert.equal(hasUserText([
    { source: { kind: 'user' }, content: [{ type: 'text', text: 'stop looping' }] },
  ]), true)
})

test('the wrap-up text asks rather than forbids, and names the step count', () => {
  const state = initialState(1)
  const action = decide(state, { step: 25, turn: 1, userSteered: false, config: cfg })
  assert.match(action.text, /25 steps/)
  assert.match(action.text, /Reply to the user now/)
})
