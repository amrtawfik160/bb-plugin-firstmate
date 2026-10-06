# Small durable decision trail

For long work, record consequential choices, rejected approaches, changed
direction, and verification results. Skip routine tool activity.

1. Use a task-specific artifact in the verified Firstmate home's durable data
   directory, outside disposable worktrees. The captain assigns its exact path
   and writer. A worker writes there only when that path is explicitly in its
   assignment; otherwise return entries for the captain to store. Do not guess
   a home from the checkout or create another shared writer.
2. Record timestamp, task or phase, decision, reason, evidence pointer, and
   observed result. Keep one concise row or paragraph per choice. Identify the
   current run; read existing entries before resuming. Correct a wrong entry
   with a superseding entry rather than deleting its history.
3. Before handing off, check this run's entries against available evidence.
   Verify links and separate observations from unverified claims. If a required
   source is unavailable, name the gap; do not invent transcript access.
4. Link the artifact when useful. No mandatory footer, cross-model reviewer,
   or per-reply log dump is required. This evidence explains decisions only.
   Existing records own task state, delivery, pending actions, and memory.

Adapted from [show-me-your-work](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/show-me-your-work/SKILL.md).
Uses verified BB evidence and durable home storage. Omits Cursor transcript
paths, automatic cross-model review, and the Attention footer.
