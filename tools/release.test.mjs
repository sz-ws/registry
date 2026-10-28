// node --test
//
// Floor comparison, archive-or-not and pruning are pure functions; the release step itself runs
// against a throwaway git repo, so nothing here touches the real extensions/ or registry.json.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { check, compareVersions, pruneVersions, rangeFloor, release, shouldArchive, sortNewestFirst, updateEntry } from "./release.mjs";

describe("rangeFloor", () => {
  it("reads the minimum of every range form the CMS supports", () => {
    assert.deepEqual(rangeFloor("^1.79.0"), [1, 79, 0]);
    assert.deepEqual(rangeFloor("~1.2.3"), [1, 2, 3]);
    assert.deepEqual(rangeFloor(">=1.5.0"), [1, 5, 0]);
    assert.deepEqual(rangeFloor("1.2.3"), [1, 2, 3]);
    assert.deepEqual(rangeFloor("  ^1.0.0 "), [1, 0, 0]);
    assert.deepEqual(rangeFloor(">= 1.5.0"), [1, 5, 0]);
  });

  it("returns null for what the CMS cannot parse", () => {
    for (const range of ["", "*", "latest", "^1.2", "1.x", ">1.2.3", "<=1.2.3", "^1.2.3 || ^2.0.0", "1.2.3-beta", undefined, 12]) {
      assert.equal(rangeFloor(range), null, String(range));
    }
  });
});

describe("compareVersions and sortNewestFirst", () => {
  it("compares numerically, not as text", () => {
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("0.2.2", "0.3.0"), -1);
    assert.deepEqual(sortNewestFirst([{ version: "0.9.0" }, { version: "0.10.0" }, { version: "0.2.2" }]).map((r) => r.version), ["0.10.0", "0.9.0", "0.2.2"]);
  });

  it("throws on a version that is not x.y.z", () => {
    assert.throws(() => compareVersions("1.2", "1.2.3"), /x\.y\.z/);
  });
});

describe("shouldArchive", () => {
  it("archives when the floor rose", () => {
    assert.equal(shouldArchive("^1.54.0", "^1.79.0"), true);
    assert.equal(shouldArchive("^1.54.0", "^1.54.1"), true);
    assert.equal(shouldArchive("~1.2.3", ">=1.3.0"), true);
    assert.equal(shouldArchive("^1.9.0", "^1.10.0"), true);
  });

  it("does not archive when the floor is the same or lower", () => {
    assert.equal(shouldArchive("^1.54.0", "^1.54.0"), false);
    assert.equal(shouldArchive("^1.54.0", ">=1.54.0"), false);
    assert.equal(shouldArchive("1.54.0", "~1.54.0"), false);
    assert.equal(shouldArchive("^1.79.0", "^1.54.0"), false);
  });

  it("refuses a range it cannot read instead of guessing", () => {
    assert.throws(() => shouldArchive("^1.54.0", "latest"), /coreApi "latest"/);
  });
});

describe("pruneVersions", () => {
  const ref = (version, coreApi) => ({ version, coreApi });
  const names = (refs) => refs.map((r) => r.version);

  it("keeps only the newest archived version per floor", () => {
    const { kept, dropped } = pruneVersions([ref("0.1.0", "^1.10.0"), ref("0.2.0", "^1.10.0"), ref("0.4.0", "^1.20.0")], "^1.30.0");
    assert.deepEqual(names(kept), ["0.4.0", "0.2.0"]);
    assert.deepEqual(names(dropped), ["0.1.0"]);
  });

  it("drops versions whose floor the latest already covers", () => {
    const { kept, dropped } = pruneVersions([ref("0.3.0", "^1.30.0"), ref("0.2.0", "^1.20.0"), ref("0.1.0", "^1.10.0")], "^1.20.0");
    assert.deepEqual(names(kept), ["0.1.0"]);
    assert.deepEqual(names(dropped), ["0.3.0", "0.2.0"]);
  });

  it("treats different range forms with one floor as the same floor", () => {
    assert.deepEqual(names(pruneVersions([ref("0.1.0", "^1.10.0"), ref("0.2.0", ">=1.10.0")], "^1.20.0").kept), ["0.2.0"]);
  });

  it("returns nothing for an empty list and leaves the input alone", () => {
    assert.deepEqual(pruneVersions([], "^1.0.0"), { kept: [], dropped: [] });
    const input = [ref("0.1.0", "^1.1.0"), ref("0.2.0", "^1.2.0")];
    pruneVersions(input, "^1.9.0");
    assert.deepEqual(names(input), ["0.1.0", "0.2.0"]);
  });
});

