# @argszero/cordis-plugin-turn-budget-guard

A **turn budget guard** for the [dsh](https://github.com/deepseek-ai/deepseek-harness) harness.

An agent turn in dsh has no ceiling on the number of **actions** it may take. A model
that keeps calling tools never ends its turn: `turn()` is `while (true)`, and every exit
requires the step to complete without a tool call. The result is measured in
[Discussion #6366](https://github.com/deepseek-ai/deepseek-harness/discussions/6366) —
four runs of the *same* prompt that only adds one configuration field:

| run | rule file | mode | turns | tool calls |
|---|---|---|---|---|
| 1 | loaded | PTC | 39 (user interrupted) | — |
| 2 | none | PTC | 50 | 59 |
| 3 | none | PTC | 33 | 32 |
| 4 | none | standard | 43 | 70 |

The write itself took 1–3 turns each time. One instrumented run spent **2,946,619 input
tokens, 3% of them in the write step**. The reporter's own decomposition localises the
inflation: the model has the answer by step 6–12 and then spends 14–28 further steps
verifying facts that can only be known *after* the change is applied.

This plugin gives a turn a budget.

## Install

```sh
npm install @argszero/cordis-plugin-turn-budget-guard
```

Mount it through a `dsh` profile layer (the package ships a `dsh.bundle` patch):

```yaml
- insert:
    - id: turn-budget-guard
      name: '@argszero/cordis-plugin-turn-budget-guard'
      config:
        maxSteps: 20
        gracefulSteps: 8
```

## Configuration

| field | default | meaning |
|---|---|---|
| `maxSteps` | `20` | Steps in one turn before the guard asks the model to wrap up. |
| `gracefulSteps` | `8` | Further steps tolerated after the first wrap-up request before the turn is stopped. |
| `maxFires` | `2` | Wrap-up requests per budget period, even while inside the grace window. |
| `cancelCause` | `'turn-budget'` | Cause handed to `agent.cancel`. |

## What it does, in order

1. **Before `maxSteps`** — nothing. The listener delegates (`next()`) without touching
   the admitted messages.
2. **Past `maxSteps`** — appends one logged message asking the model to *reply now*:
   what is done, what remains, what the next action is. This is the reporter's
   suggestion #2 made concrete: forcing the "what is still missing" report instead of
   silently continuing. The message is a normal `user/message` with
   `source.kind:'plugin'` and `plugin:'turn-budget-guard'`, so it is attributable and
   filterable (`session-audit`, a redactor) and can never be mistaken for the user.
3. **`gracefulSteps` later, or `maxFires` spent** — `agent.cancel('turn-budget')` with
   **`keepInbox: true`**, so anything the user typed while watching survives for the
   next turn. The reason reaches the transcript as the turn's
   `{ kind: 'aborted', reason }`.

It is a **watchdog, not a muzzle**: a turn that finishes inside the budget is never
touched, and a user who types mid-turn rebases the budget from that step — the human
re-engaged, so the turn deserves fresh room.

## How it works

The plugin subscribes to the public `agent/pre-step` waterfall, which runs once per
proposed loop step and already carries the two numbers a ceiling needs:

```ts
ctx.on('agent/pre-step', ({ agent, messages, turn, step }, next) => { … })
```

No internal access and no extra bookkeeping: `step` *is* the loop's own counter.

The budget is measured **relative to a baseline** rather than against the raw step
number. That detail is load-bearing: `step` grows monotonically within a turn, so a
user re-engaging at step 30 with `maxSteps: 20` would otherwise still be "past budget"
on the very next step, and the rebase would grant nothing.

## Peer range

The plugin declares `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-llm` as
peer dependencies, both with the same range:

```
>=0.1.2-rc.1 <0.1.3 || >=0.1.3-alpha.2 <0.1.4 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-alpha.1 <0.2.0
```

Every dsh release published today is a **prerelease** (`0.1.2-rc.1`, `0.1.5-alpha.1`,
`0.1.6-alpha.2`, …), and a semver comparator admits a prerelease only when some
comparator **in the same group** shares its `major.minor.patch` tuple. Two
consequences follow, and both have already bitten this package:

```jsonc
// Matches nothing: 0.1.2-rc.1 sorts BELOW 0.1.2, and every other prerelease
// carries a different tuple.  -> ETARGET, the package cannot be installed.
">=0.1.2"

// Only the 0.1.2-rc tuple. The `<0.2.0` upper bound is INERT for prereleases:
// it excludes no later line, so every other line gets ERESOLVE.
">=0.1.2-rc.1 <0.2.0"
```

The second form is the dangerous one, because it *reads* as though it covered
everything from `0.1.2-rc.1` onward. It does not — `<0.2.0` never excludes
`0.1.6-alpha.2`, and no comparator names that tuple. Up to **v0.1.0** the
shipped range was

```
>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0
```

which admitted the `0.1.2-rc` and `0.1.5` tuples and **nothing else** — 5 of the
23 published versions. A user on the newest shipped dsh release
(`0.1.6-alpha.2`) therefore could not install the plugin at all:

```
npm error ERESOLVE unable to resolve dependency tree
npm error peer @deepseek-ai/dsh-llm@">=0.1.2-rc.1 <0.2.0 || ..." from
npm error   @argszero/cordis-plugin-turn-budget-guard@0.1.0
```

The plugin's own suite passes on that line (16/16). The dsh packages are
**peers**, so `--legacy-peer-deps` is not something a consumer can reasonably be
asked to accept: the install simply fails.

**What we ship:** one comparator per supported tuple, each with its own upper
bound so the intended span is legible rather than implied.

| clause | admits |
| --- | --- |
| `>=0.1.2-rc.1 <0.1.3` | `0.1.2-rc.1` |
| `>=0.1.3-alpha.2 <0.1.4` | `0.1.3-alpha.2` |
| `>=0.1.5-alpha.1 <0.2.0` | the whole 0.1.5 line (alpha.1, alpha.2, rc.1, rc.2) |
| `>=0.1.6-alpha.1 <0.2.0` | the whole 0.1.6 line (alpha.1, alpha.2) |

`test/peer-range` **computes** the admitted set with the real `semver` package
and asserts it equals exactly the set the suite has been run against — 8
versions — rather than pattern-matching the range string. An earlier guard only
checked that the string mentioned `0.1.2-rc.N` and `0.1.5-alpha.N`; that form
cannot tell a correct range from an incorrect one, which is how the range above
shipped green. Asserting the set exactly makes both directions loud: dropping a
supported line fails, and admitting an unverified line fails too. The same file
also asserts that this README quotes the manifest range verbatim.

## Verified against

dsh `0.1.5` sources at commit `c291e7961a`:

- `packages/core/agent-loop/src/agent.ts` — `turn()` `while (true)` at `:286`; the exit
  conditions at `:290-311`; the turn only ends when the step emits no tool call or its
  calls conclude the turn (`:486-492`); admitted messages are appended as
  `user/message` (`:374-376`).
- `packages/core/agent-loop/src/index.ts:309` — `AgentLoopSettings` exposes only
  `maxParallelToolCalls`; `grep` for `maxSteps` / `stepLimit` / `stepBudget` across
  `packages/` returns nothing.
- `packages/core/agent/src/runtime-types.ts:330` — the `agent/pre-step` contract;
  `:112-119` — `PreStepDecision`; `:40-45` — `CancelOptions.keepInbox`.
- `packages/core/session/src/index.ts:328-345` — a `user/message` must carry a non-empty
  `id` and `role: 'user'`, which is why the notice is built with `createUserMessage`.
- `packages/guard/repeat-tool-reminder/src/index.ts:57`, `:200-206` — the
  `source.kind:'plugin'` + plugin-name injection convention this plugin follows.

## Relationship to the in-tree guards

Neither catches the shape #6366 measures:

- `guard/timeout-policy` is a per-tool `tools/execute` deadline — the measured loop
  calls tools that succeed.
- `guard/repeat-tool-reminder` needs *identical* arguments across repeated calls; the
  measured run varies its arguments every step.

The in-tree blueprint for a real fix already exists (a `maxSteps` setting plus a sticky
turn-end reason), and this plugin is the community-side mitigation until it lands. If
the harness grows a step budget, set `maxSteps` above it or drop the plugin: it is a
pure watchdog and goes silent when the turn ends on its own.

## Tests

```sh
npm test
```

16 tests, no harness required: the decision rule (pure, in `src/guard.ts`) plus the
listener against a real Cordis context.
