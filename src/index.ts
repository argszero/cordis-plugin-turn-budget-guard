/**
 * Turn budget guard for the dsh harness — plugin entry.
 *
 * The mechanism, the in-tree gap it closes, and the run that measured it are
 * documented in `./guard.ts`. In short: Discussion #6366 recorded four runs of
 * the same one-field config edit at 33-50 assistant turns and 32-70 tool calls,
 * with 1-3 turns doing the actual write, and the `agent-loop` still has no step
 * budget (`grep` for `maxSteps` across `packages/` is empty; in-tree
 * `AgentLoopSettings` exposes only `maxParallelToolCalls`).
 *
 * This plugin watches `agent/pre-step` — the one seam that already carries
 * `{ turn, step }` — and asks a runaway turn to wrap up before stopping it.
 *
 * @module @argszero/cordis-plugin-turn-budget-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { DEFAULTS, PLUGIN_NAME, decide, hasUserText, initialState, resolveConfig } from './guard.js'
import type {
  BudgetState,
  ConfigInput,
  InboxMessage,
  MessageFactory,
  PreStepDecision,
  ResolvedConfig,
} from './guard.js'

export {
  DEFAULTS,
  FINAL_TEXT,
  PLUGIN_NAME,
  WRAP_UP_TEXT,
  decide,
  hasUserText,
  initialState,
  resolveConfig,
} from './guard.js'
export type { BudgetAction, BudgetState, InboxMessage, ResolvedConfig } from './guard.js'

/**
 * Plugin config; the runtime shape is {@link ConfigInput}. Declared here as a
 * local interface so it merges with the `Config` schema value below, which is
 * what the harness reads before calling `apply()`.
 */
export interface Config extends ConfigInput {}

/**
 * The config schema the harness resolves before `apply()`.
 *
 * `.step(1)` keeps fractional steps out. The defaults live in `./guard.ts` so the
 * harness-free unit tests and the runtime agree by construction rather than by
 * convention.
 */
export const Config: z<Config> = z.object({
  maxSteps: z.number().step(1).min(1).default(DEFAULTS.maxSteps),
  gracefulSteps: z.number().step(1).min(1).default(DEFAULTS.gracefulSteps),
  maxFires: z.number().step(1).min(1).default(DEFAULTS.maxFires),
  cancelCause: z.string().default(DEFAULTS.cancelCause),
})

export const name = PLUGIN_NAME

/**
 * Build one attributable notice message.
 *
 * `source.kind:'plugin'` + the plugin name is the convention the in-tree
 * `guard/repeat-tool-reminder` uses, and it matters here for two reasons: the
 * guard's own message must never be mistaken for the user's input, and a
 * downstream plugin (`session-audit`, a redactor) can identify and filter it.
 *
 * `createUserMessage` is REQUIRED rather than convenient: `session.append`
 * validates that every `user/message` carries a non-empty string `id` and
 * `role: 'user'` (`packages/core/session/src/index.ts:328-345`, "lacks an
 * identified message"), and this factory is what supplies both.
 */
const message: MessageFactory = (text, summary) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary },
})

/**
 * Install the guard.
 *
 * @param ctx - the Cordis context the plugin is mounted on.
 * @param config - resolved plugin config (the harness applies {@link Config}).
 */
export function apply(ctx: Context, config: Config = {}): void {
  // The harness normalizes `config` through the schema below before mounting;
  // resolving again keeps a hand-wired mount (no schema applied) identical.
  const resolved: ResolvedConfig = resolveConfig(config)
  // One budget per session id. The listener reads only `turn`/`step`/`messages`
  // from the payload and `agent.session.id` from the agent, so — unlike a plugin
  // that resolves `ctx.agents` — no service injection is required.
  const states = new Map<string, BudgetState>()

  ctx.on('agent/pre-step', ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const key = agent.session.id
    const state = states.get(key) ?? initialState(turn)
    states.set(key, state)
    const action = decide(state, {
      step,
      turn,
      userSteered: hasUserText(messages as readonly InboxMessage[]),
      config: resolved,
    })

    if (action.kind === 'pass') return next()

    if (action.kind === 'cancel') {
      // The cancel reason is what reaches the transcript: the aborted turn ends
      // with `{ kind: 'aborted', reason }` (`TurnEndReasonMap.aborted`), so the
      // cause is the attribution — no extra message is invented here.
      //
      // `keepInbox: true` is deliberate. The default `cancel()` clears queued and
      // steering work (`runtime-types.ts` "Clear queued and steering work —
      // unless `keepInbox`"), which would silently discard input the user typed
      // while watching the loop — the exact opposite of this guard's purpose.
      ctx.logger.info(
        `${PLUGIN_NAME}: cancelling turn ${turn} at step ${step}`
        + ` (budget ${resolved.maxSteps} + grace ${resolved.gracefulSteps})`,
      )
      states.delete(key)
      agent.cancel(action.cause, { keepInbox: true })
      return next()
    }

    ctx.logger.info(`${PLUGIN_NAME}: requesting wrap-up for turn ${turn} at step ${step}`)
    return next().then((decision) => {
      // A downstream listener may have closed the turn; never resurrect it.
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: [...decision.messages, message(action.text, `turn-budget step ${step}`)],
      }
    })
  })
}
