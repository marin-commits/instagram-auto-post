import { chromium } from "playwright";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SITE = "https://event.forceteller.com/outsourced";
const BUCKET = process.env.SUPABASE_BUCKET || "insta-images";
const DRY_RUN = process.env.DRY_RUN === "true";
const VERIFY_EXISTING = process.env.VERIFY_EXISTING === "true";
const SAMPLE_DIR = process.env.COMPARE_SAMPLE_DIR || "";
const SCHEDULED = process.env.GITHUB_EVENT_NAME === "schedule";
const MIN_BYTES = 100000;
const MAX_BYTES = 10000000;
// Downscaled grayscale comparison. Renders of the same text on the same OS differ only by
// anti-aliasing; a different date/sign changes whole text lines.
const CMP_WIDTH = 270;
const CMP_HEIGHT = 338;
// Measured 2026-10: same content on macOS <= 0.10 mean / 0.00%; next day's image 10.2 / 8.8%;
// one changed text line is roughly 0.15% of pixels.
const SAME_MAX_MEAN = 0.5;       // mean absolute difference (0-255)
const SAME_MAX_CHANGED = 0.0003; // share of pixels differing by more than 48

const pad = (value) => String(value).padStart(2, "0");

function koreaParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
}

const today = koreaParts();
const nextMonthStart = new Date(Date.UTC(Number(today.year), Number(today.month), 1));
const target = { year: nextMonthStart.getUTCFullYear(), month: nextMonthStart.getUTCMonth() + 1 };
const expectedMonth = `${target.year}-${pad(target.month)}`;
const daysInMonth = new Date(Date.UTC(target.year, target.month, 0)).getUTCDate();
const folder = `${String(target.year).slice(-2)}${pad(target.month)}`;
// The site may label months with or without a leading zero ("1월" / "01월").
const monthLabel = `0?${target.month}월`;
const slotLabel = (slot) => (slot === "A" ? "띠별" : "별자리");
const describe = (name) => `${Number(name.slice(0, 2))}/${Number(name.slice(2, 4))} ${slotLabel(name[4])}(${name[4]})`;

const expected = new Map();
for (let day = 1; day <= daysInMonth; day += 1) {
  for (const slot of ["A", "B"]) {
    const name = `${pad(target.month)}${pad(day)}${slot}.png`;
    expected.set(name, { day, slot, path: `${folder}/${name}` });
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
    throw new Error(`${label} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

async function listFolder() {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(BUCKET)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: storageHeaders("application/json"),
    body: JSON.stringify({ prefix: folder, limit: 1000, offset: 0 }),
  });
  const entries = await (await checked(response, "List monthly storage")).json();
  if (!Array.isArray(entries)) throw new Error("Storage list was not an array");
  return new Map(entries.filter((item) => item.id).map((item) => [item.name, item]));
}

function inspectStored(entries) {
  const present = [];
  const missing = [];
  const broken = [];
  for (const name of expected.keys()) {
    const item = entries.get(name);
    if (!item) {
      missing.push(name);
      continue;
    }
    const size = Number(item.metadata?.size || 0);
    const mimetype = item.metadata?.mimetype || "";
    if (size < MIN_BYTES || size > MAX_BYTES || (mimetype && mimetype !== "image/png")) {
      broken.push(`${name}(${size}B ${mimetype || "?"})`);
    }
    present.push(name);
  }
  const extras = [...entries.keys()].filter((name) => !expected.has(name) && !name.startsWith("."));
  return { present, missing, broken, extras };
}

async function downloadStored(path) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/authenticated/${encodeURIComponent(BUCKET)}/${path}`;
  const response = await fetch(url, { headers: storageHeaders() });
  return Buffer.from(await (await checked(response, `Download existing ${path}`)).arrayBuffer());
}

async function downloadZip(page, slot, tempDir) {
  const category = slot === "A" ? "띠별 운세" : "별자리 운세";
  await page.getByRole("button", { name: category, exact: true }).click();
  // The page resets the month whenever a category is selected.
  await page.getByRole("button", { name: "다음 달", exact: true }).click();
  // Confirms the page really shows next month before downloading.
  await page.getByText(new RegExp(`^${monthLabel} 01일 ${category}$`)).first().waitFor({ timeout: 30000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 300000 }),
    page.getByRole("button", { name: "전체 이미지 다운로드 받기" }).click(),
  ]);
  const destination = join(tempDir, `${slot}.zip`);
  await download.saveAs(destination);
  const failure = await download.failure();
  if (failure) throw new Error(`${category} ZIP 다운로드 실패: ${failure}`);
  console.log(`Downloaded ${category}: ${download.suggestedFilename()}`);
  return destination;
}

