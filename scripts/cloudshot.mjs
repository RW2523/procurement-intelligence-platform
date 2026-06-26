import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = process.env.CLOUD_URL || "https://pocu-wheat.vercel.app";
mkdirSync("/tmp/shots", { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  httpCredentials: { username: "admin", password: process.env.SITE_PASSWORD || "ajace-demo" },
});
const page = await ctx.newPage();

for (const [name, path] of [
  ["cloud-dashboard", "/"],
  ["cloud-analytics", "/analytics"],
]) {
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(name.includes("analytics") ? 2200 : 1400);
  await page.screenshot({ path: `/tmp/shots/${name}.png` });
  console.log("shot", name);
}
await browser.close();
console.log("done");
