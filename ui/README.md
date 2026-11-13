# Concentrate UI

An optional local web interface for Concentrate: pick a directory, scan it, see the result.
It is a separate package; the core has no UI code and `npm install` at the repository root installs nothing from here.

## Run

```bash
npm install            # at the repository root, once
cd ui
npm install
npm start              # builds the core (../dist) and the web app, starts the server, opens the browser
```

From the repository root, `concentrate ui` (`npm run dev -- ui`) starts it once `ui/` is installed.

The server binds to `127.0.0.1` on a random port (`PORT=4000` to choose one, `NO_OPEN=1` to keep the browser closed).
The URL carries a random token for this start; every API call needs it, and requests whose `Host` is not `127.0.0.1` / `localhost` are refused.

The scan writes `<project>/.concentrate/graph`, the CLI default, so `concentrate mcp` and `concentrate query` read the same graph.

## Status

Phases 1 to 4 of #252 are in: the core entry point (`src/api.ts`), the scan view, the graph view, the exports, the question presets, the Cypher panel and the light/dark theme.
The docs in `docs/getting-started.md` and the `concentrate ui` command are in too (phase 5).

The graph is always about something. **Focus** (click a symbol or file, or use search or *Show in graph*) puts one node in
the middle, what uses it on the left and what it uses on the right, in a layered layout that is the same every time; click
a neighbour to refocus, use the 1 to 3 steps switch to walk further, and **Trace path** (or Shift+click) draws the shortest chain of
relationships to a second node. **Open graph** lands on the whole graph (`All`): every file and symbol that has a relationship,
one cluster per folder, colour by kind of node, size by number of links. Far out you read the folder names; zoom in and the
most connected nodes get labels, then all of them. Click a node to inspect it, double-click to focus on it. Each folder is laid
out on its own and placed in a disc reserved for it (`shared/seed-layout.ts`, `web/src/graph/clusterLayout.ts`), so clusters stay
apart. Above 20,000 nodes the most connected are kept and the inspector says so. The HTML export uses the same layout, palette
and labels. `Packages`, `Folders` and `Files` are the older, aggregated overviews (the other place with a force layout), where
dot-folders and build output and nodes without relationships are kept out of the picture with a count in the legend.
The legend is also the filter: five relationship categories and, in the whole graph, each kind of node can be switched on and off. Everything is in the URL
(`view=graph&focus=…&to=…&show=…`), so back and forward work.

The server keeps the whole graph in memory per project and answers `GET /api/graph/{summary,overview,focus,path,neighbors,node,source,preset,
catalog,entities,dashboard,issues}` and `GET /api/search` (all take `project=`).

## Keyboard

`Ctrl/Cmd+K` opens the command palette: views, graph actions, the questions, and symbols, files and routes from the graph. Actions
that cannot run now stay in the list and say why. `/` searches (in the graph) or opens the palette, `F` fits the graph, `Esc` steps back out
of the most recent thing (a panel, a traced path, a question, the focus), the arrow keys move between neighbouring nodes in the graph and
between rows in a table, `Enter` refocuses or selects, and `?` lists them all.

## Questions and Cypher

The **Questions** menu answers what Concentrate is for: the import graph, the calls around the selected symbol (two levels),
routes → handlers → tables, frontend requests → routes, the component tree, and import cycles (strongly connected groups of
files, drawn with red edges). They are `GET /api/graph/preset?name=`.

**Query** opens a read-only Cypher panel (`POST /api/query`, see `docs/cypher.md`): at most 1,000 rows come back, writes are
refused by the engine, and a row with an `id` column focuses that node. The theme follows the system and can be switched with the button in the top bar.

On nestjs/nest (about 54k nodes, 73k relationships) the first overview after a scan takes about 0.7 s (it loads the graph), later
ones a few milliseconds, and expanding a node or a search answers in under 10 ms. Above 5,000 nodes the overview keeps the most connected
nodes; above 300, files without relationships are left out.

## Export

`GET /api/export?project=&format=json|jsonl|graphml|dot|html&scope=graph|view` (the **Export…** button of the graph view).
Nothing is written into the scanned project.

| Format | Content |
| --- | --- |
| `json` | one file: `schemaVersion`, `rootPath`, `nodes`, `relationships` |
| `jsonl` | a zip of `nodes.jsonl`, `relationships.jsonl`, `summary.json`. For the whole graph the records are rebuilt with the same scan and written by the same code as `concentrate export`, so they are byte for byte the CLI's; a view comes from the store |
| `graphml` | typed `<data>` keys; opens in Gephi and yEd |
| `dot` | labels and types as attributes, for Graphviz |
| `html` | one file with the viewer and the data inlined, no network |

`scope=view` exports what the graph view shows: the focused node with its neighbours, or the files (under `prefix`) with the
relationships between them, for the selected relationship `types`. Above 5,000 nodes DOT and HTML use the file level
and the HTML adds each file's declarations as detail.

## Layout

- `server/` — plain `node:http`; `core.ts` is the only file that imports the built core.
- `web/` — Vite + TypeScript browser app.
- `tests/` — server API and export tests (`npm test`); `tests/browser/` is the Playwright smoke test (`npm run test:browser`, needs `npx playwright install chromium`).
  There is no CI job for `ui/` (dropped on purpose), so run `npm run build:core && npm test` in `ui/` after a change to the core's schema or exports. The export golden does not pin the schema number, so a schema bump alone does not break it; other changes to the graph's properties do (`UPDATE_GOLDEN=1 npm test`, then review the diff).

## Docker

The UI can run in a container that stays up; open it in your browser and scan projects from a mounted folder.

```bash
cp .env.example .env     # set WORKSPACE (folder that holds your projects) and CONCENTRATE_TOKEN (openssl rand -hex 24)
docker compose up -d --build
```

Open `http://127.0.0.1:4173/#token=<CONCENTRATE_TOKEN>`. The port is published on `127.0.0.1` only, the token is fixed so the URL survives restarts,
and `WORKSPACE` is mounted read-write at `/workspace` (the folder picker starts there). Graphs are written to `<project>/.concentrate/graph`,
the same place the CLI and `concentrate mcp` read. The container runs as `UID:GID` from your environment (default 1000:1000); on macOS/Linux
export them if the mounted folder is not writable: `UID=$(id -u) GID=$(id -g) docker compose up -d`.
With Colima, run `colima start` first. Stop with `docker compose down`.
Environment: `HOST` (bind address, `0.0.0.0` in the image), `CONCENTRATE_TOKEN`, `PUBLIC_PORT` (port shown in the logged URL).
