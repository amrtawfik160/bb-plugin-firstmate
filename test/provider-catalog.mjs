// The provider catalog a fake BB host answers with: the providers and model ids this
// host's `bb provider models` lists. Dispatch refuses a model it cannot check against a
// catalog, so every fake host that dispatches stubs one. No providerId reads the default,
// claude-code. A test that needs another
// catalog stubs providers.list or providers.models again; the later stub wins.
export const PROVIDER_CATALOG = {
  'claude-code': ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
  'acp-grok': ['grok-4.7', 'grok-4.6'],
  'acp-cursor': ['default', 'grok-4.6', 'claude-opus-5'],
  'acp-antigravity': ['gemini-3.8-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6'],
};

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id }));

export function stubProviderCatalog(host) {
  host.harness.sdk.stub('providers.list', async () => Object.keys(PROVIDER_CATALOG).map((id) => ({ id, available: true, reasoningLevels: LEVELS })));
  host.harness.sdk.stub('providers.models', async ({ providerId } = {}) => ({ modelLoadError: null, models: (PROVIDER_CATALOG[providerId ?? 'claude-code'] ?? []).map((id) => ({ id, model: id })) }));
}
