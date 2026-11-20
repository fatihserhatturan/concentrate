/** The working-tree changes of a scanned project, as a version-control system reports them. */
export type ChangeSet = {
  /** Absolute, symlink-resolved directory that was scanned. */
  scanRoot: string;
  /** Absolute, symlink-resolved root of the work tree the changes are relative to. */
  repoRoot: string;
  /** Unified diff (`--unified=0`, `a/` and `b/` prefixes) against the base revision. */
  diff: string;
  /** Paths, relative to `repoRoot`, of files the diff does not cover (new, never added). */
  untracked: string[];
};

export type ChangeSourceOptions = {
  /** Directory the project was scanned from. */
  scanPath: string;
  /** Revision to diff against. */
  base: string;
};

export interface IChangeSource {
  /** Throws when `base` is not a usable revision or the project is not under version control. */
  changes(options: ChangeSourceOptions): Promise<ChangeSet>;
}
