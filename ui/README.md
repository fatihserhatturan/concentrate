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

The server binds to `127.0.0.1` on a random port (`PORT=4000` to choose one, `NO_OPEN=1` to keep the browser closed).
The URL carries a random token for this start; every API call needs it, and requests whose `Host` is not `127.0.0.1` / `localhost` are refused.

The scan writes `<project>/.concentrate/graph`, the CLI default, so `concentrate mcp` and `concentrate query` read the same graph.

## Status

Phase 1 of #252: the core entry point (`src/api.ts`), the server with `GET /api/fs` and `POST /api/scan` (server-sent progress), and the scan view.
The graph view and exports follow.

## Layout

- `server/` — plain `node:http`; `core.ts` is the only file that imports the built core.
- `web/` — Vite + TypeScript browser app.
- `tests/` — server API tests (`npm test`).
