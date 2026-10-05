// Host terminals are PTYs. Structured commands must see pipes instead, and their
// stderr must not become part of the JSON consumed by the caller. The envelope
// crosses the existing terminal transport; it does not change its cancellation
// or terminal cleanup ownership.
const protocol = "FM_HOST_CAPTURE_V1";
const capture = `import json, subprocess, sys
result = subprocess.run(["bash", "--noprofile", "--norc", "-c", sys.argv[1]], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
print(json.dumps({"protocol": "${protocol}", "exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}))`;

function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function captureHostCommand(command: string): string {
  return `python3 -c ${quote(capture)} ${quote(command)}`;
}

export function decodeHostCapture(output: string): { exitCode: number; output: string; stderr: string } {
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid host capture envelope.");
  const record = value as Record<string, unknown>;
  if (record.protocol !== protocol || !Number.isInteger(record.exitCode) || typeof record.stdout !== "string" || typeof record.stderr !== "string") {
    throw new Error("Invalid host capture envelope.");
  }
  return { exitCode: record.exitCode as number, output: record.stdout, stderr: record.stderr };
}
