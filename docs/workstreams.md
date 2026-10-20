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
    existing?: boolean; // adopted before adopt with fold, from an already-running checkout; End does not remove it
    taskId?: string; // adopted task that owns this branch
    crewId?: string; // adopted builder that owns this branch
    base?: string; // the repository's PR base (its default branch, staging for RunAnts), read once at create or adopt; absent on older records means main
  }>;
  taskIds: string[];
  requestTaskIds?: string[]; // original task list of an adopt from before adopt with fold
  adoption?: { taskIds: string[]; repositories: string[]; bases?: Record<string, string> }; // adopt with fold: original task list, repositories, and each repository's base as the card named it
  leftTaskIds?: string[]; // tasks that left after a conflict that could not be merged safely
  replaces?: Array<{ url: string; repository: string; state: "open" | "closed" | "skipped"; note?: string }>; // PRs the workstream PR replaces
  jobs: Array<{
    id: string; // crew identity
    editing: boolean;
    payload: string; // internal saved dispatch JSON
    state: "queued" | "waiting-memory" | "starting" | "running" | "finished" | "folding" | "folded" | "failed" | "kept-unsaved" | "dropped";
    threadId: string | null;
    error?: string;
    taskId?: string;
    followUpOf?: string;
    title?: string;
    model?: string;
    note?: string;
    report?: string;
    files?: string[];
    failedAt?: number;
    environmentId?: string | null;
    path?: string;
    branch?: string;
    repos?: Array<{ repository: string; path: string; branch: string; environmentId?: string | null; hostId?: string }>;
    isolated?: boolean; // created-workstream editor in its own worktree; fold and cleanup rules apply only to these
    repository?: string; // the one repository the task changes
    baseBranch?: string; // a retry whose old worktree is gone starts from this retained branch
    supersededBy?: string; // a retry took over this failed crew's worktree
    fold?: { state: "merging" | "committed" | "rolling-back"; steps: Array<{ repository: string; before: string; target: string; after?: string; state: "pending" | "merged" | "rolled-back" }> }; // saved before any Git change
    foldedAt?: number;
    cleanup?: "pending" | "kept-unsaved" | "done"; // separate from the task's result
    shipped?: string; // Ship requestId that took this folded work
    adopted?: boolean; // an adopted crew's saved work (adopt with fold)
    sourceBranch?: string; // fold this pushed branch: the crew's worktree is gone or holds another repository
    repointedFrom?: string; // the repository the task was recorded under before the owner card moved it
    conflict?: FoldStep; // the adopted fold that conflicted, for its conflict crew
    resolver?: string; // the conflict crew merging this job's work
    resolves?: string; // on a conflict crew: the job whose work it merges
  }>;
  cardRevision?: number; // monotonic status-card revision, Firstmate-owned
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
    snapshot?: { jobs: string[]; taskIds: string[]; heads: Record<string, string> }; // created: folded work this Ship takes
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
| `workstreams.list` | `{threadId:string,includeEnded?:boolean}` | `{workstreams:Workstream[],trialProjectIds:string[]}` (every BB project) |
| `workstreams.create` | `{threadId:string,projectId:string,name:string,requestId:string,topic?:{chatId:string,topicId:number}}` | `{workstream:Workstream}` |
| `workstreams.adopt` | `{threadId:string,projectId:string,name:string,requestId:string,taskIds:string[],tasks?:Array<{taskId:string,repository?:string,branches?:string[]}>,replacesPrs?:string[]}` | `{workstream?:Workstream,card?:{askId:string,state:"open"\|"declined",text:string},warning?:string}` |
| `workstreams.bindTopic` | `{threadId:string,workstreamId:string,chatId:string,topicId:number,goneTopicId?:number,structuredRefusal?:boolean}` | `{workstream:Workstream,refused?:{reason:"workstream_has_topic"\|"topic_in_use",message:string}}` |
| `workstreams.ship` | `{threadId:string,workstreamId:string,requestId:string}` | `{workstream:Workstream}` |
| `workstreams.devLink` | `{threadId:string,workstreamId:string,realLogin?:boolean}` | `{workstream:Workstream,url:string}` |
| `workstreams.end` | `{threadId:string,workstreamId:string}` | `{workstream:Workstream}` |

`workstreams.devLink` refuses `supportsDevLink=false` before starting any service. Safi and Dr Woo have no dev link.

