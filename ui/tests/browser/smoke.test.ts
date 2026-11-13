import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createUiServer } from "../../server/index.js";

// Needs the built web app (`npm run build:web`) and Chromium (`npx playwright install chromium`).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "smoke-token";
let server: ReturnType<typeof createUiServer>;
let browser: Browser;
let base: string;
let work: string;

before(async () => {
  assert.ok(existsSync(path.join(HERE, "..", "..", "web", "dist", "index.html")), "run `npm run build:web` first");
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-smoke-"));
  await cp(path.join(HERE, "..", "..", "..", "fixtures", "express-koa-routes"), path.join(work, "project"), { recursive: true });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server.close();
  await rm(work, { recursive: true, force: true });
});

describe("browser smoke", () => {
  it("scans a fixture, shows nodes and downloads an export", async () => {
    const page = await browser.newPage({ acceptDownloads: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/#token=${TOKEN}`);

    await page.getByTestId("path").fill(path.join(work, "project"));
    await page.getByTestId("path").press("Enter");
    await page.waitForFunction(() => /project/.test(document.querySelector(".current h3")?.textContent ?? ""));
    // The fixture has no git repository or manifest: the first click only asks.
    await page.getByTestId("primary-action").click();
    await page.getByTestId("not-a-project").waitFor();
    assert.equal(await page.getByTestId("scan-progress").count(), 0, "nothing was scanned yet");
    await page.getByTestId("primary-action").click();
    await page.getByTestId("open-graph").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("scan-report").textContent() ?? "", /Scan complete/);

    await page.getByTestId("open-graph").click();
    await page.getByRole("heading", { name: "Most connected files" }).waitFor({ timeout: 30_000 });
    assert.match(page.url(), /project=/, "the project is in the URL");

    // ? lists the shortcuts and Esc closes the sheet.
    await page.keyboard.press("?");
    await page.getByRole("heading", { name: "Keyboard shortcuts" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Keyboard shortcuts" }).waitFor({ state: "hidden" });

    // The command palette goes anywhere: Ctrl+K, type, Enter.
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    await page.keyboard.type("routes");
    await page.getByRole("option", { name: /Go to Routes/ }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "hidden" });
    assert.match(page.url(), /view=routes/, "the palette navigated");

    // A row opens the inspector, which offers the graph.
    await page.locator("table.data tbody tr").first().waitFor();
    await page.locator("table.data tbody tr").first().click();
    await page.getByRole("button", { name: "Show in graph" }).waitFor({ timeout: 15_000 });
    assert.match(page.url(), /view=routes&focus=/, "the selection is in the URL");
    await page.getByRole("button", { name: "Show in graph" }).click();
    await page.waitForFunction(() => /^[1-9]\d* nodes/.test(document.querySelector("[data-testid=graph-stats]")?.textContent ?? ""), null, { timeout: 30_000 });
    await page.locator("svg.layered g.node.center").waitFor({ timeout: 15_000 });
    assert.match(page.url(), /view=graph&focus=/);

    // Arrow keys move between neighbouring nodes (when there are any); Enter refocuses on one.
    const drawn = await page.locator("svg.layered g.node").count();
    await page.locator("svg.layered g.node.center").focus();
    await page.keyboard.press("ArrowRight");
    if (drawn > 1) assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("center")), false, "the keyboard focus moved off the focused node");

    // f fits the view, Esc steps back out of the focus to the overview.
    await page.keyboard.press("f");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !location.search.includes("focus="));
    assert.match(page.url(), /view=graph/);
    await page.waitForSelector(".graph-body canvas, .graph-empty", { timeout: 30_000 });

    // Back returns to the focus, and back again to the routes table.
    await page.goBack();
    await page.locator("svg.layered g.node.center").waitFor();
    await page.goBack();
    await page.locator("table.data tbody tr").first().waitFor();

    await page.getByRole("button", { name: /^Graph/ }).click();
    await page.waitForSelector(".graph-body canvas, .graph-empty", { timeout: 30_000 });

    await page.getByRole("button", { name: "Export…" }).click();
    await page.selectOption("#export-format", "json");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-download").click()]);
    assert.match(download.suggestedFilename(), /project-graph\.json$/);
    const file = await download.path();
    const body = JSON.parse(await readFile(file, "utf8"));
    assert.ok(body.nodes.length > 0 && body.relationships.length > 0);

    // A folder without a graph gets a designed empty state, not a blank view.
    await page.goto(`${base}/?project=${encodeURIComponent(work)}`);
    await page.getByRole("heading", { name: "No graph for this project yet" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Scan this project" }).waitFor();

    assert.deepEqual(errors, []);
    await page.close();
  });
});
