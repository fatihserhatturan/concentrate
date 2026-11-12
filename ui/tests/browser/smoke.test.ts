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
    await page.getByTestId("primary-action").click();
    await page.getByTestId("open-graph").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("scan-report").textContent() ?? "", /Scan complete/);

    await page.getByTestId("open-graph").click();
    await page.getByRole("heading", { name: "Most connected files" }).waitFor({ timeout: 30_000 });
    assert.match(page.url(), /project=/, "the project is in the URL");

    // Views with rows are in the navigation; a row opens the inspector, which offers the graph.
    await page.getByRole("button", { name: /^Routes/ }).click();
    await page.locator("table.data tbody tr").first().waitFor();
    await page.locator("table.data tbody tr").first().click();
    await page.getByRole("button", { name: "Show in graph" }).waitFor({ timeout: 15_000 });
    assert.match(page.url(), /view=routes&focus=/, "the selection is in the URL");
    await page.getByRole("button", { name: "Show in graph" }).click();
    await page.waitForFunction(() => /^[1-9]\d* nodes/.test(document.querySelector("#stats")?.textContent ?? ""), null, { timeout: 30_000 });
    assert.ok((await page.locator("canvas").count()) > 0, "the graph is drawn on a canvas");
    assert.match(page.url(), /view=graph&focus=/);

    // Back returns to the routes table.
    await page.goBack();
    await page.locator("table.data tbody tr").first().waitFor();

    await page.getByRole("button", { name: /^Graph/ }).click();
    await page.waitForFunction(() => /^[1-9]\d* nodes/.test(document.querySelector("#stats")?.textContent ?? ""), null, { timeout: 30_000 });

    await page.click("#export");
    await page.selectOption("#fmt", "json");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    assert.match(download.suggestedFilename(), /project-graph\.json$/);
    const file = await download.path();
    const body = JSON.parse(await readFile(file, "utf8"));
    assert.ok(body.nodes.length > 0 && body.relationships.length > 0);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
