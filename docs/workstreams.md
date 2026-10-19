# Workstreams

Contract for Firstmate and the Telegram connector, approved through the repair thread on 18 October 2026.
RPC method names below include the literal `workstreams.` prefix. Call plugin `firstmate`.
All actions require `threadId` to be a Firstmate captain. Records are scoped to that captain.

```typescript
type Workstream = {
  id: string;
  name: string;
  projectId: string;
  threadId: string; // owning captain
  requestId: string; // create or adopt dedupe key
  state: "open" | "ended";
  supportsDevLink: boolean; // project config declares a web app
  provisioned: boolean;
  topic?: { chatId: string; topicId: number }; // absent before binding, never null
  repos: Array<{
    repository: string; // owner/repo
    projectId: string;
    hostId: string;
    sourcePath: string;
    path: string;
    branch: string;
    environmentId: string | null; // null until first crew registers the worktree with BB
    existing?: boolean; // adopted from an already-running checkout; End does not remove it
    taskId?: string; // adopted task that owns this branch
    crewId?: string; // adopted builder that owns this branch
  }>;
  taskIds: string[];
  requestTaskIds?: string[]; // original adopt task list; a retry must match name, project and this list
  jobs: Array<{
    id: string; // crew identity
    editing: boolean;
    payload: string; // internal saved dispatch JSON
    state: "queued" | "starting" | "running" | "finished";
    threadId: string | null;
    error?: string;
  }>;
  devLink: {
    state: "stopped" | "starting" | "running";
    port: number;
    url?: string; // absent before first start; retained when stopped
    lastRequestedAt?: number; // epoch milliseconds; absent before first request
    realLogin: boolean;
  };
  closeTopicRequested: boolean; // Telegram closes topic when true; repeated closure is safe
  ship: {
    state: "idle" | "queued" | "running" | "blocked" | "complete";
    requestId?: string;
    error?: string; // blocker, or pending checker/live-check explanation
  };
  lastStallAt?: number; // epoch milliseconds of the last accepted unshipped alert
  cleanupApproved?: boolean; // all-repo safety read completed before cleanup
  createdAt: number; // epoch milliseconds
  updatedAt: number; // epoch milliseconds
};
```

Optional fields are omitted, never null. Only `environmentId` and a job's `threadId` can be null.
Clients should read only fields they use. Firstmate may add optional record fields.
`ship.state=complete` means every included task is Live or Dropped. Live still requires the project's live check or the existing evidence path.
A pending Ship runs its independent checker and project live path through the existing crew and live-check records. A blocked Ship keeps its requestId. Retry that requestId after the stated blocker clears.

| RPC method | Request | Response |
| --- | --- | --- |
| `workstreams.list` | `{threadId:string,includeEnded?:boolean}` | `{workstreams:Workstream[],trialProjectIds:string[]}` |
| `workstreams.create` | `{threadId:string,projectId:string,name:string,requestId:string,topic?:{chatId:string,topicId:number}}` | `{workstream:Workstream}` |
| `workstreams.adopt` | `{threadId:string,projectId:string,name:string,requestId:string,taskIds:string[]}` | `{workstream:Workstream}` |
| `workstreams.bindTopic` | `{threadId:string,workstreamId:string,chatId:string,topicId:number}` | `{workstream:Workstream}` |
| `workstreams.ship` | `{threadId:string,workstreamId:string,requestId:string}` | `{workstream:Workstream}` |
| `workstreams.devLink` | `{threadId:string,workstreamId:string,realLogin?:boolean}` | `{workstream:Workstream,url:string}` |
| `workstreams.end` | `{threadId:string,workstreamId:string}` | `{workstream:Workstream}` |

`workstreams.devLink` refuses `supportsDevLink=false` before starting any service. Safi and Dr Woo have no dev link.

