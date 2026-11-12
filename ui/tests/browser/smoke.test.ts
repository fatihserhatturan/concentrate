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

    await page.fill("#path", path.join(work, "project"));
    await page.click("#scan");
    await page.waitForSelector("#view", { timeout: 60_000 });
    assert.match(await page.textContent("#report") ?? "", /Scan complete/);

    await page.click("#view");
    await page.waitForFunction(() => /^[1-9]\d* nodes/.test(document.querySelector("#stats")?.textContent ?? ""), null, { timeout: 30_000 });
    assert.ok((await page.locator("canvas").count()) > 0, "the graph is drawn on a canvas");

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
