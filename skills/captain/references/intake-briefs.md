# Intake + briefs

Read when taking a new request, before dispatching.

## Intake

1. Resolve the project independently per request. Explicit wins; clear
   follow-up inherits; else match registry + work underway + code/README.
   One confident match → proceed, naming it plainly. Zero/many → one concise
   question.
2. Route: persistent domain captain (secondmate) owns in-scope work unless
   blocked or redirected. `local-only` style work stays in this home.
   One-off ops take the simplest direct path — no wrappers, control planes,
   or automation without a concrete repeated need.
3. Before commissioning investigation, consult existing reports/evidence.
   Answered already → relay, no scout. Intent unclear → answer + one concise
   implementation question, not speculative design dispatch.
4. A diagnostic, recommendation, or finding is evidence, not authorization
   to change code. Scope reported bugs carefully before acting.

## Ship vs scout

- **Ship** (default): produces a project change. Once implementation is
  authorized, dispatch ship; keep bounded research inside unless uncertainty
  could materially change whether/what to build.
- **Scout**: produces knowledge only, never a PR. Right when captain wants a
  standalone report/design, or unresolved uncertainty could change the build.

## Delivery posture

Resolve per ship task at intake, state it in the brief. Standing registry:
`posture set --project <id> --mode <m> [--yolo on|off]`; dispatch uses it
unless `--mode` overrides. Deviations get a one-line reason in the brief.

- **direct-PR**: push + open PR, no extra pipeline. Default rigor.
- **no-mistakes**: full pipeline (review, fixes, tests, docs, CI) through a
  PR. Use when risk demands it — escalate the choice, don't invent a manual
  gate. Never stack serial manual reviews or hold fast-path work for clean
  verdicts.
- **local-only**: stop at clean ready branch, no push/PR; guarded landing
  after approval.
- **yolo** (orthogonal, merge authority only): off = captain approves every
  merge/landing. On = mate merges green in-scope work itself. Granted only by
  explicit captain word per project. Never authorizes red merges.

## Concurrency

File/subsystem overlap is a risk signal, not a wait reason. Dispatch
immediately, no cap, when each change is independently implementable and
validatable and the path reconciles ordinary rebases. Serialize only: true
semantic dependency, shared mutable external state, incompatible concurrent
migration, or another concrete unsafe condition. Same-file editing alone
never suffices. Genuine blockers stay durable and visible.

## Brief writing

Every `--task` / `firstmate_dispatch` task packs two sections:

- **Captain's intent**: the ask verbatim + stated boundaries + context to
  read it (linked report/decision/PR substance). Acceptance criteria. Never
  widen into general goals or coverage lists.
- **Firstmate spec**: only the build instructions the ask requires. Name what
  stays out of scope when narrow. Unasked hardening/sweeps = follow-up note,
  not scope.

New requirements mid-task → follow-up work, unless they completely invalidate
the work under validation. Corrections to accepted intent are not new
requirements. When captain amends intent mid-task, relay their exact words.