Invalid requests and failed creation, dev-link or End actions reject the RPC with an explanatory message. Ship returns its saved record, including running or blocked state. A rejected dev-link start or Ship can leave a saved starting or blocked record, which `list` returns.
Trial project names are configured in Firstmate; `trialProjectIds` resolves those names to BB project IDs. Initial trial is Cyndra only.
`create` refuses projects outside the trial. Existing records remain readable when the trial setting changes.
Creation deduplicates globally by topic chatId plus topicId, and within one captain by requestId. Adopt deduplicates within one captain by requestId. Conflicting captain or project ownership is refused.
Adopt groups existing open tasks of that project into a workstream and its Telegram topic without provisioning worktrees. Running crews keep their worktrees, branches, PRs and dev links. It refuses a task of another project, a closed task, or a task already in a workstream; nothing is created on a refusal. An adopted record is `provisioned` and records each attached crew's worktree, branch and host from that crew's thread environment, with that task and builder on the entry. A deleted, unreadable, or environment-less crew thread, or an incomplete thread environment, refuses the whole task list with the task, thread and reason, and creates nothing. Adopt never records the project source checkout, env_main or main. End does not remove those worktrees. A repeated requestId with a different name, project or task list is refused.

Telegram adds `telegram_workstream: <id>` to its trusted message envelope, beside `telegram_task`.
For a project with several repositories, dispatch also accepts optional `workstreamRepo: "owner/repo"` (`--workstream-repo`). It defaults to the first repository.
The captain passes `workstreamId` to `firstmate_dispatch` or `bb firstmate dispatch --workstream-id <id>`.
Envelope context provides a fallback only when dispatch names sourceRefs that identify one workstream, or the turn has one workstream.
A dispatch cannot mix workstreams or move an existing task between them.
The tasks RPC includes optional `workstreamId` on tasks. The board response includes optional `workstreams` before its task sections.

The captain tool is `firstmate_workstream`, with actions `list`, `create`, `adopt`, `bindTopic`, `ship`, `devLink`, and `end`.
The CLI is `bb firstmate workstream list|create|adopt|bind-topic|ship|dev-link|end`, with `--task <id>` repeated on adopt.
The captain handles an accepted captain card by calling the same create action with the card's stable requestId.
When the owner asks for topics for current work, the captain proposes the grouping in one `firstmate_ask` card (kind question), then adopt after the answer.

Editing crews default to PR delivery; only Ship merges their work. Explicit delivery contracts remain explicit.
Cyndra dev startup installs from the frozen lockfile, loads the source checkout's `.env.local` at runtime, and waits for an HTTP response before returning the dev link. No config file is copied into the workstream.

One editing crew runs per workstream. Checkers and scouts are read-only. Ship waits for every editing crew attached to the adopted tasks, not only workstream jobs. While one is active, Ship stays queued and tells the owner once, then runs the checker, approval and merge loop.
Every repo keeps its worktree and branch across Ship actions. Ship resolves the builder, task and PR from that entry. Processing one branch does not change another crew's PR or task. Each Ship uses a PR for that branch, checks it independently through Firstmate's existing checker path, and takes main into the branch after merge. A local Git reference records the last shipped head, so retained squash-merge ancestry does not count as unshipped work.
Dev links use dedicated `fm-workstream-*.service` units, track actual HTTP requests through a loopback proxy, stop after two hours without requests, and evict the least recently requested link when a fourth starts.
The `fm-f5f15031-vite*.service` units are never managed by this feature.
End refuses any task outside Live or Dropped, active crews, dirty files, unpushed commits, or relevant stashes. The topic stays; `closeTopicRequested` stays false (a private chat cannot close or reopen a topic).

Workstream crews keep a saved report directory, separate from native-worker lifecycle detection. The brief names its `report.md` path. It uses the captain's data directory when available; otherwise reports live beside the source checkout under `.firstmate-workstream-reports/<workstream>/<crew>/`, outside the shared worktree. Verification reads that report only; chat and `final-report.md` cannot replace its surface proof. Reports do not make workstream crews native teardown candidates.
