// 20 Oct: BB's catalog for acp-antigravity listed gemini-4-argon, but the agy CLI on the host refused it
// ("invalid model selection (--model "gemini-4-argon-high" --effort "")"), and crews 9ade6f3a, 43864fce and
// hermes-split-step3-1020 died at their first turn. BB's catalog for that provider comes from a host bridge
// with its own model table, so the CLI's own list is the one that decides.

/** The command that lists the models a provider's own CLI accepts on its host, or null when it has none to read. */
export function providerModelsCommand(providerId: string | null | undefined): { command: string; label: string } | null {
  if (providerId === "acp-antigravity") return { command: "agy models", label: "Antigravity CLI" };
  return null;
}

/** Model ids from a CLI list: one model per line, its id first, then a tab or " - " and its name. */
export function parseCliModels(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const id = /^\s*([A-Za-z0-9][\w.:/-]*)(?:\t| - )/.exec(line)?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// The CLI lists one id per effort (gemini-3.8-flash-high) where BB lists the model once (gemini-3.8-flash).
const EFFORT_SUFFIX = /^-(?:minimal|low|medium|high|xhigh|max)$/;

/** Whether the CLI accepts a catalog model: listed as it is, or once per effort. */
export function cliAcceptsModel(model: string, cliModels: readonly string[]): boolean {
  return cliModels.some((id) => id === model || (id.startsWith(model) && EFFORT_SUFFIX.test(id.slice(model.length))));
}

/** The catalog models the CLI accepts, in catalog order. */
export function acceptedCatalogModels(catalog: readonly string[], cliModels: readonly string[]): string[] {
  return catalog.filter((model) => cliAcceptsModel(model, cliModels));
}
