// Owner layer (decisions Q10, Q11): the default execution of each crew role. A provider,
// model or effort the owner names in a message applies to that dispatch only.

export const CREW_ROLES = ["builder", "checker", "lookup"] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

export const ROLE_DEFAULTS: Readonly<Record<CrewRole, { providerId: string; model: string }>> = {
  builder: { providerId: "claude-code", model: "claude-opus-5-5" },
  checker: { providerId: "codex", model: "gpt-6-astra" },
  lookup: { providerId: "claude-code", model: "claude-haiku-5-5" },
};

// A named provider without a model runs that provider's own default model. A named model
// without a provider keeps the role's provider; dispatch refuses it if that provider
// does not offer it.
export function crewExecution<L extends string>(input: { role?: CrewRole; providerId?: string; model?: string; reasoningLevel?: L }) {
  const role = input.role ?? "builder";
  const fallback = ROLE_DEFAULTS[role];
  const named = input.providerId !== undefined || input.model !== undefined;
  return {
    role,
    providerId: input.providerId ?? fallback.providerId,
    model: input.model ?? (input.providerId === undefined ? fallback.model : undefined),
    reasoningLevel: input.reasoningLevel,
    named,
  };
}
