import test from "node:test";
import assert from "node:assert/strict";
import { hostCanDrive, PROJECTS, projectBriefLines, projectForName, projectForRepo, repoOf, surfaceRefusal, unlistedRefusal } from "./projects.ts";

test("a PR's repository names its project, without case", () => {
  assert.equal(projectForRepo("AmrTawfik160/dr.woo")?.name, "Dr Woo");
  assert.equal(projectForRepo("Cyndra-AI/cyndra-saas")?.name, "Cyndra");
  assert.equal(projectForRepo("amrtawfik160/Safi")?.name, "Safi");
  assert.equal(projectForRepo("someone/else"), undefined);
  assert.equal(repoOf("https://github.com/amrtawfik160/dr.woo/pull/124"), "amrtawfik160/dr.woo");
});

test("a BB project name names its project: a listed name, or the same first word", () => {
  assert.equal(projectForName("woo-app")?.name, "Dr Woo");
  assert.equal(projectForName("Cyndra SaaS")?.name, "Cyndra");
  assert.equal(projectForName("🦷 Dr Woo")?.name, undefined);
  assert.equal(projectForName(null), undefined);
});

test("every project names a known surface, and the release rules match captain.md", () => {
  for (const project of PROJECTS.projects) assert.ok(Object.hasOwn(PROJECTS.surfaces, project.proofSurface), project.name);
  assert.equal(projectForName("Safi")?.release?.group, "Beta Testers");
  assert.equal(projectForName("Dr Woo")?.release?.group, "Externals");
  assert.equal(hostCanDrive("iphone"), false);
  assert.equal(hostCanDrive("web"), true);
});

test("proof from another surface, or with no surface named, is refused for a project with a rule", () => {
  const woo = projectForName("Dr Woo");
  assert.match(surfaceRefusal(woo, "web")!, /Dr Woo proof must come from the app on an iPhone or the iOS Simulator \(surface iphone\), not web/);
  assert.match(surfaceRefusal(woo, undefined)!, /name the surface you drove/);
  assert.equal(surfaceRefusal(woo, "iphone"), null);
  assert.equal(surfaceRefusal(undefined, undefined), null);
});

test("a Dr Woo brief tells the crew the owner proves the iPhone build and the release goes to Externals", () => {
  const lines = projectBriefLines(projectForName("woo-app")).join("\n");
  assert.match(lines, /Proof for Dr Woo comes from the app on an iPhone or the iOS Simulator \(surface iphone\)/);
  assert.match(lines, /This host cannot drive .*bb firstmate deliveries device-proof/);
  assert.match(lines, /"Externals" TestFlight public-link group/);
  assert.doesNotMatch(projectBriefLines(projectForName("Cyndra")).join("\n"), /device-proof|TestFlight/);
});

// Checker FF2-verdict-1, #144 finding 3: hazw80801/runants had open production PRs and no rule.
test("every production repo of the live captain has a rule, and an unlisted repo is refused at a production merge", () => {
  assert.equal(projectForRepo("HazW80801/runants")?.proofSurface, "web");
  assert.match(unlistedRefusal("someone/unlisted"), /no project in owner\/projects\.json lists someone\/unlisted, so its proof surface is unknown/);
});