async function parseZip(zipPath, slot) {
  const label = slot === "A" ? "띠별운세" : "별자리운세";
  const files = unzipSync(new Uint8Array(await readFile(zipPath)));
  const output = new Map();
  const hashes = new Set();
  const pattern = new RegExp(`^${monthLabel}(\\d{2})일_${label}\\.png$`);
  for (const [entryName, bytes] of Object.entries(files)) {
    if (entryName.endsWith("/")) continue;
    const match = pattern.exec(entryName);
    if (!match) throw new Error(`${label} ZIP에 예상과 다른 파일: ${entryName}`);
    const day = Number(match[1]);
    if (day < 1 || day > daysInMonth) throw new Error(`${label} ZIP 날짜 범위 오류: ${entryName}`);
    const name = `${pad(target.month)}${pad(day)}${slot}.png`;
    const buffer = Buffer.from(bytes);
    const metadata = await sharp(buffer).metadata();
    if (metadata.format !== "png" || metadata.width !== 1080 || metadata.height !== 1350 ||
        buffer.length < MIN_BYTES || buffer.length > MAX_BYTES) {
      throw new Error(`PNG 형식/크기 오류: ${entryName} (${metadata.format} ${metadata.width}x${metadata.height}, ${buffer.length}B)`);
    }
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (hashes.has(hash)) throw new Error(`${label} ZIP에 중복 이미지: ${entryName}`);
    hashes.add(hash);
    if (output.has(name)) throw new Error(`${label} ZIP에 중복 날짜: ${entryName}`);
    output.set(name, buffer);
  }
  if (output.size !== daysInMonth) {
    throw new Error(`${label} ZIP 이미지 ${output.size}장, 기대 ${daysInMonth}장`);
  }
  return output;
}

async function comparable(buffer) {
  return sharp(buffer)
    .flatten({ background: "#ffffff" })
    .resize(CMP_WIDTH, CMP_HEIGHT, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
}

async function compareImages(source, stored) {
  if (source.equals(stored)) return { same: true, exact: true, mean: 0, changed: 0 };
  const [a, b] = await Promise.all([comparable(source), comparable(stored)]);
  let total = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = Math.abs(a[i] - b[i]);
    total += delta;
    if (delta > 48) changed += 1;
  }
  const mean = total / a.length;
  const share = changed / a.length;
  return { same: mean <= SAME_MAX_MEAN && share <= SAME_MAX_CHANGED, exact: false, mean, changed: share };
}

async function notify(text) {
  const response = await fetch(process.env.SLACK_WEBHOOK_URL.trim(), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  });
  await checked(response, "Slack notification");
}

// Success alerts go to Slack only on the 1st (KST); other days log only. Failures always alert.
async function notifySuccess(text) {
  if (today.day !== "01") {
    console.log(`Slack 성공 알림 생략(매월 1일만 발송): ${today.month}/${today.day}`);
    return;
  }
  await notify(text);
}

async function summary(lines) {
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n\n")}\n`);
  }
}

