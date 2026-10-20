// Adopt fixtures for server tests on a fake BB host.
//
// legacyAdopt seeds the record an adopt made before adopt with fold (20 Oct; test/legacy-workstream.mjs),
// reading each task's existing worktree from its crew's thread as that adopt did.
//
// approveAdopt runs today's adopt: the owner card first, then the owner's Approve.
import assert from 'node:assert/strict';
import { createOwnerTasks } from '../lib/owner-tasks.ts';
import { seedLegacyWorkstream } from './legacy-workstream.mjs';

const repoOf = (url) => /github\.com\/([^/]+\/[^/#?]+)/i.exec(url)?.[1];

export async function legacyAdopt(host, input, fallbackRepository = 'cyndra-ai/cyndra-saas') {
  const db = host.bb.storage.database();
  const tasks = createOwnerTasks(db);
  const crews = (await host.bb.storage.kv.get('crews')) ?? [];
  const repos = [];
  for (const taskId of input.taskIds) {
    const task = tasks.get(taskId);
    for (const crewId of task?.crewIds ?? []) {
      const crew = crews.find((c) => c.id === crewId);
      if (!crew) continue;
      const thread = await host.bb.sdk.threads.get({ threadId: crew.threadId });
      const env = await host.bb.sdk.environments.get({ environmentId: thread.environmentId });
      const repository = (crew.prUrl && repoOf(crew.prUrl)) || (task.prs[0] && repoOf(task.prs[0])) || fallbackRepository;
      if (repos.some((r) => r.repository.toLowerCase() === repository.toLowerCase() && r.path === env.path)) continue;
      repos.push({ repository, projectId: input.projectId, hostId: env.hostId, path: env.path, sourcePath: env.path, branch: env.branchName, environmentId: env.id, existing: true, taskId, crewId });
    }
  }
  return { workstream: seedLegacyWorkstream(db, { ...input, repos }) };
}

/**
 * Host commands answer as a clean checkout of `origin` whose default branch is `base`; nothing else is read.
 * `origin` may also map a checkout path to its remote.
 */
export function stubHostGit(host, { origin = 'https://github.com/cyndra-ai/cyndra-saas.git', base = 'main', commands = [] } = {}) {
  host.harness.sdk.stub('hosts.exec', async ({ command }) => {
    commands.push(command);
    if (command.includes('remote get-url origin')) {
      if (typeof origin === 'string') return { exitCode: 0, stdout: origin };
      const path = Object.keys(origin).find((p) => command.includes(`'${p}'`));
      return { exitCode: 0, stdout: path ? origin[path] : '' };
    }
    if (command.includes('ls-remote --symref')) return { exitCode: 0, stdout: `ref: refs/heads/${base}\tHEAD\n` };
    return { exitCode: 0, stdout: '' };
  });
  return commands;
}

/** Today's adopt: the card, then the owner's Approve. Returns the adopted workstream. */
export async function approveAdopt(host, input) {
  const first = await host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', ...input });
  if (first.workstream) return first;
  assert.ok(first.card, 'adopt shows the owner card first');
  const resolved = await host.harness.behavior.callRpc('resolveAsk', { threadId: 'cap', id: first.card.askId, resolution: 'Approve' });
  assert.equal(resolved.ok, true);
  const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' });
  const workstream = listed.workstreams.find((w) => w.requestId === input.requestId);
  assert.ok(workstream, `the approved card adopts ${input.name}`);
  return { workstream, card: first.card };
}
