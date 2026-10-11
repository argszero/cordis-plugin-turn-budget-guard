/**
 * Turn budget guard for the dsh harness.
 *
 * Closes the "no ceiling on action" gap that Discussion #6366 measured: one
 * prompt that only edits a single configuration field consumed 33-50 assistant
 * turns and 32-70 tool calls across four runs, while the write itself took 1-3
 * turns. The reporter's own decomposition shows the inflation is in *actions*,
 * not in reasoning length: the model reaches the required knowledge by step
 * 6-12 and then spends 14-28 more steps proving it did not write anything wrong,
 * including verifying things that can only be known *after* the change is
 * applied.
 *
 * Why nothing in-tree catches it (`packages/core/agent-loop/src/agent.ts` on
 * dsh 0.1.5, verified at `c291e7961a`):
 *  - `turn()` is `while (true)` (`:286`) and every exit requires `turnEnds` to be
 *    set: `preStep` returns `reject` (`:290-293`), the admitted batch is empty
 *    (`:294-300`), or a step completed AND the next-step inbox drained
 *    (`:308-311`).
 *  - A step ends the turn only when it emits no tool call, or its tool calls
 *    "conclude" the turn (`:486-492`). A model that keeps calling tools
 *    therefore never sets `turnEnds`, and `executeToolCalls` refills
 *    `inbox.nextStep` with the tool results (`:489-491`) — every tool call
 *    manufactures the next iteration.
 *  - `grep` for `maxSteps` / `stepLimit` / `stepBudget` across `packages/` returns
 *    nothing: `AgentLoopSettings` (`packages/core/agent-loop/src/index.ts:309`)
 *    exposes only `maxParallelToolCalls`. There is no step, action, or spend
 *    ceiling anywhere in the loop.
 *  - `guard/timeout-policy` is a per-tool `tools/execute` deadline and
 *    `guard/repeat-tool-reminder` needs *identical* arguments on a repeated
 *    call; the measured run varies its arguments every time, so neither fires.
 *
 * The same gap is recorded in-tree as a known blueprint: memory
 * `c4a9e6b2` (`#2821` rc.7 analysis) proposed `AgentLoopSettings.maxSteps`, a
 * sticky turn-end reason, and draining already-queued tool results. None of that
 * has landed, so this plugin is the community-side mitigation.
 *
 * ## Mechanism
 *
 * The plugin observes the public `agent/pre-step` waterfall
 * (`packages/core/agent/src/runtime-types.ts:330`), which runs once per proposed
 * loop step with `{ agent, messages, turn, step, signal }`. That payload already
 * states the two numbers a ceiling needs — `turn` and `step` — so counting needs
 * no extra bookkeeping and no internal access.
 *
 * This is a **watchdog, not a muzzle**: while the budget is unspent the listener
 * only delegates (`next()`). On exceeding it the guard sends the model a logged
 * user message that asks for the "what is still missing" report, and escalates to
 * `agent.cancel(cause)` only after further steps produced no new attempt to
 * comply.
 *
 * `agent.cancel()` takes the **closed** `AgentCancelCause` union
 * (`packages/core/session/src/types.ts`), and the loop reads the abort signal back
 * with `abortedCancelCause()` (`packages/core/agent-loop/src/agent.ts`), whose
 * last branch is `default: return assertNever(cause)`. Anything outside the union
 * throws **inside the turn's `catch`**, so `turnEnds` keeps its `null` initializer
 * and the `finally` appends `turn/end` with `reason: null` — a record the write
 * path never checks and the client's turn rendering cannot survive: one such row
 * blanks the whole session list (#8832, #9156). This guard therefore hands over
 * the union's `hook` member — `{ kind: 'hook', reason: <cancelCause> }`, the shape
 * core itself writes for `deepseek-account/signed-out` — via `cancelCauseFor`.
 *
 * Everything it adds to the transcript is a normal `user/message` with
 * `source.kind:'plugin'` carrying the plugin name, the convention
 * `guard/repeat-tool-reminder` uses
 * (`packages/guard/repeat-tool-reminder/src/index.ts:57`, `:200-206`), so the
 * injection is attributable and filterable.
 *
 * ## Contract boundaries (verified, not assumed)
 *
 *  - `agent/pre-step` may only replace the messages *entering* a step or reject
 *    it; a `reject` decision closes the turn as `blocked`
 *    (`agent.ts:290-293`), it does not stop a loop. That is why the escalation
 *    ladder is a message plus `cancel`, never a veto.
 *  - The admitted messages are durably appended as `user/message`
 *    (`agent.ts:374-376`), so a wrap-up request is committed to the session log
 *    and is not just wire-level advice.
 *  - A real user interjection (inbound `source.kind:'user'` text) resets the
 *    budget: the user re-engaged, so the turn gets fresh room. This mirrors the
 *    in-tree reset in `guard/repeat-tool-reminder` (`:229-233`, "A user
 *    interjection changes the context").
 *
 * @module @argszero/cordis-plugin-turn-budget-guard
 */

