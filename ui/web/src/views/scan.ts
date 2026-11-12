import { listDirectories, scan, type FsListing } from "../api.js";

const RECENT_KEY = "concentrate-recent";

function recent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}
function remember(path: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recent().filter((p) => p !== path)].slice(0, 8))); } catch { /* storage unavailable */ }
}
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function mountScanView(root: HTMLElement): void {
  root.innerHTML = `
    <h1>Concentrate</h1>
    <h2>Project</h2>
    <div class="row"><button id="up">↑</button><input type="text" id="path" placeholder="/path/to/project" /><button id="go">Open</button></div>
    <ul class="dirs" id="dirs"></ul>
    <div id="recent"></div>
    <h2>Options</h2>
    <div class="row"><textarea id="include" rows="2" placeholder="include globs, one per line"></textarea><textarea id="exclude" rows="2" placeholder="exclude globs, one per line"></textarea></div>
    <div class="row" style="margin-top:8px"><input type="text" id="origins" placeholder="API origins, comma separated" /><label><input type="checkbox" id="cache" checked /> use parse cache</label></div>
    <div class="row" style="margin-top:12px"><button class="primary" id="scan">Scan</button></div>
    <div id="progress" hidden><progress id="bar" value="0" max="1"></progress><div class="file" id="file"></div></div>
    <div id="report"></div>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  let listing: FsListing | undefined;

  async function navigate(dir?: string): Promise<void> {
    try {
      listing = await listDirectories(dir);
      $<HTMLInputElement>("path").value = listing.path;
      $("dirs").innerHTML = listing.entries.map((e) =>
        `<li data-path="${esc(e.path)}"><span>${esc(e.name)}</span><span class="tag">${e.isGitRepository ? "git " : ""}${e.hasGraph ? "graph" : ""}</span></li>`).join("");
    } catch (error) {
      $("report").innerHTML = `<div class="card bad">${esc((error as Error).message)}</div>`;
    }
  }
  function renderRecent(): void {
    const items = recent();
    $("recent").innerHTML = items.length ? `<div class="tag">Recent: ${items.map((p) => `<a href="#" data-path="${esc(p)}">${esc(p)}</a>`).join(" · ")}</div>` : "";
  }

  $("dirs").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (li) void navigate(li.dataset.path);
  });
  $("recent").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (a) { e.preventDefault(); void navigate(a.dataset.path); }
  });
  $("up").addEventListener("click", () => listing?.parent && void navigate(listing.parent));
  $("go").addEventListener("click", () => void navigate($<HTMLInputElement>("path").value));

  $("scan").addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("scan");
    const projectPath = $<HTMLInputElement>("path").value;
    button.disabled = true;
    $("report").innerHTML = "";
    $("progress").hidden = false;
    try {
      const done = await scan({
        path: projectPath,
        include: lines($<HTMLTextAreaElement>("include").value),
        exclude: lines($<HTMLTextAreaElement>("exclude").value),
        apiOrigins: $<HTMLInputElement>("origins").value.split(",").map((s) => s.trim()).filter(Boolean),
        cache: $<HTMLInputElement>("cache").checked,
      }, (current, total, file) => {
        const bar = $<HTMLProgressElement>("bar");
        bar.max = Math.max(total, 1);
        bar.value = current;
        $("file").textContent = file;
      });
      remember(projectPath);
      renderRecent();
      const warnings: any[] = done.report?.warnings ?? [];
      const failures: any[] = done.report?.failedFiles ?? [];
      $("report").innerHTML = `<div class="card"><strong>${done.status === "ok" ? "Scan complete" : done.status === "partial" ? "Scan finished with failures" : "Scan failed"}</strong>
        <div>${done.nodes} nodes, ${done.relationships} relationships</div><div class="tag">Graph: ${esc(done.database)}</div></div>
        ${failures.length ? `<div class="card bad"><strong>${failures.length} failed files</strong><br>${failures.slice(0, 20).map((f) => esc(`${f.path ?? ""}: ${f.message ?? ""}`)).join("<br>")}</div>` : ""}
        ${warnings.length ? `<div class="card warn"><strong>${warnings.length} warnings</strong><br>${warnings.slice(0, 20).map((w) => esc(w.message ?? JSON.stringify(w))).join("<br>")}</div>` : ""}`;
    } catch (error) {
      $("report").innerHTML = `<div class="card bad">${esc((error as Error).message)}</div>`;
    } finally {
      button.disabled = false;
      $("progress").hidden = true;
    }
  });

  renderRecent();
  void navigate(recent()[0]);
}
