#!/usr/bin/env node
// Release step for archived versions (registry versions spec v1). No dependencies.
//
//   node tools/release.mjs <id>     after bumping extensions/<id>/manifest.json, before committing
//   node tools/release.mjs --check  exit 1 if registry.json and the versions/ folders disagree
//
// <id> compares the working-tree manifest with the one at git HEAD. Only when the coreApi floor
// rose, the HEAD version (manifest.json, files/, style.css) is copied from git into
// extensions/<id>/versions/<version>/. Archived versions the latest already covers, or that share
// a floor with a newer one, are deleted. Then the registry.json entry gets the new `version`,
// `coreApi` and `versions` (archived versions only, newest first). Nothing else in the file changes.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const VERSION_RE = /^\d+\.\d+\.\d+$/;
// The CMS reads at most 20 refs per entry and drops one whose coreApi is longer than 40 characters.
export const MAX_ARCHIVED = 20;
export const CORE_API_MAX = 40;

// Versions and ranges

const parseTriple = (text) => (VERSION_RE.test(text.trim()) ? text.trim().split(".").map(Number) : null);

function compareTriples(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Compares two exact versions; throws on anything but x.y.z so a typo cannot sort silently. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => parseTriple(String(v)));
  if (!x || !y) throw new Error(`cannot compare "${a}" and "${b}": both must be x.y.z`);
  return compareTriples(x, y);
}

/**
 * The minimum version a coreApi range accepts, as [x, y, z], or null when the range is not one the
 * CMS understands. Same forms as the CMS (src/ext/semver.ts): ^x.y.z, ~x.y.z, >=x.y.z, exact x.y.z.
 */
export function rangeFloor(range) {
  if (typeof range !== "string") return null;
  const text = range.trim();
  const base = text.startsWith(">=") ? text.slice(2) : text.startsWith("^") || text.startsWith("~") ? text.slice(1) : text;
  return parseTriple(base);
}

function floorOf(range) {
  const floor = rangeFloor(range);
  if (!floor) throw new Error(`coreApi "${range}" is not ^x.y.z, ~x.y.z, >=x.y.z or x.y.z`);
  return floor;
}

/** The previous release must be archived only when the new one needs a newer core than it did. */
export const shouldArchive = (previousRange, nextRange) => compareTriples(floorOf(nextRange), floorOf(previousRange)) > 0;

export const sortNewestFirst = (refs) => [...refs].sort((a, b) => compareVersions(b.version, a.version));

/**
 * Keeps the newest archived version per floor and drops those whose floor the latest already
 * covers (floor >= the latest's). `refs` need `version` and `coreApi`.
 */
export function pruneVersions(refs, latestCoreApi) {
  const latestFloor = floorOf(latestCoreApi);
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const ref of sortNewestFirst(refs)) {
    const floor = floorOf(ref.coreApi);
    if (compareTriples(floor, latestFloor) >= 0 || seen.has(floor.join("."))) {
      dropped.push(ref);
      continue;
    }
    seen.add(floor.join("."));
    kept.push(ref);
  }
  return { kept, dropped };
}

// Archived folders

/** All files under `dir` as sorted paths relative to it ([] when `dir` does not exist). */
export async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT" && !prefix) return [];
    throw error;
  });
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

function sameList(a, b) {
  const [x, y] = [[...a].sort(), [...b].sort()];
  return x.length === y.length && x.every((item, i) => item === y[i]);
}

