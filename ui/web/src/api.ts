// The token arrives in the URL fragment, which is never sent to the server or logged.
function readToken(): string {
  const match = /token=([a-f0-9]+)/.exec(location.hash);
  if (match) {
    sessionStorage.setItem("concentrate-token", match[1]);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem("concentrate-token") ?? "";
}

const token = readToken();
const headers = { "x-concentrate-token": token };

export type FsEntry = { name: string; path: string; isGitRepository: boolean; hasGraph: boolean };
export type FsListing = { path: string; parent: string | null; home: string; entries: FsEntry[] };

export async function listDirectories(dir?: string): Promise<FsListing> {
  const response = await fetch(`/api/fs${dir ? `?path=${encodeURIComponent(dir)}` : ""}`, { headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

export type ScanOptions = { path: string; include: string[]; exclude: string[]; apiOrigins: string[]; cache: boolean };
export type ScanDone = { status: "ok" | "partial" | "failed"; nodes: number; relationships: number; report: any; database: string };

export async function scan(
  options: ScanOptions,
  onProgress: (current: number, total: number, file: string) => void,
): Promise<ScanDone> {
  const response = await fetch("/api/scan", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok || !response.body) throw new Error((await response.json()).error ?? response.statusText);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.type === "progress") onProgress(event.current, event.total, event.file);
      else if (event.type === "error") throw new Error(event.message);
      else if (event.type === "done") return event;
    }
  }
  throw new Error("The scan ended without a result");
}
