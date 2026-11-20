import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import type { IParseCache } from "../../core/contracts/parse-cache.js";
import type { ParsedSourceFile } from "../../core/graph/model.js";
import { createParseCacheReport, type ParseCacheReport } from "../../core/scan/report.js";

// Per-file parse results, reused while a file and the parsers are unchanged.
//
// A parse result depends only on the file's content and path and on the code
// that parsed it, so an entry is keyed by all three: the parser fingerprint
// (a hash of Concentrate's own code and grammars), the project-relative path
// and the content hash. Any code change gives a new fingerprint and every
// lookup misses. Cross-file passes (resolution, contributors) are never cached:
// they run over the whole graph on every scan, so a cached scan produces the
// same graph as a full one.
//
// Layout: <directory>/<project>/<key>.json.gz, where <project> is derived from
// the scanned root so several projects can share one cache directory.

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

// Entries are gzip-compressed JSON (4–6x smaller on disk). The file
// extension is part of the format: entries from before compression are
// `<key>.json`, never match a lookup and are removed by prune().
const ENTRY_EXTENSION = ".json.gz";
const GZIP_LEVEL = 6;
const ENTRY_VERSION = 1;

type CacheEntry = {
  version: typeof ENTRY_VERSION;
  parsed: ParsedSourceFile;
};

export class ParseCache implements IParseCache {
  private readonly projectDirectory: string;
  private readonly usedKeys = new Set<string>();

  constructor(
    directory: string,
    rootPath: string,
    private readonly fingerprint: string,
    readonly report: ParseCacheReport = createParseCacheReport(true),
  ) {
    this.projectDirectory = path.join(directory, sha256(rootPath).slice(0, 16));
  }

  key(relativePath: string, contentHash: string): string {
    return sha256(`${this.fingerprint}\0${relativePath}\0${contentHash}`);
  }

  async read(key: string): Promise<ParsedSourceFile | null> {
    this.usedKeys.add(key);
    try {
      const entry = JSON.parse((await gunzip(await readFile(this.entryPath(key)))).toString("utf8")) as Partial<CacheEntry>;
      if (entry.version === ENTRY_VERSION && entry.parsed) {
        this.report.hits += 1;
        return entry.parsed;
      }
    } catch {
      // Missing, corrupt or unreadable entries are misses.
    }
    this.report.misses += 1;
    return null;
  }

  // `parsed` must be the parser's own output, before the scan adds anything.
  // It is serialized before the first await, so later changes cannot leak in.
  async write(key: string, parsed: ParsedSourceFile): Promise<void> {
    const entry: CacheEntry = { version: ENTRY_VERSION, parsed };
    const json = JSON.stringify(entry);
    const target = this.entryPath(key);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      const compressed = await gzip(json, { level: GZIP_LEVEL });
      await mkdir(this.projectDirectory, { recursive: true });
      await writeFile(temporary, compressed);
      await rename(temporary, target);
      this.report.written += 1;
    } catch {
      // A cache that cannot be written only costs speed.
    } finally {
      await rm(temporary, { force: true });
    }
  }

  // Deletes this project's entries that the scan did not look up.
  async prune(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.projectDirectory);
    } catch {
      return;
    }
    for (const file of files) {
      if (this.usedKeys.has(file.endsWith(ENTRY_EXTENSION) ? file.slice(0, -ENTRY_EXTENSION.length) : file)) continue;
      await rm(path.join(this.projectDirectory, file), { force: true });
      this.report.pruned += 1;
    }
  }

  private entryPath(key: string): string {
    return path.join(this.projectDirectory, `${key}${ENTRY_EXTENSION}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
