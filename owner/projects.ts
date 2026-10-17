// Owner layer (decisions Q5 and Q11, 17 Oct): the surface each project's proof must come
// from, the release read-back its app builds need, and its shared test servers. The table
// is owner/projects.json.
import { readFileSync } from "node:fs";

export type ProofSurface = "iphone" | "web" | "message";
export type SharedServer = { id: string; about: string; reset: string };
export type ProjectRule = {
  name: string;
  repos: readonly string[];
  bbProjects?: readonly string[];
  proofSurface: ProofSurface;
  release?: { kind: "testflight"; group: string };
  sharedServers?: readonly SharedServer[];
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
