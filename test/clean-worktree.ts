// A crew's worktree that the unsaved-work check (lib/finished-crew-retire.ts) reads as clean: the
// environment has a path, the check reports a completed clean read, and every other host command
// answers with no output and exit 0.
import type { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

export function cleanWorktree(host: ReturnType<typeof createFakePluginHost>, path = "/wt/crew"): void {
  host.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_1", status: "ready", isWorktree: true, path }));
  host.harness.sdk.stub("environments.diffFiles", async () => ({ files: [] }));
  const commands = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => { const id = `clean${++n}`; commands.set(id, args.start?.command ?? ""); return { id }; });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = commands.get(terminalId) ?? "";
    const stdout = command.includes("FM_UNSAVED") ? "FM_UNSAVED checked\n" : "";
    const out = command.includes("FM_HOST_CAPTURE_V1") ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: 0, stdout, stderr: "" }) : stdout;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:0\n`).toString("base64") }] };
  });
}
