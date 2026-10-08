import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as candidates from "../scripts/release/candidates.mjs";
import {
  changelogEntry, changelogStateMarker, commitLog, latestRelease, readChangelog,
  releaseHeading, releaseMarker, releaseNotes
} from "../scripts/release/changelog.mjs";
import { Repository } from "../scripts/release/git.mjs";
import { onlyVersionChanges, updateVersion, versionSnapshot } from "../scripts/release/versions.mjs";
import {
  fetchPublishedMain, fetchReleaseNotesRefs, fetchReleaseRefs, publicationPermissions
} from "../scripts/release/workflow.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function commit(repo, message) {
  repo.run(["commit", "--quiet", "-m", message]);
  return repo.sha("HEAD");
}

function fixture(t, devVersion = "0.0.3") {
  const root = mkdtempSync(join(tmpdir(), "release-smoke-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = childProcess.spawnSync("git", ["init", "--quiet", "--initial-branch=main", root], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const repo = new Repository(root);
  const put = (path, contents) => {
    const destination = join(root, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  };
  put(".gitignore", "dist/\n");
  for (const path of ["package.json", ".plugin/plugin.json", ".claude-plugin/plugin.json", "gemini-extension.json"]) {
    put(path, '{"version":"0.0.3"}\n');
  }
  put("package-lock.json", '{"version":"0.0.3","packages":{"":{"version":"0.0.3"}}}\n');
  for (const path of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    put(path, '{"plugins":[{"name":"aspire","version":"0.0.3"}]}\n');
  }
  put("skills/aspire/SKILL.md", '---\nname: aspire\nmetadata:\n  version: "0.0.3"\n---\nSkill.\n');
  put("CHANGELOG.md", "# Changelog\n");
  repo.run(["add", "--all"]);
  const historical = commit(repo, "Publish v0.0.3");
  put("CHANGELOG.md", [
    "# Changelog", "", releaseHeading("0.0.3"), "",
    `<!-- aspire-skills-changelog-done from=${historical} to=${historical} base=0.0.3 -->`,
    "", "- Historical release.", ""
  ].join("\n"));
  repo.run(["add", "--all"]);
  const base = commit(repo, "Record historical release metadata");
  repo.run(["update-ref", "refs/remotes/origin/main", base]);
  repo.run(["switch", "--create", "dev"]);
  repo.run(["rm", "--", "CHANGELOG.md"]);
  for (const path of versionSnapshot(repo, base).manifests.keys()) {
    const text = repo.read(base, path).toString("utf8").replaceAll("0.0.3", devVersion);
    put(path, text);
  }
  put("README.md", "Selected development feature.\n");
  repo.run(["add", "--all"]);
  const source = commit(repo, "Add selected development feature");
  repo.run(["update-ref", "refs/remotes/origin/dev", source]);
  return { repo, root, historical, base, source, options: { releaseVersion: "0.0.4" } };
}

function finalize(repo, candidate, notes = "- Improve the Aspire skills release.") {
  repo.run(["switch", "--detach", candidate]);
  const changelog = readChangelog(repo, candidate);
  const release = latestRelease(changelog);
  const entry = [
    releaseHeading(release.version), "", releaseMarker(release), "",
    changelogStateMarker(release, "finalized"), "", notes
  ].join("\n");
  writeFileSync(join(repo.root, "CHANGELOG.md"), changelog.replace(release.entry, entry));
  repo.run(["add", "--", "CHANGELOG.md"]);
  return commit(repo, "Generate reviewed release changelog");
}

function publish(repo, candidate) {
  repo.run(["switch", "main"]);
  repo.run(["merge", "--no-ff", "--no-edit", candidate]);
  const release = repo.sha("HEAD");
  repo.run(["update-ref", "refs/remotes/origin/main", release]);
  return release;
}

function inputs(result) {
  return {
    sourceCommit: result.source, baseCommit: result.base, releaseVersion: result.version,
    candidateCommit: result.candidate, previousCommit: result.previous
  };
}

function artifacts(repo) {
  return ["release.bundle", "release-summary.md"].map(name => join(repo.root, "dist", "release", name));
}

function runner(t, repo, name, branch = "main") {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  repo.run(["clone", "--quiet", "--no-hardlinks", "--branch", branch, repo.root, root]);
  return new Repository(root);
}

function applyDevBackport(repo, number, base, head) {
  const patch = repo.run(["format-patch", "--stdout", `${base}..${head}`]);
  repo.run(["switch", "--create", `backport/pr-${number}-to-dev`, repo.sha("origin/dev")]);
  repo.run([
    "am", "--3way", "--empty=keep", "--ignore-whitespace", "--keep-non-patch",
    "--exclude=CHANGELOG.md", "--exclude=opencode/**"
  ], { input: patch });
  return repo.sha("HEAD");
}

function mockGitHub(t, respond) {
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "offline-test-token";
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (command, args, settings) =>
    command === "gh" ? respond(args, settings) : spawn(command, args, settings));
  syncBuiltinESMExports();
  t.after(() => {
    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("release range comes from historical changelog metadata, not an input or dev version", t => {
  const { repo, root, historical, source, options } = fixture(t, "9.9.9");
  const resolved = candidates.resolveStage(repo, options);
  assert.equal(resolved.from, historical);
  assert.equal(resolved.source, source);
  assert.equal(resolved.baselineVersion, "0.0.3");
  assert.equal(versionSnapshot(repo, source).version, "9.9.9");

  const work = mkdtempSync(join(tmpdir(), "release-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, "commits.txt"), commitLog(resolved));
  writeFileSync(join(work, "release_notes.md"), releaseNotes(repo, resolved));
  writeFileSync(join(work, "changelog_entry.md"), `${changelogEntry(resolved)}\n`);
  const staged = candidates.stageRelease(repo, { ...options, releaseWorkDir: work });
  const release = latestRelease(readChangelog(repo, staged.candidate));
  assert.equal(versionSnapshot(repo, staged.candidate).version, "0.0.4");
  assert.equal(release.notesState, "pending");
  assert.match(release.entry, /^## \[v0\.0\.4\]\(https:\/\/github\.com\/microsoft\/aspire-skills\/releases\/tag\/v0\.0\.4\)/);
  assert.match(release.entry, /<!-- aspire-skills-changelog from=[0-9a-f]{40} to=[0-9a-f]{40} base=0\.0\.3 -->/);
  assert.doesNotMatch(release.entry, /\d{4}-\d{2}-\d{2}|Selected development feature/);
  assert.match(release.entry, /do not copy the source commit list/);
  const verified = candidates.verifyCandidate(repo, inputs(staged), ...artifacts(repo));
  assert.equal(verified.summary.match(/^- \[ \] /gm).length, 4);
  assert.match(verified.summary, /plugins, skills, canvases[\s\S]*omit CI, build, and release infrastructure/);
  assert.match(verified.summary, /\*\*Create a merge commit\*\*\. Do not squash or rebase/);
  assert.match(verified.summary, /After publication, confirm `v0\.0\.4` points to the merge commit/);
  assert.match(verified.summary, /backport into `dev`[\s\S]*version `0\.0\.4`[\s\S]*excludes `CHANGELOG\.md` and `opencode\/`/);
  assert.match(verified.summary, /User-facing notes are pending in `CHANGELOG\.md`/);
  assert.match(verified.summary, /<summary>Source commits \(review evidence, not release notes\)<\/summary>/);
  assert.ok(verified.summary.indexOf("Add selected development feature") > verified.summary.indexOf("<details>"));
  assert.doesNotMatch(verified.summary, /Proposed release notes|deterministic fallback|retry the release label|agentic workflow/);
  const receiver = runner(t, repo, "release-receiver");
  assert.equal(candidates.receiveCandidate(receiver, inputs(staged), ...artifacts(repo)).summary, verified.summary);
  for (const unsupported of [
    release.entry.replace(/^<!-- aspire-skills-changelog.* -->\n?/m, ""),
    release.entry.replace(releaseHeading("0.0.4"), "## v0.0.4 - 2026-10-08")
  ]) {
    assert.throws(() => latestRelease(unsupported), /valid release metadata/);
  }
  assert.equal(latestRelease(readChangelog(repo, resolved.base).replace("base=0.0.3", "base=")).notesState, "finalized");
  const reviewedNotes = "### Skills\n\n- Restore missing Aspire skills without enabling MCP.";
  const finalized = finalize(repo, staged.candidate, reviewedNotes);
  const reviewedSummary = candidates.summary(repo, { ...staged, candidate: finalized });
  assert.ok(reviewedSummary.includes(reviewedNotes));
  assert.doesNotMatch(reviewedSummary, /User-facing notes are pending|Source commits|Add selected development feature/);
});

test("both release cycles export version changes in the stock backport patch", t => {
  const { repo, root, source, options } = fixture(t);
  const first = candidates.stageRelease(repo, { ...options, sourceCommit: source });
  const firstHead = finalize(repo, first.candidate);
  const firstMain = publish(repo, firstHead);
  const backport = applyDevBackport(repo, 910, first.base, firstHead);
  assert.equal(repo.files(backport, ["CHANGELOG.md", "opencode"]).size, 0);
  assert.equal(versionSnapshot(repo, backport).version, "0.0.4");
  candidates.checkDevelopment(repo, { head: backport, base: source, branch: "backport/pr-910-to-dev" });
  repo.run(["switch", "dev"]);
  repo.run(["merge", "--no-ff", "--no-edit", backport]);
  mkdirSync(join(root, "skills", "later"), { recursive: true });
  writeFileSync(join(root, "skills", "later", "SKILL.md"),
    '---\nname: later\nmetadata:\n  version: "0.0.4"\n---\nLater skill.\n');
  repo.run(["add", "--all"]);
  const later = commit(repo, "Add a skill for the next release");
  repo.run(["update-ref", "refs/remotes/origin/dev", repo.sha("HEAD")]);

  const secondRepo = runner(t, repo, "second-release");
  const second = candidates.stageRelease(secondRepo, { releaseVersion: "0.0.5" });
  assert.equal(second.from, source);
  assert.ok(second.changes.some(change => change.sha === later));
  const [integration] = secondRepo.parents(second.candidate);
  assert.equal(secondRepo.parents(second.candidate).length, 1);
  assert.deepEqual(secondRepo.parents(integration), [firstMain, second.source]);
  assert.equal(versionSnapshot(secondRepo, integration).version, "0.0.4");
  const tree = secondRepo.run(["rev-parse", `${second.candidate}^{tree}`]).trim();
  const metadataMerge = secondRepo.commitTree(tree, [firstMain, second.source], "Incorrect metadata merge");
  assert.throws(() => candidates.validateStage(secondRepo, metadataMerge), /ordinary commit/);
  const emptyStage = secondRepo.commitTree(tree, [metadataMerge], "Hide metadata in the integration merge");
  assert.throws(() => candidates.validateStage(secondRepo, emptyStage), /preserve the selected dev source and version values/);
  const secondHead = finalize(secondRepo, second.candidate);
  const secondMain = publish(secondRepo, secondHead);
  assert.equal(candidates.validatePublished(secondRepo, secondMain).version, "0.0.5");
  const secondBackport = applyDevBackport(secondRepo, 911, second.base, secondHead);
  assert.equal(secondRepo.files(secondBackport, ["CHANGELOG.md", "opencode"]).size, 0);
  assert.equal(versionSnapshot(secondRepo, secondBackport).version, "0.0.5");
  assert.ok(onlyVersionChanges(secondRepo, second.source, secondBackport));
  candidates.checkDevelopment(secondRepo, {
    head: secondBackport, base: second.source, branch: "backport/pr-911-to-dev"
  });
});

test("pending notes and ordinary main branches fail while reviewed releases and stock backports pass", t => {
  const { repo, root, options } = fixture(t);
  const staged = candidates.stageRelease(repo, options);
  assert.throws(() => candidates.checkPull(repo, {
    target: "main", headBranch: staged.branch, headCommit: staged.candidate
  }), /notes are pending/);
  const reviewed = finalize(repo, staged.candidate);
  assert.doesNotThrow(() => candidates.checkPull(repo, {
    target: "main", headBranch: staged.branch, headCommit: reviewed
  }));
  repo.run(["switch", "--create", "contributor", repo.sha("origin/main")]);
  writeFileSync(join(root, "MAIN.md"), "Direct main contribution.\n");
  repo.run(["add", "--all"]);
  const head = commit(repo, "Update main directly");
  assert.throws(() => candidates.checkPull(repo, {
    target: "main", headBranch: "contributor", headCommit: head
  }), /Contributor PRs must target dev/);
  assert.doesNotThrow(() => candidates.checkPull(repo, {
    target: "main", headBranch: "backport/pr-42-to-main", headCommit: head
  }));
});

test("source publication tags the exact main merge once and refuses a different target", t => {
  const { repo, options } = fixture(t);
  const staged = candidates.stageRelease(repo, options);
  const released = publish(repo, finalize(repo, staged.candidate));
  const ref = "refs/tags/v0.0.4";
  const url = "https://github.com/microsoft/aspire-skills/releases/tag/v0.0.4";
  let remote = "";
  let created = false;
  mockGitHub(t, (args, settings) => {
    if (args[0] === "api") {
      return { status: 0, stderr: "", stdout: JSON.stringify(created ? [[{ tag_name: "v0.0.4", draft: false }]] : [[]]) };
    }
    assert.deepEqual(args, [
      "release", "create", "v0.0.4", "--repo", "microsoft/aspire-skills",
      "--verify-tag", "--target", released, "--title", "v0.0.4", "--notes-file", "-"
    ]);
    assert.match(settings.input, /Improve the Aspire skills release/);
    assert.doesNotMatch(settings.input, /aspire-skills-(?:release|changelog)/);
    created = true;
    return { status: 0, stderr: "", stdout: `${url}\n` };
  });
  const run = repo.run.bind(repo);
  let pushes = 0;
  let tags = 0;
  t.mock.method(repo, "run", (args, settings) => {
    if (args[0] === "remote") return "https://github.com/microsoft/aspire-skills\n";
    if (args[0] === "ls-remote") return remote;
    if (args.includes("push")) {
      assert.deepEqual(args.slice(-3), ["push", "origin", ref]);
      pushes++;
      remote = `${repo.run(["rev-parse", ref]).trim()}\t${ref}\n${repo.sha(ref)}\t${ref}^{}\n`;
      return "";
    }
    if (args[0] === "tag") {
      assert.deepEqual(args, [
        "tag", "--annotate", "--no-sign", "--message", "Aspire skills v0.0.4", "v0.0.4", released
      ]);
      tags++;
    }
    return run(args, settings);
  });
  assert.equal(candidates.publishRelease(repo, released).url, url);
  candidates.publishRelease(repo, released);
  assert.equal(repo.sha(ref), released);
  assert.equal(pushes, 1);
  assert.equal(tags, 1);
  remote = `${"a".repeat(40)}\t${ref}\n`;
  assert.throws(() => candidates.publishRelease(repo, released), /must not be rewritten/);
  assert.equal(pushes, 1);
  assert.equal(tags, 1);
});

test("release workflow preparation fetches explicit refs and computes App permissions", t => {
  const { repo, root, base, source } = fixture(t);
  repo.run(["update-ref", "refs/heads/release/0.0.4", source]);
  repo.run(["update-ref", "refs/pull/42/head", source]);
  const workflow = runner(t, repo, "release-workflow");

  assert.deepEqual(fetchReleaseRefs(workflow, "0.0.4"), { branch: "release/0.0.4" });
  assert.equal(workflow.sha("origin/main"), base);
  assert.equal(workflow.sha("origin/dev"), source);
  assert.equal(workflow.sha("origin/release/0.0.4"), source);
  assert.deepEqual(fetchReleaseNotesRefs(workflow, 42), { pull: "42", head: source });
  assert.deepEqual(fetchPublishedMain(workflow), { main: base });
  assert.deepEqual(publicationPermissions(workflow, base, source), {});

  repo.run(["switch", "dev"]);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "release.yml"), "name: Release\n");
  repo.run(["add", "--all"]);
  const workflowChange = commit(repo, "Change release workflow");
  assert.deepEqual(publicationPermissions(repo, source, workflowChange), { workflows: "write" });
});

test("version edits preserve every other byte and reject ambiguous or invalid manifests", () => {
  const version = "0.0.4";
  const json = '{\r\n  "version": "0.0.3",\r\n  "dependencies": { "yaml": "0.0.3" }\r\n}\r\n';
  const lock = '{"version":"0.0.3","packages":{"":{"version":"0.0.3"},"node_modules/yaml":{"version":"2.9.0"}}}\r\n';
  const marketplace = '{"plugins":[{"name":"unrelated","version":"0.0.3"},{"name":"aspire","version":"0.0.3"}]}\n';
  const fixtures = [
    ["package.json", json, json.replace('"version": "0.0.3"', '"version": "0.0.4"')],
    ["package-lock.json", lock, lock.replaceAll('"version":"0.0.3"', '"version":"0.0.4"')],
    [".claude-plugin/marketplace.json", marketplace,
      marketplace.replace('"name":"aspire","version":"0.0.3"', '"name":"aspire","version":"0.0.4"')],
    ["package.json", '{"v\\u0065rsion":"0.0.3","note":"leave \\"quoted\\" text"}\n',
      '{"v\\u0065rsion":"0.0.4","note":"leave \\"quoted\\" text"}\n'],
    ...["", "'", '"'].map(quote => {
      const skill = `---\r\nmetadata:\r\n  version: ${quote}0.0.3${quote} # keep\r\n  other:\r\n    version: "0.0.3"\r\n---\r\nBody 0.0.3.\r\n`;
      return ["skills/aspire/SKILL.md", skill, skill.replace(
        `version: ${quote}0.0.3${quote} # keep`, `version: ${quote}0.0.4${quote} # keep`)];
    }),
    ["skills/aspire/SKILL.md", "---\nmetadata: { version: '0.0.3', other: keep }\n---\nBody.\n",
      "---\nmetadata: { version: '0.0.4', other: keep }\n---\nBody.\n"]
  ];
  for (const [path, source, expected] of fixtures) {
    const bytes = Buffer.from(source);
    assert.equal(updateVersion(bytes, path, "0.0.3"), bytes);
    assert.equal(updateVersion(bytes, path, version).toString(), expected);
  }
  for (const [path, source] of [
    ["package.json", '{"version":"0.0.3","v\\u0065rsion":"0.0.3"}'],
    ["package.json", '{"version":"0.0.3","dependencies":{"x":1,"x":2}}'],
    ["package.json", '{"version":"0.0.3",}'],
    ["package.json", '{"version":"0.0.3" /* comment */}'],
    ["package.json", '{"version":3}'],
    ["package.json", "{}"],
    ["package-lock.json", '{"version":"0.0.3","packages":{"":{"version":"0.0.2"}}}'],
    [".claude-plugin/marketplace.json", '{"plugins":[{"name":"aspire","version":"0.0.3"},{"name":"aspire","version":"0.0.3"}]}'],
    ["skills/aspire/SKILL.md", '---\nmetadata:\n  version: "0.0.3"\n  version: "0.0.3"\n---\n'],
    ["skills/aspire/SKILL.md", '---\nmetadata: { version: "0.0.3" }\nmetadata: { version: "0.0.3" }\n---\n']
  ]) {
    assert.throws(() => updateVersion(Buffer.from(source), path, version));
  }
});

test("restaging preserves reviewed notes and main resolutions without changing snapshot membership", t => {
  const { repo, root, base, source, options } = fixture(t);
  const first = candidates.stageRelease(repo, options);
  const finalized = finalize(repo, first.candidate);
  repo.run(["update-ref", `refs/heads/${first.branch}`, finalized]);
  const rerun = candidates.stageRelease(runner(t, repo, "same-snapshot"), options);
  assert.equal(rerun.candidate, finalized);
  assert.equal(rerun.notesState, "finalized");

  repo.run(["switch", "main"]);
  writeFileSync(join(root, "README.md"), "Main fix.\n");
  repo.run(["add", "--all"]);
  const updatedMain = commit(repo, "Apply main fix");
  repo.run(["update-ref", "refs/remotes/origin/main", updatedMain]);
  repo.run(["switch", "--detach", finalized]);
  const merge = repo.run(["merge", "--no-ff", "--no-commit", updatedMain], { statuses: [0, 1] });
  assert.equal(merge.status, 1);
  const resolution = "Reviewed main conflict resolution.\n";
  writeFileSync(join(root, "README.md"), resolution);
  repo.run(["add", "--all"]);
  const reviewed = commit(repo, "Resolve main conflict");
  repo.run(["update-ref", `refs/heads/${first.branch}`, reviewed]);

  repo.run(["switch", "dev"]);
  mkdirSync(join(root, "skills", "later"));
  writeFileSync(join(root, "skills", "later", "SKILL.md"),
    '---\nname: later\nmetadata:\n  version: "0.0.3"\n---\nLater skill.\n');
  repo.run(["add", "--all"]);
  const later = commit(repo, "Add a later skill");
  repo.run(["update-ref", "refs/remotes/origin/dev", later]);
  const rejected = runner(t, repo, "missing-resolution");
  assert.throws(() => candidates.stageRelease(rejected, options), /preserve reviewed main resolutions/);
  assert.equal(rejected.sha(`origin/${first.branch}`), reviewed);

  writeFileSync(join(root, "README.md"), resolution);
  repo.run(["rm", "--", "skills/aspire/SKILL.md"]);
  repo.run(["add", "--all"]);
  const integrated = commit(repo, "Bring the reviewed resolution into dev");
  repo.run(["update-ref", "refs/remotes/origin/dev", integrated]);
  const refreshed = runner(t, repo, "restaged-release");
  const restaged = candidates.stageRelease(refreshed, options);
  assert.equal(restaged.base, base);
  assert.equal(restaged.from, first.from);
  assert.equal(restaged.source, integrated);
  assert.notEqual(restaged.source, source);
  assert.equal(restaged.notesState, "pending");
  const [integration] = refreshed.parents(restaged.candidate);
  assert.equal(refreshed.parents(restaged.candidate).length, 1);
  assert.deepEqual(refreshed.parents(integration), [reviewed, integrated]);
  assert.equal(versionSnapshot(refreshed, integration).version, "0.0.3");
  assert.equal(refreshed.read(restaged.candidate, "README.md").toString(), resolution);
  assert.equal(versionSnapshot(refreshed, restaged.candidate).version, "0.0.4");
  assert.ok(refreshed.files(restaged.candidate).has("opencode/v2/later/later.md"));
  assert.equal(refreshed.files(restaged.candidate).has("opencode/v2/aspire/aspire.md"), false);
  candidates.verifyCandidate(refreshed, inputs(restaged), ...artifacts(refreshed));
});

test("changelog preparation executes pinned main tooling rather than candidate code", t => {
  const { repo, root, options } = fixture(t);
  repo.run(["switch", "main"]);
  mkdirSync(join(root, "scripts"));
  cpSync(join(repositoryRoot, "scripts", "release.mjs"), join(root, "scripts", "release.mjs"));
  cpSync(join(repositoryRoot, "scripts", "release"), join(root, "scripts", "release"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts", "build-opencode-catalog.mjs"), join(root, "scripts", "build-opencode-catalog.mjs"));
  repo.run(["add", "--all"]);
  const trustedBase = commit(repo, "Install trusted release tooling on main");
  repo.run(["update-ref", "refs/remotes/origin/main", trustedBase]);
  repo.run(["switch", "dev"]);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "release.mjs"), 'throw new Error("Candidate tooling must not execute.");\n');
  repo.run(["add", "--all"]);
  const untrusted = commit(repo, "Change candidate tooling");
  repo.run(["update-ref", "refs/remotes/origin/dev", untrusted]);
  const staged = candidates.stageRelease(repo, options);
  repo.run(["update-ref", `refs/heads/${staged.branch}`, staged.candidate]);
  repo.run(["update-ref", "refs/pull/42/head", staged.candidate]);
  const candidate = runner(t, repo, "changelog-candidate", staged.branch);
  const tooling = mkdtempSync(join(tmpdir(), "trusted-release-tooling-"));
  t.after(() => rmSync(tooling, { recursive: true, force: true }));
  candidate.run(["worktree", "add", "--detach", tooling, trustedBase]);
  cpSync(join(repositoryRoot, "node_modules", "yaml"), join(tooling, "node_modules", "yaml"), { recursive: true });
  const notesPath = join(root, "changelog-input.json");
  const prepared = childProcess.spawnSync(process.execPath, [join(tooling, "scripts", "release.mjs"), "prepare-notes"], {
    encoding: "utf8",
    cwd: candidate.root,
    env: {
      ...process.env, RELEASE_REPO: candidate.root, HEAD_BRANCH: staged.branch,
      HEAD_COMMIT: staged.candidate, PR_NUMBER: "42", RELEASE_NOTES_PATH: notesPath
    }
  });
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const input = JSON.parse(readFileSync(notesPath, "utf8"));
  assert.equal(input.head, staged.candidate);
  assert.equal(input.source, untrusted);
  assert.equal(input.pending, true);
  assert.equal(candidate.sha("HEAD"), staged.candidate);
  assert.match(readFileSync(join(candidate.root, "scripts", "release.mjs"), "utf8"), /Candidate tooling must not execute/);
});