/** The folders under extensions/<id>/versions/ with their manifests and file lists. */
export async function readArchivedEntries(id, extDir) {
  const base = path.join(extDir, "versions");
  const dirents = await readdir(base, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const entries = [];
  const problems = [];
  for (const dirent of dirents.filter((d) => d.name !== ".DS_Store").sort((a, b) => a.name.localeCompare(b.name))) {
    const label = `${id}: versions/${dirent.name}`;
    if (!dirent.isDirectory() || !VERSION_RE.test(dirent.name)) {
      problems.push(`${label} must be a folder named x.y.z`);
      continue;
    }
    const raw = await readFile(path.join(base, dirent.name, "manifest.json"), "utf8").catch(() => null);
    let manifest = null;
    try {
      manifest = raw === null ? null : JSON.parse(raw);
    } catch {
      manifest = null;
    }
    if (!manifest || typeof manifest !== "object") {
      problems.push(`${label}/manifest.json is missing or not valid JSON`);
      continue;
    }
    entries.push({ folder: dirent.name, manifest, files: await listFiles(path.join(base, dirent.name, "files")) });
  }
  return { entries, problems };
}

/** Everything that would make an archived folder wrong for the CMS or out of step with the rules. */
export function archivedProblems(id, latest, entries) {
  const problems = [];
  const say = (folder, message) => problems.push(`${id}: versions/${folder} ${message}`);
  const usable = [];
  for (const { folder, manifest, files } of entries) {
    const before = problems.length;
    if (manifest.id !== id) say(folder, `manifest id "${manifest.id}" does not match its extension`);
    if (manifest.version !== folder) say(folder, `manifest version "${manifest.version}" does not match its folder`);
    const range = manifest.coreApi;
    if (typeof range !== "string" || range.length > CORE_API_MAX || !rangeFloor(range)) {
      say(folder, `coreApi must be ^x.y.z, ~x.y.z, >=x.y.z or x.y.z, at most ${CORE_API_MAX} characters (the CMS drops the version otherwise)`);
    }
    if (!sameList(Array.isArray(manifest.files) ? manifest.files : [], files)) say(folder, "manifest files do not match its files/ folder");
    if (problems.length === before) usable.push({ version: folder, coreApi: range });
  }
  if (entries.length > MAX_ARCHIVED) problems.push(`${id}: more than ${MAX_ARCHIVED} archived versions (the CMS reads only the first ${MAX_ARCHIVED})`);
  if (!rangeFloor(latest.coreApi)) {
    problems.push(`${id}: coreApi "${latest.coreApi}" is not a supported range, archived versions cannot be compared with it`);
    return problems;
  }
  if (VERSION_RE.test(String(latest.version))) {
    for (const ref of usable) if (compareVersions(ref.version, latest.version) >= 0) say(ref.version, `is not older than the latest ${latest.version}`);
  }
  for (const ref of pruneVersions(usable, latest.coreApi).dropped) {
    say(ref.version, "should have been pruned (the latest already covers its floor, or a newer archived version has the same floor); delete the folder");
  }
  return problems;
}

// Index entry

/**
 * The index entry with the new version, coreApi and `versions` (placed right after coreApi, left
 * out when empty). Key order of everything else is kept.
 */
export function updateEntry(entry, { version, coreApi, versions }) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "versions") continue;
    out[key] = key === "version" ? version : key === "coreApi" ? coreApi : value;
    if (key === "coreApi" && versions.length) out.versions = versions;
  }
  return out;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const stringList = (value) => (Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined);

async function readIndex(root) {
  const index = JSON.parse(await readFile(path.join(root, "registry.json"), "utf8"));
  if (!Array.isArray(index.extensions)) throw new Error("registry.json has no extensions array");
  return index;
}

// Git

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/** `git ls-tree` at HEAD for `pathspec`; [] when nothing is there. */
function headTree(root, pathspec, recursive) {
  const out = git(root, ["ls-tree", "-z", ...(recursive ? ["-r"] : []), "HEAD", "--", pathspec]).toString("utf8");
  return out.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, type, sha] = line.slice(0, tab).split(" ");
    return { mode, type, sha, path: line.slice(tab + 1) };
  });
}

const headJson = (root, pathspec) => {
  const [entry] = headTree(root, pathspec, false);
  return entry ? JSON.parse(git(root, ["cat-file", "blob", entry.sha]).toString("utf8")) : null;
};