/** Source identity stamped on every message this guard injects. */
export const PLUGIN_NAME = 'turn-budget-guard'

/** The optional plugin config fields; the entry point re-declares this as exported `Config`. */
export interface ConfigInput {
  /**
   * Steps within one turn before the guard fires its first wrap-up request.
   * Default `20`.
   */
  maxSteps?: number
  /**
   * Extra steps tolerated after the first wrap-up request before the guard
   * cancels the turn. Default `8`.
   */
  gracefulSteps?: number
  /**
   * How many wrap-up requests may be sent in one turn before cancelling, even
   * while still inside `gracefulSteps`. Default `2`.
   */
  maxFires?: number
  /**
   * Cause **reason** handed to `agent.cancel`. Default `'turn-budget'`.
   *
   * It is the `reason` of the closed union's `hook` member, not a bare cause: the
   * emitted value is `{ kind: 'hook', reason: <this string> }` and the persisted
   * turn ending is
   * `{ kind: 'aborted', reason: { kind: 'hook', reason: <this string> } }`. See
   * {@link cancelCauseFor}.
   */
  cancelCause?: string
}

/** Resolved config with every default applied. */
export interface ResolvedConfig {
  readonly maxSteps: number
  readonly gracefulSteps: number
  readonly maxFires: number
  readonly cancelCause: string
}

/** Defaults, exported so tests and README agree with the runtime. */
export const DEFAULTS: ResolvedConfig = {
  maxSteps: 20,
  gracefulSteps: 8,
  maxFires: 2,
  cancelCause: 'turn-budget',
}

