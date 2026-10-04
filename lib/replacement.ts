import type { LaunchRecord } from './launch.ts';
export type ReplacementIntent='failure-recovery'|'execution-change';
export interface ReplacementContract {
  sourceCrew:Record<string,unknown>;
  sourceThreadId:string; environmentId:string; intent:ReplacementIntent; reason:string;
  recoveryCount:number; task:string; prompt:string;
  target:{providerId:string|null;model:string|null;reasoningLevel:string|null};
  nativeBriefSha?:string;
  stopped?:boolean; archived?:boolean; published?:boolean;
}
export function replacementPlan(crew:{threadId:string;relaunches?:number;replacementGeneration?:number},latest:LaunchRecord|undefined,contract:ReplacementContract) {
  const prior=latest?.replacement;
  if (prior?.sourceThreadId===crew.threadId) {
    for(const key of ['environmentId','intent','reason','recoveryCount','task','target'] as const) {
      if (JSON.stringify(prior[key])!==JSON.stringify(contract[key])) throw new Error('An existing replacement has a different immutable request. Reconcile that exact request first.');
    }
    return {generation:latest!.generation,contract:prior};
  }
  if (latest && ['reserved','creating','uncertain','provisioning'].includes(latest.state)) throw new Error('Unresolved prior launch must be reconciled before any new replacement; legacy intent cannot be guessed.');
  return {generation:Math.max(crew.replacementGeneration??1,(crew.relaunches??0)+1,latest?.generation??1)+1,contract};
}