describe("updateEntry", () => {
  it("puts versions right after coreApi, keeps other keys in order and omits an empty list", () => {
    const entry = { id: "x", version: "1.0.0", coreApi: "^1.1.0", name: "X", versions: [{ version: "0.9.0", coreApi: "^1.0.0" }], files: ["a"] };
    const withOne = updateEntry(entry, { version: "1.1.0", coreApi: "^1.2.0", versions: [{ version: "1.0.0", coreApi: "^1.1.0" }] });
    assert.deepEqual(Object.keys(withOne), ["id", "version", "coreApi", "versions", "name", "files"]);
    assert.deepEqual(withOne.versions, [{ version: "1.0.0", coreApi: "^1.1.0" }]);
    const none = updateEntry(entry, { version: "1.1.0", coreApi: "^1.2.0", versions: [] });
    assert.deepEqual(Object.keys(none), ["id", "version", "coreApi", "name", "files"]);
  });
});

describe("release step in a git repo", () => {
  let root;
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
  const exists = (...parts) => stat(path.join(root, ...parts)).then(() => true, () => false);
  const readIndex = async () => JSON.parse(await read("registry.json"));
  const entryOf = async (id) => (await readIndex()).extensions.find((e) => e.id === id);
  const put = async (rel, content) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  };
  const putIndex = (index) => put("registry.json", `${JSON.stringify(index, null, 2)}\n`);
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  const discard = () => {
    git("checkout", "-q", "--", ".");
    git("clean", "-fdq");
  };

  /** Code extension "demo" as a maintainer leaves it: manifest, files/ and the index entry's files agree. */
  async function writeDemo(version, coreApi, files = ["index.ts", "lib/a.ts"]) {
    await rm(path.join(root, "extensions/demo/files"), { recursive: true, force: true });
    await put("extensions/demo/manifest.json", JSON.stringify({ id: "demo", kind: "code", version, coreApi, files }));
    for (const file of files) await put(`extensions/demo/files/${file}`, `${version}:${file}\n`);
    await put("extensions/demo/banner.png", "png");
    const index = await readIndex();
    await putIndex({ ...index, extensions: index.extensions.map((e) => (e.id === "demo" ? { ...e, files } : e)) });
  }
  /** Declarative extension "decl": a manifest and a stylesheet, no files/. */
  async function writeDecl(version, coreApi) {
    await put("extensions/decl/manifest.json", JSON.stringify({ id: "decl", kind: "declarative", version, coreApi }));
    await put("extensions/decl/style.css", `/* ${version} */\n`);
  }

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "registry-release-"));
    git("init", "-q", "-b", "main");
    await putIndex({
      extensions: [
        { id: "demo", kind: "code", name: "Demo", version: "0.1.0", coreApi: "^1.10.0", iconUrl: "icon.png", files: [] },
        { id: "decl", kind: "declarative", name: "Decl", version: "1.0.0", coreApi: "^1.10.0" },
      ],
    });
    await writeDemo("0.1.0", "^1.10.0");
    await writeDecl("1.0.0", "^1.10.0");
    commit("init");
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("archives the HEAD version when the floor rose, from git rather than the working tree", async () => {
    // HEAD had two files; the working tree already has three.
    await writeDemo("0.2.0", "^1.20.0", ["index.ts", "lib/a.ts", "lib/b.ts"]);
    const result = await release({ root, id: "demo" });
    assert.equal(result.archived.version, "0.1.0");
    assert.equal(await read("extensions/demo/versions/0.1.0/files/lib/a.ts"), "0.1.0:lib/a.ts\n");
    assert.equal(await read("extensions/demo/versions/0.1.0/files/index.ts"), "0.1.0:index.ts\n");
    assert.equal(await exists("extensions/demo/versions/0.1.0/files/lib/b.ts"), false);
    assert.equal(JSON.parse(await read("extensions/demo/versions/0.1.0/manifest.json")).version, "0.1.0");
    assert.equal(await exists("extensions/demo/versions/0.1.0/banner.png"), false);

    const entry = await entryOf("demo");
    assert.equal(entry.version, "0.2.0");
    assert.equal(entry.coreApi, "^1.20.0");
    // The version keeps the list the index had at HEAD, not the working tree's.
    assert.deepEqual(entry.versions, [{ version: "0.1.0", coreApi: "^1.10.0", files: ["index.ts", "lib/a.ts"] }]);
    assert.equal(Object.keys(entry).indexOf("versions"), Object.keys(entry).indexOf("coreApi") + 1);
    assert.deepEqual(entry.files, ["index.ts", "lib/a.ts", "lib/b.ts"]);
    assert.deepEqual(await check({ root }), []);

    // Running it again before committing gives the same result.
    await release({ root, id: "demo" });
    assert.equal(await read("extensions/demo/versions/0.1.0/files/lib/a.ts"), "0.1.0:lib/a.ts\n");
    assert.deepEqual((await entryOf("demo")).versions, [{ version: "0.1.0", coreApi: "^1.10.0", files: ["index.ts", "lib/a.ts"] }]);
    commit("demo 0.2.0");
  });

  it("archives nothing when the floor stays the same and still updates the entry", async () => {
    await writeDemo("0.3.0", ">=1.20.0", ["index.ts", "lib/a.ts", "lib/b.ts"]);
    const result = await release({ root, id: "demo" });
    assert.equal(result.archived, null);
    assert.deepEqual(await readdir(path.join(root, "extensions/demo/versions")), ["0.1.0"]);
    const entry = await entryOf("demo");
    assert.equal(entry.version, "0.3.0");
    assert.equal(entry.coreApi, ">=1.20.0");
    assert.deepEqual(entry.versions.map((v) => v.version), ["0.1.0"]);
    commit("demo 0.3.0");
  });

  it("keeps one version per break, newest first, each with its own files", async () => {
    await writeDemo("0.4.0", "^1.30.0", ["index.ts", "lib/a.ts"]);
    await release({ root, id: "demo" });
    commit("demo 0.4.0");
    await writeDemo("0.5.0", "^1.31.0", ["index.ts"]);
    await release({ root, id: "demo" });
    commit("demo 0.5.0");
    const versions = (await entryOf("demo")).versions;
    assert.deepEqual(versions.map((v) => `${v.version}@${v.coreApi}`), ["0.4.0@^1.30.0", "0.3.0@>=1.20.0", "0.1.0@^1.10.0"]);
    assert.deepEqual(versions.map((v) => v.files), [["index.ts", "lib/a.ts"], ["index.ts", "lib/a.ts", "lib/b.ts"], ["index.ts", "lib/a.ts"]]);
    assert.deepEqual(await check({ root }), []);
  });

  it("prunes versions the new latest already covers", async () => {
    // The floor falls back to 1.25: 0.4.0 (1.30) is covered; 0.3.0 (1.20) and 0.1.0 (1.10) stay.
    await writeDemo("0.6.0", "^1.25.0", ["index.ts"]);
    const result = await release({ root, id: "demo" });
    assert.deepEqual(result.dropped, ["0.4.0"]);
    assert.deepEqual(await readdir(path.join(root, "extensions/demo/versions")), ["0.1.0", "0.3.0"]);
    assert.deepEqual((await entryOf("demo")).versions.map((v) => v.version), ["0.3.0", "0.1.0"]);
    commit("demo 0.6.0");

    await writeDemo("0.7.0", "^1.5.0", ["index.ts"]);
    await release({ root, id: "demo" });
    assert.equal(await exists("extensions/demo/versions"), false);
    assert.equal("versions" in (await entryOf("demo")), false);
    commit("demo 0.7.0");
  });

  it("archives a declarative extension's style.css and gives its versions no files", async () => {
    await writeDecl("1.1.0", "^1.40.0");
    await release({ root, id: "decl" });
    assert.equal(await read("extensions/decl/versions/1.0.0/style.css"), "/* 1.0.0 */\n");
    assert.equal(await exists("extensions/decl/versions/1.0.0/files"), false);
    assert.deepEqual((await entryOf("decl")).versions, [{ version: "1.0.0", coreApi: "^1.10.0" }]);
    assert.deepEqual(await check({ root }), []);
    commit("decl 1.1.0");
  });

  it("refuses a version that was not bumped or went backwards, an unknown entry and an unreadable range", async () => {
    await assert.rejects(release({ root, id: "demo" }), /not newer than 0\.7\.0 at HEAD/);
    await writeDemo("0.6.5", "^1.5.0");
    await assert.rejects(release({ root, id: "demo" }), /not newer/);
    await assert.rejects(release({ root, id: "Demo" }), /not an extension id/);
    await assert.rejects(release({ root, id: "ghost" }), /does not exist/);
    await writeDemo("0.8.0", "latest");
    await assert.rejects(release({ root, id: "demo" }), /coreApi "latest"/);
    assert.equal(await exists("extensions/demo/versions"), false);
    discard();

    await put("extensions/loose/manifest.json", JSON.stringify({ id: "loose", kind: "declarative", version: "1.0.0", coreApi: "^1.0.0" }));
    await assert.rejects(release({ root, id: "loose" }), /no entry for "loose"/);
    discard();
  });

  it("check reports an index that disagrees with the folders", async () => {
    await writeDemo("0.8.0", "^1.40.0", ["index.ts"]);
    await release({ root, id: "demo" });
    commit("demo 0.8.0");
    assert.deepEqual(await check({ root }), []);

    const original = await readIndex();
    const withVersions = (mutate) => ({ ...original, extensions: original.extensions.map((e) => (e.id === "demo" ? mutate(e) : e)) });
    const first = (e) => e.versions[0];
    await putIndex(withVersions((e) => ({ ...e, versions: [{ ...first(e), coreApi: "^1.99.0" }] })));
    assert.match((await check({ root })).join("\n"), /demo: registry\.json versions .* do not match the versions\/ folders/);

    await putIndex(withVersions((e) => ({ ...e, versions: [{ ...first(e), files: ["index.ts", "ghost.ts"] }] })));
    assert.match((await check({ root })).join("\n"), /versions 0\.7\.0 files do not match/);

    await putIndex(withVersions(({ versions, ...rest }) => rest));
    assert.match((await check({ root })).join("\n"), /do not match the versions\/ folders/);

    await putIndex(original);
    await put("extensions/stray/manifest.json", "{}");
    assert.match((await check({ root })).join("\n"), /extensions\/stray has no entry/);
    discard();

    const manifest = JSON.parse(await read("extensions/demo/manifest.json"));
    await put("extensions/demo/manifest.json", JSON.stringify({ ...manifest, version: "0.9.0" }));
    assert.match((await check({ root })).join("\n"), /registry\.json version 0\.8\.0 but the manifest says 0\.9\.0/);
    discard();
  });

  it("check reports a folder that should have been pruned", async () => {
    const file = "extensions/demo/versions/0.7.0/manifest.json";
    const manifest = JSON.parse(await read(file));
    await put(file, JSON.stringify({ ...manifest, coreApi: "^1.40.0" }));
    assert.match((await check({ root })).join("\n"), /versions\/0\.7\.0 should have been pruned/);
    discard();
  });
});