async function main() {
  for (const key of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SLACK_WEBHOOK_URL"]) {
    if (!process.env[key]) throw new Error(`환경 변수 ${key} 없음`);
  }
  const mode = DRY_RUN ? " [점검 실행·업로드 안 함]" : (SCHEDULED && today.day === "02" ? " [2일 재확인]" : "");
  const before = await listFolder();
  const initial = inspectStored(before);
  if (initial.broken.length) {
    throw new Error(`손상 의심 기존 파일 ${initial.broken.length}장(덮어쓰지 않음): ${initial.broken.join(", ")}`);
  }

  if (!DRY_RUN && !VERIFY_EXISTING && initial.missing.length === 0) {
    const text = `✅ ${expectedMonth} 운세 이미지${mode}: 신규 업로드 0장 — ${folder}/ 에 ${expected.size}장(띠별 ${daysInMonth} + 별자리 ${daysInMonth})이 이미 모두 있음. 기존 파일 유지, 사이트 재다운로드·내용 비교는 하지 않음.`;
    await summary([text]);
    await notifySuccess(text);
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
    if (images.size !== expected.size) throw new Error(`원본 ${images.size}장, 기대 ${expected.size}장`);

    const report = [];
    if (VERIFY_EXISTING) {
      const mismatches = [];
      let exact = 0;
      let similar = 0;
      if (SAMPLE_DIR) await mkdir(SAMPLE_DIR, { recursive: true });
      for (const [name, { path }] of expected) {
        if (!before.has(name)) continue;
        const stored = await downloadStored(path);
        const result = await compareImages(images.get(name), stored);
        console.log(`${path}: ${result.exact ? "exact" : `mean ${result.mean.toFixed(2)}, changed ${(result.changed * 100).toFixed(3)}%`} → ${result.same ? "same" : "DIFFERENT"}`);
        if (result.exact) exact += 1;
        else if (result.same) similar += 1;
        else mismatches.push(name);
        if (SAMPLE_DIR && (!result.same || name.startsWith(`${pad(target.month)}01`))) {
          await writeFile(join(SAMPLE_DIR, `${name.replace(".png", "")}-source.png`), images.get(name));
          await writeFile(join(SAMPLE_DIR, `${name.replace(".png", "")}-stored.png`), stored);
        }
      }
      if (mismatches.length) {
        throw new Error(`원본과 다른 기존 이미지 ${mismatches.length}장: ${mismatches.map(describe).join(", ")}`);
      }
      report.push(`기존 ${exact + similar}장 원본 대조 일치(완전 동일 ${exact}, 렌더링 미세차 ${similar})`);
    }

    let uploaded = 0;
    let kept = 0;
    const wouldUpload = [];
    for (const [name, { path }] of expected) {
      if (before.has(name)) {
        kept += 1;
        continue;
      }
      if (DRY_RUN) {
        wouldUpload.push(path);
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
      // Never replace an existing image (manual fixes stay as they are).
      if (response.status === 409 || (response.status === 400 && /already exists|Duplicate/i.test(await response.clone().text()))) {
        kept += 1;
        continue;
      }
      await checked(response, `Upload ${path}`);
      uploaded += 1;
    }
    if (wouldUpload.length) console.log(`Would upload ${wouldUpload.length}: ${wouldUpload.join(", ")}`);

    const after = inspectStored(await listFolder());
    if (!DRY_RUN && (after.missing.length || after.broken.length)) {
      throw new Error(`업로드 후 검증 실패: 누락 ${after.missing.length}장 ${after.missing.slice(0, 5).map(describe).join(", ")} / 손상 ${after.broken.length}장`);
    }
    const counts = DRY_RUN
      ? `원본 ${images.size}장 검사 통과, 업로드 예정 ${wouldUpload.length}장, 기존 ${kept}장`
      : `신규 업로드 ${uploaded}장, 기존 유지 ${kept}장 → ${folder}/ 에 ${after.present.length}/${expected.size}장 확인`;
    const zeroNote = !DRY_RUN && uploaded === 0 ? " (신규 업로드 0장: 필요한 파일이 이미 모두 있었음)" : "";
    const extraNote = after.extras.length ? ` ⚠️ 규칙 밖 파일 ${after.extras.length}개: ${after.extras.slice(0, 5).join(", ")}` : "";
    const text = `✅ ${expectedMonth} 운세 이미지${mode}: ${counts}${zeroNote}${report.length ? `, ${report.join(", ")}` : ""}${extraNote}`;
    await summary([text]);
    await notifySuccess(text);
  } finally {
    await browser?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(error);
  const mode = DRY_RUN ? " [점검 실행]" : "";
  const text = `❌ ${expectedMonth} 운세 이미지 준비 실패${mode}: ${String(error.message).slice(0, 600)}`;
  try {
    await summary([text]);
    if (process.env.SLACK_WEBHOOK_URL) await notify(text);
  } catch (notifyError) {
    console.error(`Slack 실패 알림도 실패: ${notifyError.message}`);
  }
  process.exitCode = 1;
});