/** Validate and normalize the plugin config. */
export function resolveConfig(config: ConfigInput | undefined): ResolvedConfig {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  const positive = (value: number, field: string): number => {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${PLUGIN_NAME}: ${field} must be a positive integer`)
    }
    return value
  }
  return {
    maxSteps: positive(merged.maxSteps, 'maxSteps'),
    gracefulSteps: positive(merged.gracefulSteps, 'gracefulSteps'),
    maxFires: positive(merged.maxFires, 'maxFires'),
    cancelCause: merged.cancelCause,
  }
}

/** The wrap-up request. Deliberately a question, not a prohibition. */
export const WRAP_UP_TEXT =
  'Turn budget: this turn has spent {steps} steps and delivered no answer yet. '
  + 'Reply to the user now with what is already done, what remains, and the single next action. '
  + 'Do not open another round of verification for facts that are already established.'

/** Text injected immediately before the hard stop. */
export const FINAL_TEXT =
  'Turn budget exhausted ({steps} steps): this turn is being stopped without a reply. '
  + 'The user can see the work recorded so far.'

// ---------------------------------------------------------------------------
// Minimal structural faces.
//
// The guard mounts on a plain Cordis application, so it must not require the
// harness type graph to load. These are the exact shapes it reads; a full
// harness workspace supplies the real `@deepseek-ai/dsh-agent` types.
// ---------------------------------------------------------------------------

/** The subset of `Agent` the guard reads or calls. */
export interface GuardableAgent {
  /** Stable session identity, used as the per-agent state key. */
  readonly session: { readonly id: string }
  /**
   * Abort the active turn. The guard always passes `keepInbox` so queued user
   * input survives the stop (`packages/core/agent/src/runtime-types.ts`,
   * `CancelOptions`), and always passes a member of {@link AgentCancelCause}.
   */
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void
}

/**
 * Why an active turn may be cancelled — the union core treats as closed.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-agent` for the reason
 * stated above: this module must load on a plain Cordis application, without the
 * harness type graph. The four members and their importances are core's
 * (`packages/core/session/src/types.ts`); a fifth `kind` is not additive, because
 * the loop's reader ends in `assertNever`.
 */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/**
 * The cancellation cause this guard hands to `agent.cancel()`.
 *
 * `hook` is the member a plugin owns, and the one core uses itself
 * (`{ kind: 'hook', reason: 'deepseek-account/signed-out' }`). The object matters,
 * not the string: `abortedCancelCause()` copies a recognized `kind` back and
 * `assertNever`s anything else, from inside the turn's `catch`, where the throw
 * costs the `turnEnds` assignment and the `finally` then writes `turn/end` with
 * `reason: null` (#8832, #9156).
 *
 * The configured string is the cause's `reason`, not its `kind`, so the config
 * surface is unchanged: `cancelCause: 'x'` reads back as
 * `{ kind: 'aborted', reason: { kind: 'hook', reason: 'x' } }`.
 *
 * @param reason - the resolved `cancelCause` string.
 * @returns a cause the loop's closed-union switch returns instead of throwing.
 */
export function cancelCauseFor(reason: string): AgentCancelCause {
  return { kind: 'hook', reason }
}

/** The subset of an inbound message the guard inspects. */
export interface InboxMessage {
  readonly source: { readonly kind?: string; readonly plugin?: string }
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/** The `agent/pre-step` decision the guard forwards or extends. */
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: unknown[]; startsRequestSeries?: true }

/** Factory used to build the injected message; injectable so tests can stub it. */
export type MessageFactory = (text: string, summary: string) => unknown

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(
      payload: {
        agent: GuardableAgent
        messages: InboxMessage[]
        turn: number
        step: number
      },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
  }
}

// ---------------------------------------------------------------------------
// Decision rule (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * One agent's accumulated budget state.
 *
 * `baselineStep` is why this is not simply `{ turn, fires }`. `step` is the loop's
 * own monotonically increasing counter within the turn, so resetting only the fire
 * counters would leave the very next step still past `maxSteps` — a user who
 * re-engages at step 30 with a budget of 20 would get no room at all. The budget is
 * therefore measured *relative* to the baseline: the effective spend is
 * `step - baselineStep`.
 */
export interface BudgetState {
  /** Turn the counters belong to. */
  turn: number
  /** Step the current budget period started at (0 for a fresh turn). */
  baselineStep: number
  /** Wrap-up requests already sent in this budget period. */
  fires: number
  /** Effective step of the first wrap-up request (`null` = none sent yet). */
  firstFireStep: number | null
}

/** Fresh state for a turn. */
export function initialState(turn: number): BudgetState {
  return { turn, baselineStep: 0, fires: 0, firstFireStep: null }
}

/** What the guard decided to do at one proposed step. */
export type BudgetAction =
  | { kind: 'pass' }
  | { kind: 'request-wrap-up'; step: number; text: string }
  | { kind: 'cancel'; step: number; text: string; cause: string }

/**
 * Whether the step admits any real user text.
 *
 * A `source.kind:'user'` message is the user's own input (tool results carry
 * `source.kind:'tool'`), so this is the signal that a human re-engaged mid-turn.
 */
export function hasUserText(messages: readonly InboxMessage[]): boolean {
  return messages.some(message => message.source.kind === 'user'
    && message.content.some(block => block.type === 'text' && (block.text ?? '').trim().length > 0))
}

/**
 * Decide the action for one proposed step.
 *
 * Kept pure so the thresholds and the escalation ladder are unit-testable
 * without a harness: `apply()` only performs the decision.
 *
 * @param state - this agent's accumulated state; mutated in place when it lapses.
 * @param input - the step facts and the resolved config.
 * @returns the action to perform.
 */
export function decide(
  state: BudgetState,
  input: { step: number; turn: number; userSteered: boolean; config: ResolvedConfig },
): BudgetAction {
  const { step, turn, userSteered, config } = input
  if (turn !== state.turn) {
    // A new turn restarts the loop's step counter, so the baseline is zero.
    state.turn = turn
    state.baselineStep = 0
    state.fires = 0
    state.firstFireStep = null
  } else if (userSteered) {
    // The user re-engaged mid-turn: rebase so the turn gets a full budget from
    // here. Rebase to `step`, not `step - 1`, because the message the user just
    // sent is itself admitted by this step.
    state.baselineStep = step
    state.fires = 0
    state.firstFireStep = null
  }

  const spent = step - state.baselineStep
  if (spent <= config.maxSteps) return { kind: 'pass' }

  const sinceFirstFire = state.firstFireStep === null ? 0 : spent - state.firstFireStep
  if (state.fires >= config.maxFires || sinceFirstFire > config.gracefulSteps) {
    return {
      kind: 'cancel',
      step,
      cause: config.cancelCause,
      text: FINAL_TEXT.replace('{steps}', String(spent)),
    }
  }
  state.fires += 1
  if (state.firstFireStep === null) state.firstFireStep = spent
  return {
    kind: 'request-wrap-up',
    step,
    text: WRAP_UP_TEXT.replace('{steps}', String(spent)),
  }
}
