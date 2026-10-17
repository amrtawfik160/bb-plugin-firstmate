// Owner layer (16-17 Oct decisions Q4, Q8, Q19): the fixed pipeline for code work and
// the principles every crew brief names. lib/crew-contract.ts renders them into the
// brief and checks the crew's report against them.

export const CORE_PRINCIPLES = [
  "principle-prove-it-works",
  "principle-fix-root-causes",
  "principle-attack-the-premise",
  "principle-test-behavior-not-implementation",
] as const;

export const PROOF_STEP = "Prove on the real surface";

export type PipelineStep = { title: string; skills: readonly string[]; evidence: string };
export type PipelineTask = "bug-fix" | "feature";

const PROVE: PipelineStep = {
  title: PROOF_STEP,
  skills: ["verify-this"],
  evidence: "the PR and head you proved, what you drove and what you saw",
};

// Refactor and perf keep their playbook steps. Research and writing have no fixed pipeline.
export const CODE_PIPELINES: Readonly<Record<PipelineTask, readonly PipelineStep[]>> = {
  "bug-fix": [
    { title: "Diagnose", skills: ["diagnosing-bugs"], evidence: "the root cause and how you found it" },
    { title: "Failing test", skills: ["tdd"], evidence: "the test name and the commit id of the failing test" },
    { title: "Fix at the root", skills: [], evidence: "where the system first went wrong and the fix commit id" },
    PROVE,
    { title: "Blast radius", skills: ["blast-radius"], evidence: "what else the change could break and what you ran to rule it out" },
    { title: "No comments", skills: ["no-comments"], evidence: "the comments you removed, or none" },
    { title: "PR", skills: ["pr"], evidence: "the PR link" },
  ],
  feature: [
    { title: "Sharpen", skills: ["sharpen"], evidence: "the sharpened request in one sentence" },
    { title: "Architect", skills: ["architect"], evidence: "the data shape and the design you chose" },
    { title: "TDD build", skills: ["tdd"], evidence: "the test names, each failing before its code" },
    PROVE,
    { title: "Code review", skills: ["code-review"], evidence: "the findings and what you fixed" },
    { title: "No comments", skills: ["no-comments"], evidence: "the comments you removed, or none" },
    { title: "PR", skills: ["pr"], evidence: "the PR link" },
  ],
};

export function codePipeline(playbook: string): readonly PipelineStep[] | null {
  return Object.hasOwn(CODE_PIPELINES, playbook) ? CODE_PIPELINES[playbook as PipelineTask] : null;
}

// Q4 migration (17 Oct): crews dispatched from this version on carry it. Only they get the
// P4 proof gate, because an older crew's report was written without P4. The checker rule
// covers every production merge, old PRs too.
export const DISPATCH_VERSION = 2;
export function pipelineGates(crew: { dispatchVersion?: number }): boolean {
  return (crew.dispatchVersion ?? 1) >= DISPATCH_VERSION;
}

export function proofStep(steps: readonly PipelineStep[]): number {
  return steps.findIndex((step) => step.title === PROOF_STEP) + 1;
}
