import assert from "node:assert/strict";
import test from "node:test";
import type { OwnerTask } from "./owner-tasks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";
import { parseSearchRows, strayPrs } from "./stray-prs.ts";
import { PROJECTS } from "../owner/projects.ts";

const row = (repo: string, number: number, title = `PR ${number}`) => JSON.stringify({ url: `https://github.com/${repo}/pull/${number}`, title, createdAt: "2026-10-10T10:00:00Z", updatedAt: "2026-10-12T10:00:00Z", draft: false });

const task = (over: Partial<OwnerTask>): OwnerTask => ({
  id: "T1", captain: "thr_cap", project: "Safi", title: "x", sourceRefs: [], state: "working", prs: [], crewIds: [], backfilled: false, createdAt: 0, updatedAt: 0, ...over,
});

test("the search answer reads as open PRs; a line that is not a PR is skipped", () => {
  const rows = parseSearchRows([row("amrtawfik160/Safi", 12, "Legend dashes"), "not json", JSON.stringify({ url: "https://github.com/a/b/issues/3" })].join("\n"));
  assert.deepEqual(rows, [{ id: "amrtawfik160/safi#12", repo: "amrtawfik160/safi", number: 12, url: "https://github.com/amrtawfik160/safi/pull/12", title: "Legend dashes", openedAt: Date.parse("2026-10-10T10:00:00Z"), touchedAt: Date.parse("2026-10-12T10:00:00Z"), draft: false }]);
});

test("an open PR no open task links is adopted; a PR an open task holds, by id or by its crew, is not; an unlisted repo is listed", () => {
  const rows = parseSearchRows([
    row("amrtawfik160/safi", 1), row("amrtawfik160/safi", 2), row("amrtawfik160/safi", 3), row("amrtawfik160/safi", 4),
    row("cyndra-ai/cyndra-saas", 2600), row("someone/side-project", 9), row("someone/side-project", 10),
  ].join("\n"));
  const tasks = [
    task({ id: "T1", prs: ["amrtawfik160/safi#1"] }),
    task({ id: "T2", crewIds: ["crew-b"] }),
    // A closed task does not hold its open PR: the PR still needs a next step.
    task({ id: "T3", state: "done", prs: ["amrtawfik160/safi#3"] }),
  ];
  const records = [{ id: "amrtawfik160/safi#2", taskId: "crew-b" } as DeliveryRecord];
  const found = strayPrs(rows, tasks, records, PROJECTS);
  assert.deepEqual(found.adopt.map((item) => [item.pr.id, item.project]), [
    ["amrtawfik160/safi#3", "Safi"], ["amrtawfik160/safi#4", "Safi"], ["cyndra-ai/cyndra-saas#2600", "Cyndra"],
  ]);
  assert.deepEqual(found.unlisted, ["someone/side-project"]);
});
