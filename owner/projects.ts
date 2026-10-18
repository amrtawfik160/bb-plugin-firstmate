// Owner layer (decisions Q5 and Q11, 17 Oct): the surface each project's proof must come
// from, the release read-back its app builds need, and its shared test servers. The table
// is owner/projects.json.
import { readFileSync } from "node:fs";

export type ProofSurface = "iphone" | "web" | "message";
export type SharedServer = { id: string; about: string; reset: string };
/**
 * One read-only check of what production runs (owner decision Q9, 18 Oct). `repos` limits it to PRs of
 * those repos; without it, it covers every repo of the project. Credentials come from `envFile` at run time.
 */
export type LiveCheck =
  | { kind: "plugin-reload"; plugin: string; repos?: readonly string[] }
  | { kind: "eas-update"; appId: string; channels: readonly string[]; envFile: string; repos?: readonly string[] }
  | { kind: "coolify-deploy"; envFile: string; baseUrlVar: string; appVar: string; tokenVar: string; repos?: readonly string[] }
  | { kind: "release-readback"; repos?: readonly string[] };
/** How a project goes live (owner decision Q2, 18 Oct). */
export type LiveRule = {
  definition: string;
  next: string;
  actor: string;
  checks: readonly LiveCheck[];
  /** Why no check proves some or all of its work yet. */
  missing?: string;
  /** Backend files whose change must be deployed too: a PR that touches `paths` needs a backend check to prove it. */
  backend?: { paths: readonly string[]; what: string; checks: readonly LiveCheck[]; missing: string; repos?: readonly string[] };
};
export type ProjectRule = {
  name: string;
  repos: readonly string[];
  bbProjects?: readonly string[];
  proofSurface: ProofSurface;
  release?: { kind: "testflight"; group: string };
  sharedServers?: readonly SharedServer[];
  live?: LiveRule;
};
export type ProjectTable = {
  surfaces: Readonly<Record<ProofSurface, string>>;
  hostCanDrive: readonly ProofSurface[];
  projects: readonly ProjectRule[];
};

export const PROJECTS: ProjectTable = JSON.parse(readFileSync(new URL("./projects.json", import.meta.url), "utf8"));
export const PROOF_SURFACES = ["iphone", "web", "message"] as const satisfies readonly ProofSurface[];

const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

/** The repository of a GitHub PR or repo link, as owner/repo. */
export function repoOf(url: string): string {
  return /github\.com\/([^/]+\/[^/#?]+)/i.exec(url)?.[1] ?? url.split("#")[0]!;
}

export function repoMatches(pattern: string, repo: string): boolean {
  return glob(pattern).test(repo);
}

export function projectForRepo(repo: string, table: ProjectTable = PROJECTS): ProjectRule | undefined {
  return table.projects.find((project) => project.repos.some((pattern) => glob(pattern).test(repo)));
}

/** A BB project name matches a listed name, or its first word matches the rule name's first word. */
export function projectForName(name: string | null | undefined, table: ProjectTable = PROJECTS): ProjectRule | undefined {
  const clean = name?.trim().toLowerCase() ?? "";
  if (clean === "") return undefined;
  const first = (text: string) => text.trim().split(/\s+/)[0]!.toLowerCase();
  return table.projects.find((project) => [project.name, ...(project.bbProjects ?? [])].some((known) => known.toLowerCase() === clean))
    ?? table.projects.find((project) => first(project.name) === first(clean));
}

export function surfaceWords(surface: ProofSurface, table: ProjectTable = PROJECTS): string {
  return table.surfaces[surface] ?? surface;
}

export function hostCanDrive(surface: ProofSurface, table: ProjectTable = PROJECTS): boolean {
  return table.hostCanDrive.includes(surface);
}

/**
 * Why a proof from `given` cannot stand for this project, or null when it can. A project
 * with no rule takes any surface.
 */
export function surfaceRefusal(project: ProjectRule | undefined, given: string | undefined, table: ProjectTable = PROJECTS): string | null {
  if (project === undefined) return null;
  const want = project.proofSurface;
  if (given === undefined || given.trim() === "") return `${project.name} proof must come from ${surfaceWords(want, table)} (surface ${want}); name the surface you drove.`;
  if (given.trim().toLowerCase() !== want) return `${project.name} proof must come from ${surfaceWords(want, table)} (surface ${want}), not ${given.trim()}. Proof from another surface does not count.`;
  return null;
}

/** The merge preview note for a repo no project lists: it keeps the old merge rules, and no surface is inferred. */
export function unlistedNote(repo: string): string {
  return `no proof rule for ${repo}: add one in owner/projects.json`;
}

/** The lines a ship crew's brief carries for its project: where its proof must come from, and its release read-back. */
export function projectBriefLines(project: ProjectRule | undefined, table: ProjectTable = PROJECTS): string[] {
  if (project === undefined) return [];
  const surface = project.proofSurface;
  const lines = [`### Proof surface (${project.name})`, `Proof for ${project.name} comes from ${surfaceWords(surface, table)} (surface ${surface}). Record verification with \`--surface ${surface}\`; proof from another surface is refused.`];
  if (!hostCanDrive(surface, table)) {
    lines.push(`This host cannot drive ${surfaceWords(surface, table)}. When the PR is open and its test build is out, send the owner the build and what to check: \`bb firstmate deliveries device-proof <owner/repo#n> --commit <head> --build <id> --link <TestFlight or OTA link> --check "<what to check>"\`. His Works tap is the proof record. Do not record verification yourself, and do not report the change proven before he taps Works.`);
  }
  if (project.release !== undefined) {
    lines.push(`Releases: every ${project.name} build goes to the "${project.release.group}" TestFlight public-link group. Read the build's groups back from App Store Connect or EAS and record what you read: \`bb firstmate deliveries release --task T<n> --build <id> --group "${project.release.group}" --source app-store-connect|eas --seen "<what it showed>" --commit <commit the build was built from>\` (or \`--built-at <build time it shows>\` when the commit is not shown). A read-back proves only the merges its build holds.`);
  }
  for (const server of project.sharedServers ?? []) {
    lines.push(`Shared test server ${server.id} (${server.about}) serves one crew at a time. Before you use it: \`bb firstmate lease acquire ${server.id}\`, and wait until it is yours. After: ${server.reset}, then \`bb firstmate lease release ${server.id} --reset "<what you did>"\`.`);
  }
  return lines;
}