/** What a version consists of at HEAD: manifest.json, files/** and style.css. Store images are not archived. */
function collectFromHead(root, id) {
  const base = `extensions/${id}`;
  const found = [
    ...headTree(root, `${base}/manifest.json`, false).map((e) => ({ ...e, rel: "manifest.json" })),
    ...headTree(root, `${base}/style.css`, false).map((e) => ({ ...e, rel: "style.css" })),
    ...headTree(root, `${base}/files/`, true).map((e) => ({ ...e, rel: e.path.slice(`${base}/`.length) })),
  ];
  return found.map((entry) => {
    if (entry.type !== "blob" || entry.mode === "120000") throw new Error(`${entry.path} at HEAD is not a regular file`);
    return { rel: entry.rel, executable: entry.mode === "100755", data: git(root, ["cat-file", "blob", entry.sha]) };
  });
}

async function writeArchive(dir, items) {
  await rm(dir, { recursive: true, force: true });
  for (const item of items) {
    const file = path.join(dir, item.rel);
    if (path.relative(dir, file).startsWith("..")) throw new Error(`refusing to write outside ${dir}: ${item.rel}`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, item.data);
    if (item.executable) await chmod(file, 0o755);
  }
}

// Release

/**
 * Archives the HEAD version of `id` when needed, prunes versions/ and updates the registry.json
 * entry. Changes nothing when it throws before the first write.
 */
export async function release({ root, id }) {
  if (!ID_RE.test(id ?? "")) throw new Error(`"${id}" is not an extension id`);
  const extDir = path.join(root, "extensions", id);
  const manifestRel = `extensions/${id}/manifest.json`;
  const nextRaw = await readFile(path.join(root, manifestRel), "utf8").catch(() => null);
  if (nextRaw === null) throw new Error(`${manifestRel} does not exist`);
  const next = JSON.parse(nextRaw);
  if (!VERSION_RE.test(String(next.version))) throw new Error(`${id}: version "${next.version}" must be x.y.z`);
  const index = await readIndex(root);
  const at = index.extensions.findIndex((e) => e.id === id);
  if (at < 0) throw new Error(`registry.json has no entry for "${id}"`);
  git(root, ["rev-parse", "--verify", "HEAD"]);

  const previous = headJson(root, manifestRel);
  let archived = null;
  let headFiles;
  if (previous) {
    if (!VERSION_RE.test(String(previous.version))) throw new Error(`${id}: version "${previous.version}" at HEAD must be x.y.z`);
    if (compareVersions(next.version, previous.version) <= 0) {
      throw new Error(`${id}: version ${next.version} is not newer than ${previous.version} at HEAD; bump the version first`);
    }
    if (shouldArchive(previous.coreApi, next.coreApi)) {
      const items = collectFromHead(root, id);
      // The CLI installs exactly the files the index lists, so the version keeps the list HEAD's index had.
      headFiles = stringList(headJson(root, "registry.json")?.extensions?.find((e) => e.id === id)?.files);
      await writeArchive(path.join(extDir, "versions", previous.version), items);
      archived = { version: previous.version, coreApi: previous.coreApi };
    }
  }

  const { entries, problems } = await readArchivedEntries(id, extDir);
  if (problems.length) throw new Error(problems.join("\n"));
  const refs = entries.map(({ folder, manifest }) => ({ version: folder, coreApi: manifest.coreApi }));
  const { kept, dropped } = pruneVersions(refs, next.coreApi);
  for (const ref of dropped) await rm(path.join(extDir, "versions", ref.version), { recursive: true, force: true });
  if (kept.length === 0) await rmdir(path.join(extDir, "versions")).catch(() => {});

  const existing = new Map((Array.isArray(index.extensions[at].versions) ? index.extensions[at].versions : []).map((ref) => [ref?.version, ref]));
  const byFolder = new Map(entries.map((e) => [e.folder, e.manifest]));
  const versions = kept.map((ref) => {
    const files = [archived?.version === ref.version ? headFiles : undefined, stringList(existing.get(ref.version)?.files), stringList(byFolder.get(ref.version)?.files)].find(Boolean);
    return { version: ref.version, coreApi: ref.coreApi, ...(files ? { files } : {}) };
  });
  const extensions = index.extensions.map((entry, i) => (i === at ? updateEntry(entry, { version: next.version, coreApi: next.coreApi, versions }) : entry));
  await writeFile(path.join(root, "registry.json"), json({ ...index, extensions }));
  return { id, from: previous?.version ?? null, to: next.version, archived, dropped: dropped.map((r) => r.version), kept: kept.map((r) => r.version) };
}

