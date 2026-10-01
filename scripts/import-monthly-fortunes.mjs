import { chromium } from "playwright";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SITE = "https://event.forceteller.com/outsourced";
const BUCKET = process.env.SUPABASE_BUCKET || "insta-images";
const DRY_RUN = process.env.DRY_RUN === "true";
const REQUIRED = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"];
for (const key of REQUIRED) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}

function nextMonthInKorea() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const now = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

const target = nextMonthInKorea();
const expectedMonth = `${target.year}-${String(target.month).padStart(2, "0")}`;
if (process.env.TARGET_MONTH && process.env.TARGET_MONTH !== expectedMonth) {
  throw new Error(`Site only exposes the next month (${expectedMonth}); requested ${process.env.TARGET_MONTH}`);
}
const daysInMonth = new Date(Date.UTC(target.year, target.month, 0)).getUTCDate();
const pad = (value) => String(value).padStart(2, "0");
const folder = `${String(target.year).slice(-2)}${pad(target.month)}`;
const expected = new Map();
for (let day = 1; day <= daysInMonth; day += 1) {
  for (const slot of ["A", "B"]) {
    const key = `${pad(target.month)}${pad(day)}${slot}.png`;
    expected.set(key, { day, slot, path: `${folder}/${key}` });
  }
}

function storageHeaders(contentType) {
  return {
    apikey: process.env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

async function checked(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  return response;
}

async function existingNames() {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(BUCKET)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: storageHeaders("application/json"),
    body: JSON.stringify({ prefix: folder, limit: 1000, offset: 0 }),
  });
  const entries = await (await checked(response, "List monthly storage")).json();
  if (!Array.isArray(entries)) throw new Error("Storage list was not an array");
  return new Set(entries.map((item) => item.name));
}

async function downloadZip(page, slot, tempDir) {
  const category = slot === "A" ? "띠별 운세" : "별자리 운세";
  await page.getByRole("button", { name: category, exact: true }).click();
  // The page resets the month whenever a category is selected.
  await page.getByRole("button", { name: "다음 달", exact: true }).click();
  await page.getByText(`${target.month}월 01일 ${category}`, { exact: true }).first().waitFor({ timeout: 30000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 300000 }),
    page.getByRole("button", { name: "전체 이미지 다운로드 받기" }).click(),
  ]);
  const destination = join(tempDir, `${slot}.zip`);
  await download.saveAs(destination);
  const failure = await download.failure();
  if (failure) throw new Error(`Download ${slot} failed: ${failure}`);
  console.log(`Downloaded ${category}: ${download.suggestedFilename()}`);
  return destination;
}

async function parseZip(zipPath, slot) {
  const label = slot === "A" ? "띠별운세" : "별자리운세";
  const files = unzipSync(new Uint8Array(await readFile(zipPath)));
  const output = new Map();
  const hashes = new Set();
  const pattern = new RegExp(`^${pad(target.month)}월(\\d{2})일_${label}\\.png$`);
  for (const [name, bytes] of Object.entries(files)) {
    const match = pattern.exec(name);
    if (!match) throw new Error(`Unexpected ${slot} ZIP entry: ${name}`);
    const day = Number(match[1]);
    if (day < 1 || day > daysInMonth) throw new Error(`Out-of-range date in ZIP: ${name}`);
    const key = `${pad(target.month)}${pad(day)}${slot}.png`;
    const buffer = Buffer.from(bytes);
    const metadata = await sharp(buffer).metadata();
    if (metadata.format !== "png" || metadata.width !== 1080 || metadata.height !== 1350 ||
        buffer.length < 100000 || buffer.length > 10000000) {
      throw new Error(`Invalid PNG dimensions/format/size: ${name}`);
    }
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (hashes.has(hash)) throw new Error(`Duplicate image in ${slot} ZIP: ${name}`);
    hashes.add(hash);
    if (output.has(key)) throw new Error(`Duplicate filename in ${slot} ZIP: ${name}`);
    output.set(key, buffer);
  }
  if (output.size !== daysInMonth) {
    throw new Error(`${slot} ZIP has ${output.size} images; expected ${daysInMonth}`);
  }
  return output;
}

async function notify(text) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  try {
    const response = await fetch(process.env.SLACK_WEBHOOK_URL.trim(), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    });
    await checked(response, "Slack notification");
  } catch (error) {
    console.warn(`Slack notification failed: ${error.message}`);
  }
}

async function main() {
  const before = await existingNames();
  if ([...expected.keys()].every((name) => before.has(name))) {
    console.log(`${expectedMonth}: all ${expected.size} images already exist; no download needed.`);
    return;
  }
  const tempDir = await mkdtemp(join(tmpdir(), "fortune-month-"));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1365, height: 900 } });
    page.setDefaultTimeout(30000);
    await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });
    const images = new Map();
    for (const slot of ["A", "B"]) {
      const archive = await downloadZip(page, slot, tempDir);
      for (const [name, buffer] of await parseZip(archive, slot)) images.set(name, buffer);
    }
    if (images.size !== expected.size) throw new Error(`Expected ${expected.size} images, got ${images.size}`);
    const existing = before;
    let uploaded = 0;
    let skipped = 0;
    for (const [name, { path }] of expected) {
      if (existing.has(name)) {
        skipped += 1;
        continue;
      }
      if (DRY_RUN) {
        console.log(`Would upload ${path}`);
        continue;
      }
      const response = await fetch(
        `${process.env.SUPABASE_URL}/storage/v1/object/${encodeURIComponent(BUCKET)}/${path}`,
        {
          method: "POST",
          headers: { ...storageHeaders("image/png"), "x-upsert": "false", "Cache-Control": "no-store" },
          body: images.get(name),
        },
      );
      // A concurrent/manual upload is safe: never replace an existing image.
      if (response.status === 409 || (response.status === 400 && /already exists/i.test(await response.clone().text()))) {
        skipped += 1;
        continue;
      }
      await checked(response, `Upload ${path}`);
      uploaded += 1;
    }
    const result = await existingNames();
    const missing = [...expected.keys()].filter((name) => !result.has(name));
    if (!DRY_RUN && missing.length) throw new Error(`Upload incomplete: ${missing.length} missing, e.g. ${missing.slice(0, 3).join(", ")}`);
    const summary = `${expectedMonth} 띠별·별자리 운세: ${uploaded}장 업로드, ${skipped}장 기존 파일 유지${DRY_RUN ? " (점검 실행)" : ""}`;
    console.log(summary);
    await notify(`✅ ${summary}`);
  } finally {
    await browser?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(error);
  await notify(`❌ ${expectedMonth} 운세 이미지 준비 실패: ${error.message.slice(0, 300)}`);
  process.exitCode = 1;
});
