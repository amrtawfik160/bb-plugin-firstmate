// Owner layer (decisions Q10, Q11): the default execution of each crew role. A provider,
// model or effort the owner names in a message applies to that dispatch only.

export const CREW_ROLES = ["builder", "checker", "lookup"] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

// Owner rule (18 Oct): Codex crews and checkers default to gpt-6.1-sol. Another model the owner
// names for a task is allowed. gpt-6-astra runs only with his permission: the dispatch or
// execution change carries modelPermission, the ref of his message (tg:<chat>:<message>).
export const CODEX_MODEL = "gpt-6.1-sol";
export const PERMISSION_MODELS: ReadonlySet<string> = new Set(["gpt-6-astra"]);
const OWNER_MESSAGE_REF = /^(?:tg|bb):[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

/** The refusal for a model that needs the owner's permission and has none; null when allowed. */
export function modelPermissionRefusal(model: string | undefined, permission: string | undefined): string | null {
  if (model === undefined || !PERMISSION_MODELS.has(model) || OWNER_MESSAGE_REF.test(permission?.trim() ?? "")) return null;
  return `Refusing: ${model} needs the owner's permission. Pass modelPermission with his message ref (tg:<chat>:<message>). Nothing was spawned.`;
}

export const ROLE_DEFAULTS: Readonly<Record<CrewRole, { providerId: string; model: string }>> = {
  builder: { providerId: "claude-code", model: "claude-opus-5-5" },
  checker: { providerId: "codex", model: CODEX_MODEL },
  lookup: { providerId: "claude-code", model: "claude-haiku-5-5" },
};

// A named provider without a model runs that provider's own default model, except Codex,
// which runs CODEX_MODEL. A named model without a provider keeps the role's provider;
// dispatch refuses it if that provider does not offer it.
export function crewExecution<L extends string>(input: { role?: CrewRole; providerId?: string; model?: string; reasoningLevel?: L; modelPermission?: string }) {
  const refusal = modelPermissionRefusal(input.model, input.modelPermission);
  if (refusal !== null) throw new Error(refusal);
  const role = input.role ?? "builder";
  const fallback = ROLE_DEFAULTS[role];
  const named = input.providerId !== undefined || input.model !== undefined;
  const providerId = input.providerId ?? fallback.providerId;
  return {
    role,
    providerId,
    model: input.model ?? (input.providerId === undefined ? fallback.model : providerId === "codex" ? CODEX_MODEL : undefined),
    reasoningLevel: input.reasoningLevel,
    named,
  };
}
