import { z } from 'zod';

// A routed supervisor is a recipient, not the execution identity of its child.
export const routedIntakeSchema=z.object({
  schema:z.literal(1),
  origin:z.object({captainId:z.string().nullable(),home:z.string()}),
  dispatch:z.object({
    task:z.string(),taskId:z.string(),projectId:z.string(),title:z.string().optional(),
    providerId:z.string().optional(),model:z.string().optional(),reasoningLevel:z.string().optional(),permissionMode:z.string().optional(),
    worktree:z.boolean(),visible:z.boolean(),shape:z.enum(['ship','scout']),mode:z.enum(['direct-PR','no-mistakes','local-only']),
    deliveryRequirement:z.enum(['branch','pr','merged','merged-and-verified']),branchPrefix:z.string().optional(),dispatchProfileReason:z.string().optional(),
  }),
  posture:z.object({mode:z.enum(['direct-PR','no-mistakes','local-only']),yolo:z.boolean(),
    provenance:z.object({source:z.literal('captain-instruction'),actor:z.string(),at:z.string(),reason:z.string()}).optional(),
  }),
});
export type RoutedIntake=z.infer<typeof routedIntakeSchema>;
export function renderRoutedIntake(intake:RoutedIntake):string {
  return `Routed work from main captain. Preserve the child intake below exactly; provider/model/reasoning select its worker, never this supervisor.\nBEGIN_FIRSTMATE_ROUTED_INTAKE\n${JSON.stringify(intake,null,2)}\nEND_FIRSTMATE_ROUTED_INTAKE\nDispatch the dispatch object with firstmate_dispatch after the native intake requirements. Posture records the originating captain's existing selection and provenance, not a new merge grant; reconcile authority through native secondmate/project policy. Do not change a delivery contract, infer approval from an unexplained flag, substitute supervisor settings, or add a review pipeline. Reply with the child crew id when underway.`;
}
