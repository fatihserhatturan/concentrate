import { useEffect, useRef, useState } from "preact/hooks";
import { listDirectories, projectInfo, scan, type FsListing, type ProjectInfo, type ScanDone } from "../api.js";
import { Icon } from "../components/icons.js";
import { Logo, ThemeButton } from "../components/Shell.js";
import { baseName, formatDuration, number, timeAgo } from "../lib/format.js";
import { forgetProject, loadRecents, rememberProject } from "../lib/recents.js";
import { navigate } from "../lib/router.js";

type ScanState =
  | { status: "idle" }
  | { status: "running"; path: string; current: number; total: number; file: string; startedAt: number }
  | { status: "done"; path: string; result: ScanDone; elapsed: number }
  | { status: "error"; path: string; message: string };

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

function openProject(path: string): void {
  rememberProject(path);
  navigate({ project: path, view: "graph" });
}

function ProjectCard(props: { path: string; info: ProjectInfo | null; onSelect: () => void; onRemove: () => void }) {
  const { info, path } = props;
  const missing = info !== null && !info.exists;
  return (
    <div class={`project-card${missing ? " missing" : ""}`} role="button" tabIndex={0} onClick={props.onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSelect(); } }}>
      <h3><Icon name="folder" /> {info?.name ?? baseName(path)}</h3>
      <button class="btn btn-ghost btn-icon remove" title="Remove from recent projects" aria-label={`Remove ${baseName(path)} from recent projects`} onClick={(e) => { e.stopPropagation(); props.onRemove(); }}>
        <Icon name="x" />
      </button>
      <div class="path" title={path}>{path}</div>
      {info === null ? <div class="stats faint">Checking…</div> : missing ? <div class="stats">Folder not found</div> : info.hasGraph ? (
        <div class="stats">
          <span class="badge badge-ok">Graph ready</span>
          <span>Scanned {timeAgo(info.scannedAt)}</span>
          {info.files !== null && <span>{number(info.files)} files</span>}
          {info.nodes !== null && <span>{number(info.nodes)} nodes</span>}
        </div>
      ) : <div class="stats"><span class="badge">No graph yet</span><span>Select to scan it</span></div>}
    </div>
  );
}

function ScanPanel({ state, onOpen, onBack }: { state: Exclude<ScanState, { status: "idle" }>; onOpen: () => void; onBack: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (state.status !== "running") return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [state.status]);

  if (state.status === "error") {
    return (
      <div class="scan-panel" data-testid="scan-error">
        <div class="alert alert-danger"><strong>The scan failed.</strong> {state.message}</div>
        <div class="row"><button class="btn" onClick={onBack}>Back to folders</button></div>
      </div>
    );
  }
  if (state.status === "running") {
    const pct = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
    return (
      <div class="scan-panel" data-testid="scan-progress">
        <div class="row"><div class="spinner" /> <h3>Scanning {baseName(state.path)}</h3><span class="spacer" /><span class="muted small">{formatDuration(Date.now() - state.startedAt)}</span></div>
        <div class="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${pct}%` }} /></div>
        <div class="row small muted"><span>{number(state.current)} of {number(state.total)} files</span><span class="spacer" /><span>{pct}%</span></div>
        <div class="file" title={state.file}>{state.file || "Discovering files…"}</div>
      </div>
    );
  }
  const { result } = state;
  const report = result.report ?? {};
  const failures: Array<{ path: string; message: string }> = report.failedFiles ?? [];
  const warnings: Array<{ path?: string; message?: string }> = report.warnings ?? [];
  return (
    <div class="scan-panel" data-testid="scan-report">
      {result.status === "failed" ? <div class="alert alert-danger"><strong>The scan failed fast.</strong> The graph was not updated.</div>
        : result.status === "partial" ? <div class="alert alert-warn"><strong>Scanned with {failures.length} failed {failures.length === 1 ? "file" : "files"}.</strong> The graph holds everything else.</div>
        : <div class="row"><span class="badge badge-ok"><Icon name="check" /> Scan complete</span><span class="muted small">in {formatDuration(state.elapsed)}</span></div>}
      <div class="kv">
        <div><span class="v">{number(result.nodes)}</span><span class="k">nodes</span></div>
        <div><span class="v">{number(result.relationships)}</span><span class="k">relationships</span></div>
        <div><span class="v">{number(report.discoveredFiles)}</span><span class="k">files</span></div>
        <div><span class="v">{number(report.parsedFiles)}</span><span class="k">parsed</span></div>
      </div>
      {failures.length > 0 && (
        <details class="disclosure" open><summary>{failures.length} failed {failures.length === 1 ? "file" : "files"}</summary>
          <div class="disclosure-body"><ul class="issue-list">{failures.slice(0, 50).map((f) => <li><strong>{f.path}</strong> {f.message}</li>)}</ul></div></details>
      )}
      {warnings.length > 0 && (
        <details class="disclosure"><summary>{warnings.length} {warnings.length === 1 ? "warning" : "warnings"}</summary>
          <div class="disclosure-body"><ul class="issue-list">{warnings.slice(0, 50).map((w) => <li>{w.path ? <strong>{w.path} </strong> : null}{w.message ?? JSON.stringify(w)}</li>)}</ul></div></details>
      )}
      <div class="tag muted small">Graph written to {result.database}</div>
      <div class="row">
        <button class="btn btn-primary btn-lg" data-testid="open-graph" disabled={result.status === "failed"} title={result.status === "failed" ? "The scan failed, so there is no new graph to open" : undefined} onClick={onOpen}>Open graph <Icon name="arrow" /></button>
        <button class="btn btn-lg" onClick={onBack}>Back to folders</button>
      </div>
    </div>
  );
}

