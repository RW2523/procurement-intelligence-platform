import { chromium } from "playwright";
import { mkdirSync } from "fs";

const base = "http://localhost:3000";
const fleet = "1c422087-587f-46d0-8f70-8bf898df750e";
mkdirSync("/tmp/shots", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function shot(name, path, opts = {}) {
  await page.goto(base + path, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(opts.wait ?? 1400);
  if (opts.scrollTo) {
    const el = page.locator(opts.scrollTo).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `/tmp/shots/${name}.png` });
  console.log("shot", name);
}

await shot("dashboard", "/");
await shot("opportunities", "/opportunities");
await shot("detail", `/opportunities/${fleet}`);
await shot("workspace", `/opportunities/${fleet}`, { scrollTo: "text=Response workspace", wait: 1600 });
await shot("board", "/board");
await shot("analytics", "/analytics", { wait: 2200 });
await shot("sources", "/sources");
await shot("notifications", "/notifications");

await browser.close();
console.log("done");