Invalid requests and failed creation, dev-link or End actions reject the RPC with an explanatory message. Ship returns its saved record, including running or blocked state. A rejected dev-link start or Ship can leave a saved starting or blocked record, which `list` returns.
Workstreams are allowed in every project (owner decision, 20 October); `trialProjectIds` keeps its name and lists every BB project ID.
Creation deduplicates globally by topic chatId plus topicId, and within one captain by requestId. Adopt deduplicates within one captain by requestId. Conflicting captain or project ownership is refused.
Adopt (with fold, owner decisions of 20 October) brings open tasks of one project into a new workstream. The first call reads where each task's work is and shows the owner one card that lists the tasks it groups, where each one's work comes from, any repository it moves to, and the PRs it replaces; it returns `card` and changes nothing. The owner's Approve on that card adopts it; a call with the same requestId after the Approve continues the request he approved and returns the workstream, and refuses any changed repositories, branches or replaced PRs, which need a new requestId and a new card. A call after any other answer returns the card as `declined`. Only the owner's own answer adopts. A task with no recorded project joins the requested project: its card line names that project, and the owner's Approve records it on the task. The card names the base the workstream branch starts from, each repository's default branch read once for the card; Approve starts from that base. Adopt refuses a task recorded under another project, a repository whose default branch cannot be read, a closed task, a task already in a workstream, a crew whose work cannot be found, and a replaced PR outside the workstream's repositories, before any card. A repeated requestId with a different name, project, task list, task repositories, branches or replaced PRs is refused.
An approved adopt provisions the workstream like Create: one workstream branch per repository, cut from that repository's PR base (its default branch on GitHub: staging for RunAnts), its worktree, and its dev-link port; a repository no BB project holds is cloned once beside the project's checkout, under `.firstmate-sources`. Each builder crew's work becomes an adopted job. A crew whose worktree holds the task's repository folds that worktree; a crew whose worktree is gone, or holds another repository, folds its pushed branch (its recorded branch, else its PR's head); `tasks[].branches` names the pushed branches instead, except that a named branch checked out in a crew's worktree of that repository still folds from that worktree, unsaved work included, and `tasks[].repository` moves a task recorded under the wrong repository (Reels tasks recorded under Cyndra SaaS). A running crew outside the task's repository is refused unless its branches are named.
An idle crew's work folds at once and a running crew's when it finishes, without the workstream report rule. A crew counts as finished only when it is idle and its background agents, commands and workflows have ended; a crew in an error waits until it is idle again, so what it commits while recovering is folded too. The same holds for every workstream crew, so a conflict crew whose turn ended keeps the workstream worktree while its background work runs. Before the fold, under the crew's lifecycle lock, its thread and worktree are read again: a crew that works again keeps a running job and nothing is saved or folded until it finishes, and a crew in another worktree waits. Then uncommitted work in its worktree becomes a backup commit on its own branch (`.lavish/` and `.tmp-*.md` scratch files stay uncommitted), and its commits are pushed to its `wip/<crew>-<branch>` branch; a worktree in a merge or rebase waits. A fold conflict goes to a new crew in the workstream worktree, which merges the commit, tests and commits, or aborts and writes `RESOLVE_UNSAFE` with the reason. While that crew, or any other crew editing in the workstream worktree, works there, folds, fold undos and Ship wait; crews in their own worktrees keep running. When the workstream branch then holds the commit, the task is folded; otherwise the task leaves the workstream (`leftTaskIds`) with its own worktree, branch and PR, and the owner gets one question. An adopted crew is never told about a conflict and its branch is never deleted. Once its work is folded, or its task is dropped, the task-worktree cleanup retires its old worktree under the rules for finished tasks, while the task stays open in the workstream. An adopted workstream has no topic until the Telegram connector makes a new one and binds it.

Telegram adds `telegram_workstream: <id>` to its trusted message envelope, beside `telegram_task`.
For a project with several repositories, dispatch also accepts optional `workstreamRepo: "owner/repo"` (`--workstream-repo`). It defaults to the first repository.
The captain passes `workstreamId` to `firstmate_dispatch` or `bb firstmate dispatch --workstream-id <id>`.
Envelope context provides a fallback only when dispatch names sourceRefs that identify one workstream, or the turn has one workstream.
A dispatch cannot mix workstreams or move an existing task between them.
The tasks RPC includes optional `workstreamId` on tasks. The board response includes optional `workstreams` before its task sections.

The captain tool is `firstmate_workstream`, with actions `list`, `propose`, `create`, `adopt`, `bindTopic`, `ship`, `devLink`, `end`, `view`, and `lookup`.
The CLI is `bb firstmate workstream list|propose|create|adopt|bind-topic|ship|dev-link|end|view|lookup`, with `--task <id>` repeated on adopt and on lookup; adopt also takes `--repo <task>=<owner/repo>`, `--branch <task>=<branch>` and `--replaces <pr-url>`, each repeatable, and bind-topic takes `--gone-topic-id <number>`.
The captain handles an accepted captain card by calling the same create action with the card's stable requestId.
When the owner asks for topics for current work, the captain calls `propose`, which groups the open tasks that no workstream holds by project, agrees the grouping and names with the owner, then calls adopt once per workstream.
`bindTopic` keeps a recorded topic and refuses another, unless `goneTopicId` names the recorded topic as gone: then the new topic replaces it and the old ID is cleared. It also refuses a topic another workstream holds. A refusal is an error with the message `Workstream already has a topic.` or `Topic already belongs to a workstream.`; with `structuredRefusal: true` it is a result instead, `refused: {reason, message}` with the same message, reason `workstream_has_topic` or `topic_in_use`, and the workstream as recorded. A Firstmate from before this field ignores it and refuses with the error.

Editing crews default to PR delivery; only Ship merges their work. Explicit delivery contracts remain explicit.
A project's `dev` in `owner/projects.json` is one command, or a list with one command per `repository`; the dev link runs the command for its workstream's repository, else one that names no repository. Cyndra dev startup installs from the frozen lockfile, loads the source checkout's `.env.local` at runtime, and waits for an HTTP response before returning the dev link. No config file is copied into the workstream.

Created workstreams start a new editing crew for each task, in its own BB-managed worktree cut from the workstream branch. A task changes one repository, the one its dispatch names (`workstreamRepo`, default the first); BB can create a managed worktree only for that repository, so the crew gets no other checkout, and its brief names that repository and branch. Checkers and scouts stay read-only and run in the workstream worktree; only an environment whose path is the workstream worktree is registered as the workstream environment. While free memory is below 3 GB, new crews wait (`waiting-memory`) and the drain retries them.

When a created crew is idle and its own tests passed, Firstmate folds it into the workstream branch in the workstream worktree. A fold waits until the task's checkout is recorded. Each repository's original head and task commit are saved before any Git change; after a restart a fold that verifiably landed everywhere completes, and any other is undone. The merge is built without touching files and the worktree only fast-forwards, so dev-server writes stay: when Git cannot take the fold safely (staged changes, or a local change in a file the fold changes) the job waits with a note and is retried, and the crew is not told. An undo uses `git reset --keep`; when a local change blocks it, the job stays `folding` and later folds and Ship wait. A real conflict is undone and then the same crew is told to update from the workstream branch, fix, retest, and report again. Folds wait while a Ship is checking or merging, then run.

Ship saves a snapshot when it starts: the folded jobs not shipped before, their tasks, and each repository's head. It pushes that head and uses only the snapshot for the builder, PR links, approval, checker and the live check; running tasks fold later and go out with the next Ship. It merges the workstream PR itself, on the workstream repository's host and bound to that head (`gh pr merge --match-head-commit`), after the same verification, checker, owner-approval and check gates; the folded builder only supplies provenance and the checker-model rule, and a task crew's own PR never lands in its place. The workstream PR targets the repository's PR base, and Ship takes that base back into the branch after the merge. Right after the workstream PR is opened or found, each PR in `replaces` whose commits are all in the pushed head is closed with a comment that links the workstream PR; a PR with any commit outside it stays open with a note and is checked again at the next Ship, and a merged or closed PR is left alone. When a branch the adopt card named has no crew record, the latest folded job of the repository that has one supplies the builder. A workstream adopted before adopt with fold still merges each crew's PR through that crew.

A landed fold makes the job `folded` at once and restarts a running dev link if package, lock, vite/next/tsconfig, or `.env*` files changed. Cleanup is separate (`cleanup`): unsaved work keeps the worktree (`kept-unsaved`) and is checked again each pass. Before an archive Firstmate takes the crew's lifecycle lock and keeps the crew while it or its captain is in a turn, it runs background work, it has child or lifecycle-dependent threads (BB archives those too), another live thread shares its worktree, or another open task or crew still uses it. It runs the unsaved-work check, reads every fact again, and only then archives the crew threads; BB then removes the worktree. BB's archive has no idle check and keeps a running turn for a 30-second grace, so Firstmate reads the thread and its worktree again right after the archive: when a turn or background work started, the archive failed, or BB archived other threads with it, Firstmate undoes the archive within that grace, logs it once, and keeps the worktree. The deadline starts before the archive request, 10 seconds stay reserved for the undo, each read-back is bounded by what is left, and a read that already shows work undoes at once. While such an archive runs, every thread-archived event waits; afterwards an event applies its effects (delivery owner lost, delegated messages handed back) only if the thread is still archived, once per archive, so a late event for an undone archive, also after a reload, changes nothing. A kept crew or a failed archive leaves cleanup `pending` for the next pass. After a fold the task branch is deleted. An open PR on that branch is first closed with a note ("Folded into workstream <name>; its commits ship in the workstream PR <link, or when it is opened>") and its delivery ends with that reason, with no owner decision, only when the workstream branch holds every commit of it; otherwise the branch and the PR stay and the task's note says why. A PR of a folded task that is read as closed gets the same end under the same rule; one with a commit outside the workstream branch stays `closed-needs-disposition`. A failed crew is not folded; its worktree is kept 7 days, then archived with its branch kept. A dropped task archives at once, branch kept. A retry (`taskRef` on a failed task) continues in the kept worktree and takes over its expiry; once that worktree is gone it starts a new worktree from the retained branch.

Workstreams adopted before adopt with fold keep one editing crew at a time and reuse existing worktrees. Ship waits for every editing crew attached to the adopted tasks, not only workstream jobs. While one is active, Ship stays queued and tells the owner once, then runs the checker, approval and merge loop.

`view` is one line per task (number, short title, model, state), from the latest job of each task. `lookup` returns at most about 15 lines (brief, last crew report, changed files). Owner messages stay in full. Firstmate calls the connector RPC `workstreamCard` on every task state change with a monotonic revision; a missing RPC is logged once and ignored. The card lists a crew once its owner task (`T<n>`) is attached, and is sent again at that moment. The card maps a finished editing job to `folding` until the fold lands, and a finished scout to `folded`. Final results use the existing `reply` RPC kind `final`. A follow-up to a running crew is `firstmate_tell`. A follow-up to a folded task (`taskRef`) starts a new crew from the latest workstream branch; its brief is the earlier task, its last report, and the new instruction, linked to the earlier crew. `firstmate_dispatch` and `bb firstmate dispatch --workstream-id <id> [--task-ref T<n>]` attach the owner task to the job the same way, which sends the status card again. The card shows the latest job of each task once. Firstmate decides new task vs follow-up by judgement; a direct reply to a crew message is always a follow-up.
Every repo keeps its worktree and branch across Ship actions. Ship resolves the builder, task and PR from that entry. An adopted entry without that task and builder is refused before any PR write; Ship does not pick another builder or attach the PR to every task. Processing one branch does not change another crew's PR or task. Each Ship uses a PR for that branch, checks it independently through Firstmate's existing checker path, and takes main into the branch after merge. A local Git reference records the last shipped head, so retained squash-merge ancestry does not count as unshipped work.
Dev links use dedicated `fm-workstream-*.service` units, track actual HTTP requests through a loopback proxy, stop after two hours without requests, and evict the least recently requested link when a fourth starts.
The `fm-f5f15031-vite*.service` units are never managed by this feature.
End refuses any task outside Live or Dropped, active crews, dirty files, unpushed commits, or relevant stashes. The topic stays; `closeTopicRequested` stays false (a private chat cannot close or reopen a topic). Before End removes the workstream worktree, every live thread in its environment must be a crew of this workstream that the task-crew archive rules let go; another thread there (an owner's own thread, say) keeps it and End is refused. End archives those crew threads one by one with the same read-back and undo, never the whole environment at once. Scouts, adopted editors and editors saved before task worktrees run in the workstream worktree, one editor at a time, and close when finished, as before.

Workstream crews keep a saved report directory, separate from native-worker lifecycle detection. The brief names its `report.md` path. It uses the captain's data directory when available; otherwise reports live beside the source checkout under `.firstmate-workstream-reports/<workstream>/<crew>/`, outside the shared worktree. Verification reads that report only; chat and `final-report.md` cannot replace its surface proof. Reports do not make workstream crews native teardown candidates.
