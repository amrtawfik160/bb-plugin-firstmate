/** Binding is a prerequisite, not evidence that the harness acquired the native
 * lock or completed its digest. Keep the RPC path separate from that shell step. */
export async function boundedCaptainStartup<T>(
  parents: AbortSignal[],
  action: (signal: AbortSignal, stage: (name: string) => void) => Promise<T>,
  budgetMs = 60_000,
): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([...parents, deadline.signal]);
  let stage = "binding";
  const timer = setTimeout(() => deadline.abort(
    new Error(`Captain setup exceeded ${budgetMs / 1000}s during ${stage}`),
  ), budgetMs);
  let remove = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Captain setup cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    remove = () => signal.removeEventListener("abort", abort);
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([
      action(signal, name => { signal.throwIfAborted(); stage = name; }),
      cancelled,
    ]);
  } catch (error) {
    throw new Error(`Captain is not ready (${stage}): ${error instanceof Error ? error.message : String(error)}. Inspect this prerequisite before retry; no native session startup was attempted by deck.`);
  } finally {
    clearTimeout(timer);
    remove();
  }
}

export function captainBindingText(input: {
  home: string;
  host: string;
  command: string;
  setup: string;
  digest?: string;
}) {
  if (!input.home) return [
    "Captain registered in BB compatibility mode; native home is unavailable (ready=false).",
    input.setup,
    "No native startup command is available until bb firstmate init --real configures a native home.",
    input.digest,
  ].filter(Boolean).join("\n\n");
  return [
    "Captain home bound; native startup readiness is unverified by deck (ready=false).",
    `Native home: ${input.home}\nHost: ${input.host}`,
    input.setup,
    "Read the complete contract: firstmate_contract or bb firstmate contract.",
    "If the complete native startup digest is absent, run this exact command once through the agent shell to retain native harness ancestry:",
    input.command,
    "Ready only after the complete native digest and lock/prerequisite checks succeed; a truncated, refused or failed startup is unresolved. Diagnose its named stage before retry.",
    input.digest ?? "Fleet digest deferred to native startup; no fleet inventory was scanned by deck.",
  ].join("\n\n");
}
