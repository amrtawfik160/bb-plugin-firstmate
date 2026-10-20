import test from "node:test";
import assert from "node:assert/strict";
import { devCommandFor, devCommands, hostCanDrive, PROJECTS, projectBriefLines, projectForName, projectForRepo, repoOf, surfaceRefusal, unlistedNote } from "./projects.ts";

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
test("runants has a web rule; an unlisted repo gets a note naming the missing rule, never an inferred surface", () => {
  assert.equal(projectForRepo("HazW80801/runants")?.proofSurface, "web");
  assert.equal(projectForRepo("amrtawfik160/framed"), undefined);
  assert.equal(unlistedNote("amrtawfik160/framed"), "no proof rule for amrtawfik160/framed: add one in owner/projects.json");
});

// Owner decision Q2 (18 Oct): each project says how it goes live and names the check that proves it.
test("every project has a live rule: a check that proves it, or the reason none exists", () => {
  for (const project of PROJECTS.projects) {
    const live = project.live;
    assert.ok(live, `${project.name} has no live rule`);
    assert.ok(live.definition && live.next && live.actor, project.name);
    assert.ok(live.checks.length > 0 || (live.missing ?? "") !== "", `${project.name}: no check and no reason`);
  }
  assert.deepEqual(projectForName("Safi")!.live!.checks.map((c) => c.kind === "eas-update" ? c.channels : c.kind), [["production", "preview"]]);
  assert.deepEqual(projectForName("Dr Woo")!.live!.checks.map((c) => c.kind), ["release-readback", "eas-update"]);
  assert.deepEqual(projectForName("Cyndra")!.live!.checks, []);
  assert.deepEqual(projectForName("Areliaa")!.live!.checks.map((c) => c.kind), ["coolify-deploy"]);
  assert.deepEqual(projectForName("Parknwash")!.live!.checks.map((c) => c.repos), [["xtawfik/parknwash-api"], ["xtawfik/parknwash-webapp"]]);
  assert.deepEqual(projectForName("bb-plugin-firstmate")!.live!.checks.map((c) => c.kind === "plugin-reload" ? c.plugin : c.kind), ["firstmate", "telegram"]);
  for (const project of PROJECTS.projects) for (const check of project.live!.checks) {
    if ("envFile" in check) assert.match(check.envFile, /^\/root\/\.bb-server\/secrets\/[\w.-]+\.env$/, "credentials only from the host's secrets folder");
  }
});

test("a project may name one dev command per repository; a workstream gets the one for its repository", () => {
  const both = { dev: [
    { repository: "cyndra-ai/cyndra-saas", command: "vite --port {port}" },
    { repository: "amrtawfik160/reels-app", command: "npm run dev" },
  ] };
  assert.deepEqual(devCommandFor(both, ["amrtawfik160/reels-app"]), { command: both.dev[1], repository: "amrtawfik160/reels-app" });
  assert.deepEqual(devCommandFor(both, ["Cyndra-AI/cyndra-saas"]), { command: both.dev[0], repository: "Cyndra-AI/cyndra-saas" });
  assert.equal(devCommandFor(both, ["other/repo"]), undefined);
  // The older single entry still works: with a repository it serves only that one, without one it serves any.
  const single = { dev: { repository: "cyndra-ai/cyndra-saas", command: "vite" } };
  assert.deepEqual(devCommands(single), [single.dev]);
  assert.equal(devCommandFor(single, ["amrtawfik160/reels-app"]), undefined);
  assert.deepEqual(devCommandFor({ dev: { command: "vite" } }, ["x/y"]), { command: { command: "vite" }, repository: "x/y" });
  assert.deepEqual(devCommands({}), []);
  assert.equal(devCommandFor(projectForName("Cyndra"), ["cyndra-ai/cyndra-saas"])?.repository, "cyndra-ai/cyndra-saas");
});