export function Start({ rescan }: { rescan?: string }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [pathText, setPathText] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState<ProjectInfo | null>(null);
  const [recents, setRecents] = useState(loadRecents);
  const [infos, setInfos] = useState<Record<string, ProjectInfo>>({});
  const [state, setState] = useState<ScanState>({ status: "idle" });
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [origins, setOrigins] = useState("");
  const [cache, setCache] = useState(true);
  const started = useRef(false);

  async function browse(dir?: string): Promise<void> {
    setLoading(true);
    try {
      const next = await listDirectories(dir);
      setListing(next);
      setPathText(next.path);
      setListError(null);
      setCurrent(null);
      if (next.current.hasGraph) projectInfo(next.path).then((info) => setCurrent((now) => (now === null ? info : now)), () => undefined);
    } catch (error) {
      setListError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function run(path: string): Promise<void> {
    const startedAt = Date.now();
    setState({ status: "running", path, current: 0, total: 0, file: "", startedAt });
    try {
      const result = await scan(
        { path, include: lines(include), exclude: lines(exclude), apiOrigins: origins.split(",").map((s) => s.trim()).filter(Boolean), cache },
        (c, t, file) => setState((s) => (s.status === "running" ? { ...s, current: c, total: t, file } : s)),
      );
      rememberProject(path);
      setRecents(loadRecents());
      setState({ status: "done", path, result, elapsed: Date.now() - startedAt });
    } catch (error) {
      setState({ status: "error", path, message: (error as Error).message });
    }
  }

  useEffect(() => {
    for (const recent of recents) {
      if (infos[recent.path]) continue;
      projectInfo(recent.path).then((info) => setInfos((all) => ({ ...all, [recent.path]: info })), () => undefined);
    }
  }, [recents]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (rescan) {
      void browse(rescan);
      void run(rescan);
    } else void browse(recents[0]?.path);
  }, []);

  const selected = listing?.path ?? "";
  const hasGraph = listing?.current.hasGraph ?? false;
  const busy = state.status === "running";
  const scanning = state.status !== "idle";

  return (
    <div class="start">
      <div class="start-inner">
        <header class="start-header">
          <Logo size={36} />
          <div><h1>Concentrate</h1><p>Turn a codebase into a graph you can ask questions.</p></div>
          <span class="spacer" />
          <ThemeButton />
        </header>

        {recents.length > 0 && (
          <section aria-labelledby="recent-title">
            <div class="section-title"><h2 id="recent-title">Recent projects</h2><span>{recents.length}</span></div>
            <div class="cards">
              {recents.map((recent) => (
                <ProjectCard
                  path={recent.path}
                  info={infos[recent.path] ?? null}
                  onSelect={() => { setState({ status: "idle" }); const info = infos[recent.path]; if (info?.hasGraph) openProject(recent.path); else void browse(recent.path); }}
                  onRemove={() => setRecents(forgetProject(recent.path))}
                />
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="browse-title">
          <div class="section-title"><h2 id="browse-title">{recents.length > 0 ? "Another project" : "Choose a project"}</h2><span>Pick a folder to scan, or open one that already has a graph.</span></div>
          <div class="card browser">
            {scanning ? (
              <ScanPanel state={state as Exclude<ScanState, { status: "idle" }>} onOpen={() => state.status === "done" && openProject(state.path)} onBack={() => setState({ status: "idle" })} />
            ) : (
              <>
                <form class="browser-bar" onSubmit={(e) => { e.preventDefault(); void browse(pathText); }}>
                  <button type="button" class="btn btn-icon" title={listing?.parent ? "Up one folder" : "This is the top folder"} aria-label="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && void browse(listing.parent)}><Icon name="up" /></button>
                  <button type="button" class="btn btn-icon" title="Home folder" aria-label="Home folder" disabled={!listing} onClick={() => listing && void browse(listing.home)}><Icon name="home" /></button>
                  <input class="input" data-testid="path" aria-label="Folder path" spellcheck={false} placeholder="/path/to/project (paste a path and press Enter)" value={pathText} onInput={(e) => setPathText((e.target as HTMLInputElement).value)} />
                  <button class="btn" type="submit">Go</button>
                </form>
                {listError ? <div class="empty"><h3>Cannot open that folder</h3><p>{listError}</p></div>
                  : !listing ? <div class="empty"><div class="spinner" style={{ margin: "0 auto" }} /></div>
                  : listing.entries.length === 0 ? <div class="empty"><h3>No sub-folders here</h3><p>You can still scan this folder.</p></div>
                  : (
                    <ul class="dir-list" style={{ opacity: loading ? 0.6 : 1 }}>
                      {listing.entries.map((entry) => (
                        <li><button class="dir-item" onClick={() => void browse(entry.path)}>
                          <Icon name="folder" /> <span class="name">{entry.name}</span>
                          {entry.isGitRepository && <span class="badge"><Icon name="git" /> git</span>}
                          {entry.hasGraph && <span class="badge badge-ok">graph</span>}
                        </button></li>
                      ))}
                    </ul>
                  )}
                {listing && (
                  <div class="current">
                    <div class="what">
                      <h3><Icon name="folder" /> {baseName(selected)}
                        {listing.current.isGitRepository && <span class="badge"><Icon name="git" /> git</span>}
                        {hasGraph ? <span class="badge badge-ok">graph ready</span> : <span class="badge">no graph yet</span>}
                      </h3>
                      <p class="muted small">{hasGraph
                        ? current ? `Scanned ${timeAgo(current.scannedAt)}${current.files !== null ? ` · ${number(current.files)} files` : ""}${current.nodes !== null ? ` · ${number(current.nodes)} nodes` : ""}` : "Checking the graph…"
                        : "Scanning reads the files and writes the graph to .concentrate/ inside the folder."}</p>
                    </div>
                    {hasGraph ? (
                      <>
                        <button class="btn btn-ghost btn-lg" data-testid="rescan" disabled={busy} onClick={() => void run(selected)}><Icon name="refresh" /> Rescan</button>
                        <button class="btn btn-primary btn-lg" data-testid="primary-action" onClick={() => openProject(selected)}>Open graph <Icon name="arrow" /></button>
                      </>
                    ) : (
                      <button class="btn btn-primary btn-lg" data-testid="primary-action" disabled={busy} onClick={() => void run(selected)}>Scan</button>
                    )}
                  </div>
                )}
                <details class="disclosure" style={{ margin: "var(--space-4)", marginTop: 0 }}>
                  <summary>Advanced</summary>
                  <div class="disclosure-body stack">
                    <div class="advanced-grid">
                      <div class="field"><label for="inc">Include globs (one per line)</label><textarea id="inc" class="input" rows={3} placeholder="src/**" value={include} onInput={(e) => setInclude((e.target as HTMLTextAreaElement).value)} /></div>
                      <div class="field"><label for="exc">Exclude globs (one per line)</label><textarea id="exc" class="input" rows={3} placeholder="**/*.test.ts" value={exclude} onInput={(e) => setExclude((e.target as HTMLTextAreaElement).value)} /></div>
                    </div>
                    <div class="field"><label for="org">API origins (comma separated)</label><input id="org" class="input" placeholder="https://api.example.com" value={origins} onInput={(e) => setOrigins((e.target as HTMLInputElement).value)} /></div>
                    <label class="check"><input type="checkbox" checked={cache} onChange={(e) => setCache((e.target as HTMLInputElement).checked)} /> Use the parse cache (only changed files are parsed again)</label>
                  </div>
                </details>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
