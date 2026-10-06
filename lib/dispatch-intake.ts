export type TaskDeliveryRequirement = 'branch' | 'pr' | 'merged' | 'merged-and-verified';
export const FM_WRAPPER_HELP='bb firstmate fm [--timeout s] <script> -- [native args...]\nNative help: bb firstmate fm brief -- --help (separator required); use firstmate_fm script=brief args=["--help"] for the tool. Without --, CLI --help shows this wrapper. For managed launch use bb firstmate dispatch: it owns brief→dispatch-resolve→backlog→spawn.';

export function taskDelivery(mode: string, requirement?: TaskDeliveryRequirement, shape='ship'): TaskDeliveryRequirement {
  if (shape!=='ship') {
    if (requirement==='branch') throw new Error('Branch delivery applies only to ship tasks; scouts retain their durable report contract.');
    return requirement ?? 'merged';
  }
  if (requirement === 'branch' && mode !== 'local-only') throw new Error('Branch delivery requires mode=local-only.');
  if (mode === 'local-only' && requirement !== undefined && requirement !== 'branch') throw new Error('local-only delivers ready in branch; a PR/merge requirement conflicts with that mode. Choose branch or omit the requirement.');
  return requirement ?? (mode === 'local-only' ? 'branch' : 'merged');
}

// Native owns resolution, including its opt-in/off and configuration guards.
// BB cannot infer a native harness's provider/account from an SDK provider ID.
export function nativeDispatchIntake(exitCode: number | null, output: string, reason?: string): string {
  if (exitCode !== 0) throw new Error(`Native dispatch-resolve configuration/usage refusal: ${output}`);
  if (/^dispatch-resolve: off\b/m.test(output)) return 'off';
  const matches = [...output.matchAll(/^\s{2}status: (clear|ambiguous|escalate|error)\s*$/gm)];
  if (matches.length !== 1) throw new Error('Native dispatch-resolve returned no unique status; intake remains unresolved.');
  const status = matches[0][1];
  if (!reason?.trim()) throw new Error(`Native dispatch-resolve status=${status}. Read its result, apply the native intake/approval rules, then reuse this taskId with explicit BB provider/model/reasoning and dispatchProfileReason explaining the selected BB execution or override. Native harness profiles are not silently mapped to provider accounts.\n${output}`);
  return status;
}

export const DISPATCH_TRANSPORT = 'BB native dispatch intake (transport=real after deck/init --real): use firstmate_dispatch or bb firstmate dispatch after native project/shape/mode/execution intake; the operation writes the native brief, immediately runs fm-dispatch-resolve on that written brief, seeds or reuses the exact native backlog row, then runs guarded fm-spawn (backend=bb, harness=bb). Do not create a matching brief or call spawn separately. taskId is optional and generated when omitted; reuse a returned taskId after refusal/uncertainty. providerId/model/reasoningLevel choose the BB worker, not the captain or a native CLI harness. Native resolver off preserves this intake; enabled results need dispatchProfileReason recording the native intake decision and explicit BB execution selection, without granting approval or inferring provider/account mappings. mode selects the native brief/spawn contract; firstmate_posture supplies registered mode/yolo/branchPrefix and approval context. Yolo comes from existing posture, not the worker or a fresh approval inferred from a flag; task instructions and native authority still apply. branchPrefix (CLI --branch-prefix) defaults to fm/ and is passed identically to brief and spawn; pass the intake-selected registered prefix or current override. local-only defaults to deliveryRequirement=branch: implement, validate, commit on the isolated branch and stop ready in branch, with no push/PR/merge from that contract; later local merge is a separate authorized guarded operation. Native help: firstmate_fm script=brief args=["--help"], or bb firstmate fm brief -- --help; without the separator CLI --help describes the wrapper.';