// Check

/** Problems where registry.json, the manifests and the versions/ folders disagree (empty = fine). */
export async function check({ root }) {
  const index = await readIndex(root);
  const problems = [];
  const dirents = await readdir(path.join(root, "extensions"), { withFileTypes: true }).catch(() => []);
  for (const dirent of dirents.filter((d) => d.isDirectory())) {
    if (!index.extensions.some((e) => e.id === dirent.name)) problems.push(`${dirent.name}: extensions/${dirent.name} has no entry in registry.json`);
  }
  for (const entry of index.extensions) {
    const id = entry.id;
    const raw = await readFile(path.join(root, "extensions", String(id), "manifest.json"), "utf8").catch(() => null);
    if (raw === null) {
      problems.push(`${id}: registry.json lists it but extensions/${id}/manifest.json does not exist`);
      continue;
    }
    const manifest = JSON.parse(raw);
    if (entry.version !== manifest.version) problems.push(`${id}: registry.json version ${entry.version} but the manifest says ${manifest.version}`);
    if (entry.coreApi !== manifest.coreApi) problems.push(`${id}: registry.json coreApi ${entry.coreApi} but the manifest says ${manifest.coreApi}`);
    const { entries, problems: readProblems } = await readArchivedEntries(id, path.join(root, "extensions", id));
    const folderProblems = [...readProblems, ...archivedProblems(id, manifest, entries)];
    problems.push(...folderProblems);
    if (folderProblems.length) continue;
    const actual = Array.isArray(entry.versions) ? entry.versions : [];
    const expected = sortNewestFirst(entries.map((e) => ({ version: e.manifest.version, coreApi: e.manifest.coreApi })));
    const pairs = (refs) => JSON.stringify(refs.map((r) => [r?.version, r?.coreApi]));
    if (pairs(actual) !== pairs(expected)) {
      problems.push(`${id}: registry.json versions [${actual.map((r) => r?.version).join(", ")}] do not match the versions/ folders [${expected.map((r) => r.version).join(", ")}]; run release.mjs ${id}`);
      continue;
    }
    for (const ref of actual) {
      const folder = entries.find((e) => e.folder === ref.version);
      if (!sameList(stringList(ref.files) ?? [], folder.files)) problems.push(`${id}: registry.json versions ${ref.version} files do not match versions/${ref.version}/files/`);
    }
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const problems = await check({ root: ROOT });
    if (problems.length) {
      console.error(problems.map((p) => `✗ ${p}`).join("\n"));
      process.exit(1);
    }
    console.log("registry.json and versions/ agree");
    return;
  }
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) throw new Error("usage: node tools/release.mjs <id> | --check");
  const result = await release({ root: ROOT, id });
  const archive = result.archived ? `archived ${result.archived.version} (${result.archived.coreApi})` : "nothing to archive (the coreApi floor did not rise)";
  console.log(`${id} ${result.from ?? "new"} -> ${result.to}: ${archive}${result.dropped.length ? `, pruned ${result.dropped.join(", ")}` : ""}`);
  console.log(`kept versions: ${result.kept.length ? result.kept.join(", ") : "none"}`);
}

// realpath: import.meta.url is resolved through symlinks (macOS /var -> /private/var), argv[1] is not.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
