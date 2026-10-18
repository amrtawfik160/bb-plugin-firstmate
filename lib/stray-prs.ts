import { projectForRepo, type ProjectTable } from "../owner/projects.ts";
import { isOpenTask, linkedPrs, type OwnerTask } from "./owner-tasks.ts";
import { canonicalPr, type DeliveryRecord } from "./pr-delivery.ts";

/** One open PR from the hourly GitHub search of the owner's open PRs. */
export type StrayPr = { id: string; repo: string; number: number; url: string; title: string; openedAt: number | null; touchedAt: number | null; draft: boolean };

/** The search answer, one JSON object per line (url, title, createdAt, updatedAt, draft); a line that is not a PR is skipped. */
export function parseSearchRows(output: string): StrayPr[] {
  const rows: StrayPr[] = [];
  for (const line of output.split("\n")) {
    let item: Record<string, unknown>;
    try { item = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof item["url"] !== "string") continue;
    let pr: ReturnType<typeof canonicalPr>;
    try { pr = canonicalPr(item["url"]); } catch { continue; }
    const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
    rows.push({ id: pr.id, repo: pr.repository, number: pr.number, url: pr.url, title: typeof item["title"] === "string" ? item["title"].trim().slice(0, 300) : "",
      openedAt: time(item["createdAt"]), touchedAt: time(item["updatedAt"]), draft: item["draft"] === true });
  }
  return rows;
}

/**
 * Owner decision Q3: records are the only truth. An open PR that no open task links (by its id, or through
 * the delivery record of one of the task's crews) is adopted into a task; a PR held only by a closed task
 * still needs a next step, so it is adopted too. A PR in a repo no project lists is not adopted: its repo
 * is listed for the repair thread instead.
 */
export function strayPrs(rows: readonly StrayPr[], tasks: readonly OwnerTask[], records: readonly DeliveryRecord[], table: ProjectTable): { adopt: Array<{ pr: StrayPr; project: string }>; unlisted: string[] } {
  const held = new Set<string>();
  for (const task of tasks.filter(isOpenTask)) {
    for (const pr of task.prs) held.add(pr.toLowerCase());
    for (const record of linkedPrs(task, records)) held.add(record.id);
  }
  const adopt: Array<{ pr: StrayPr; project: string }> = [];
  const unlisted = new Set<string>();
  for (const pr of rows) {
    if (held.has(pr.id)) continue;
    const project = projectForRepo(pr.repo, table);
    if (project === undefined) unlisted.add(pr.repo);
    else adopt.push({ pr, project: project.name });
  }
  return { adopt, unlisted: [...unlisted].sort() };
}
