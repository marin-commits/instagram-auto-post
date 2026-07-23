const REQUIRED_ENV = [
  "INSTAGRAM_ACCESS_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_BUCKET",
];

for (const name of REQUIRED_ENV) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const {
  INSTAGRAM_ACCESS_TOKEN: INITIAL_INSTAGRAM_ACCESS_TOKEN,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  SUPABASE_BUCKET,
} = process.env;

const SLOT = (process.env.SLOT || "").toUpperCase();
const TARGET_DATE = process.env.TARGET_DATE || "";
const META_API_VERSION = process.env.META_API_VERSION || "v23.0";
const TOKEN_STATE_PATH = "_config/instagram-token.json";
const TOKEN_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const QUEUE_PATH = "_queue/instagram-schedule.json";
const PUBLISHED_STATE_PREFIX = "_published-v2";
const MAX_SCHEDULE_DELAY_MS = 60 * 60 * 1000;
const AUTOMATED_RUN = process.env.AUTOMATED_RUN === "true";
let instagramAccessToken = INITIAL_INSTAGRAM_ACCESS_TOKEN;

if (!["A", "B"].includes(SLOT)) {
  throw new Error("SLOT must be A or B.");
}

function koreanTodayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Date must use YYYY-MM-DD.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const normalized = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
  if (normalized !== value) throw new Error(`Invalid date: ${value}`);
  return date;
}

function targetDate() {
  if (TARGET_DATE) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) {
      throw new Error("TARGET_DATE must use YYYY-MM-DD.");
    }
    const [year, month, day] = TARGET_DATE.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  const { year, month, day } = koreanTodayParts();
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + 1));
}

function dateInfo(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const weekday = date.getUTCDay();
  const pad = (value) => String(value).padStart(2, "0");

  return {
    year,
    month,
    day,
    weekday,
    iso: `${year}-${pad(month)}-${pad(day)}`,
    imagePath: `${String(year).slice(-2)}${pad(month)}/${pad(month)}${pad(day)}${SLOT}.png`,
  };
}

const weekdayLines = {
  0: [
    "여유로운 일요일☀️ 행운 충전 완료!",
    "일요일엔 마음도 운세도 말랑하게🫧",
    "느긋한 일요일🌈 오늘의 행운을 만나봐!",
  ],
  1: [
    "월요일 운세 배달 완료💌",
    "새로운 한 주 시작✨ 월요일 행운도 도착!",
    "월요일도 걱정 말아요🍀 행운이 함께할 거야!",
  ],
  2: [
    "행운이 찾아오는 화요일🍀",
    "화요일의 좋은 기운, 놓치지 말기✨",
    "기분 좋은 화요일🌿 오늘의 행운도 챙겨가자!",
  ],
  3: [
    "거의 다 왔어요🏃 오늘도 화이팅💪",
    "수요일 고비도 행운과 함께 가볍게💫",
    "벌써 수요일! 오늘의 행운으로 힘내보자🍀",
  ],
  4: [
    "조금만 더 힘내요✨ 행운 가득한 목요일!",
    "목요일엔 좋은 일이 슬쩍 찾아올지도🍀",
    "주말이 가까워지는 목요일🌈 행운도 가까이!",
  ],
  5: [
    "기다리던 금요일 도착🎉 좋은 일만 가득하길!",
    "금요일엔 기분 좋은 행운까지 덤으로🎁",
    "드디어 금요일✨ 오늘의 행운도 신나게 출발!",
  ],
  6: [
    "신나는 토요일🌈 행운도 함께 출발!",
    "토요일의 여유와 행운, 둘 다 챙겨가자🍀",
    "기분 좋은 토요일☀️ 오늘은 행운 가득!",
  ],
};

const seasonalLines = {
  spring: [
    "봄바람처럼 기분 좋은 행운이 살랑🌸",
    "몽글몽글 피어나는 봄 행운도 챙겨봐🌷",
    "따스한 봄기운 따라 좋은 일도 성큼🌿",
  ],
  summer: [
    "더위는 잠시 내려놓고 시원한 행운 챙겨가자🌊",
    "뜨거운 햇살만큼 반짝이는 행운이 올 거야☀️",
    "여름날의 기분 좋은 행운 한 조각🍉",
  ],
  autumn: [
    "선선한 바람 따라 행운도 살랑🍂",
    "가을빛처럼 포근한 행운이 찾아올 거야🌰",
    "오늘은 좋은 기운이 차곡차곡 쌓이는 날🍁",
  ],
  winter: [
    "추위는 잠시 잊고 포근한 행운으로 채워봐❄️",
    "겨울바람 사이로 따뜻한 행운이 쏙🧣",
    "오늘은 마음까지 따뜻해지는 행운 한 조각☃️",
  ],
};

function seasonFor(month) {
  if ([3, 4, 5].includes(month)) return "spring";
  if ([6, 7, 8].includes(month)) return "summer";
  if ([9, 10, 11].includes(month)) return "autumn";
  return "winter";
}

function openingFor({ year, month, day, weekday }) {
  const dateSeed = year * 10000 + month * 100 + day;
  const weekdayOptions = weekdayLines[weekday];
  const seasonOptions = seasonalLines[seasonFor(month)];
  const weekdayLine = weekdayOptions[dateSeed % weekdayOptions.length];
  const seasonalLine = seasonOptions[(dateSeed + weekday) % seasonOptions.length];
  return `${weekdayLine}\n${seasonalLine}`;
}

function captionFor({ year, month, day, weekday }) {
  const hashtags =
    SLOT === "A"
      ? "#포스텔러 #오늘의운세 #띠별운세 #띠별오늘의운세 #사주"
      : "#포스텔러 #오늘의운세 #별자리운세 #별자리 #운세";

  return `${openingFor({ year, month, day, weekday })}

하루를 잘 시작할 수 있게 댓글로
‘행복해져라!🪄’를 외쳐보세요!

@forceteller_official 프로필 링크에서 ‘${month}월 운세’ 확인하기!💯

${hashtags}`;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function responseJson(response, label) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function supabaseHeaders(contentType) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

async function readPrivateJson(path) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodePath(path)}`;
  const response = await fetch(url, { headers: supabaseHeaders() });
  if (response.status === 404 || response.status === 400) return null;
  return responseJson(response, `Read private state ${path}`);
}

async function writePrivateJson(path, payload, upsert = true) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodePath(path)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders("application/json"),
      "x-upsert": String(upsert),
    },
    body: JSON.stringify(payload, null, 2),
  });
  return responseJson(response, `Write private state ${path}`);
}

async function listStorage(prefix = "") {
  const url = `${SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(SUPABASE_BUCKET)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders("application/json"),
    body: JSON.stringify({
      prefix,
      limit: 1000,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    }),
  });
  const data = await responseJson(response, `List storage ${prefix || "root"}`);
  return Array.isArray(data) ? data : [];
}

function scheduleForTargetDate(targetDate, slot) {
  const target = parseIsoDate(targetDate);
  const hourUtc = slot === "A" ? 12 : 12;
  const minuteUtc = slot === "A" ? 0 : 30;
  return new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate() - 1,
    hourUtc,
    minuteUtc
  ));
}

async function syncScheduleQueue() {
  const rootEntries = await listStorage();
  const folders = rootEntries
    .map((entry) => entry.name)
    .filter((name) => /^\\d{4}$/.test(name));

  const items = [];
  for (const folder of folders) {
    const files = await listStorage(folder);
    for (const file of files) {
      const match = /^(\\d{2})(\\d{2})([AB])\\.png$/i.exec(file.name);
      if (!match) continue;

      const [, fileMonth, fileDay, rawSlot] = match;
      const folderYear = 2000 + Number(folder.slice(0, 2));
      const folderMonth = folder.slice(2, 4);
      if (fileMonth !== folderMonth) {
        console.warn(`Skipping mismatched path: ${folder}/${file.name}`);
        continue;
      }

      const slot = rawSlot.toUpperCase();
      const targetDate = `${folderYear}-${fileMonth}-${fileDay}`;
      try {
        parseIsoDate(targetDate);
      } catch {
        console.warn(`Skipping invalid date file: ${folder}/${file.name}`);
        continue;
      }

      items.push({
        id: `${targetDate}-${slot}`,
        targetDate,
        slot,
        imagePath: `${folder}/${file.name}`,
        publishAt: scheduleForTargetDate(targetDate, slot).toISOString(),
      });
    }
  }

  items.sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  await writePrivateJson(QUEUE_PATH, {
    timeZone: "Asia/Seoul",
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  });
  console.log(`Schedule queue synced: ${items.length} image(s).`);
  return items;
}

function dueQueueItem(items, slot, now = new Date()) {
  return items.find((item) => {
    if (item.slot !== slot) return false;
    const publishAt = Date.parse(item.publishAt);
    const delay = now.getTime() - publishAt;
    return delay >= 0 && delay <= MAX_SCHEDULE_DELAY_MS;
  });
}

async function prepareInstagramToken() {
  const stored = await readPrivateJson(TOKEN_STATE_PATH);
  if (stored?.accessToken) {
    instagramAccessToken = stored.accessToken;
  }

  const refreshedAt = stored?.refreshedAt ? Date.parse(stored.refreshedAt) : 0;
  const refreshDue =
    !Number.isFinite(refreshedAt) ||
    refreshedAt === 0 ||
    Date.now() - refreshedAt >= TOKEN_REFRESH_INTERVAL_MS;

  if (!refreshDue) {
    console.log("Instagram token refresh is not due yet.");
    return;
  }

  try {
    const query = new URLSearchParams({
      grant_type: "ig_refresh_token",
      access_token: instagramAccessToken,
    });
    const response = await fetch(
      `https://graph.instagram.com/refresh_access_token?${query}`
    );
    const data = await responseJson(response, "Refresh Instagram access token");
    if (!data.access_token) {
      throw new Error("Refresh response did not include access_token.");
    }

    instagramAccessToken = data.access_token;
    await writePrivateJson(TOKEN_STATE_PATH, {
      accessToken: data.access_token,
      refreshedAt: new Date().toISOString(),
      expiresIn: data.expires_in || null,
    });
    console.log("Instagram access token refreshed and stored securely.");
  } catch (error) {
    console.warn(
      `Instagram token refresh was skipped; the current token will be used: ${error.message}`
    );
  }
}

async function alreadyPublished(statePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodePath(statePath)}`;
  const response = await fetch(url, { headers: supabaseHeaders() });
  if (response.status === 404 || response.status === 400) return false;
  if (!response.ok) await responseJson(response, "Check publish state");
  return true;
}

async function createSignedImageUrl(imagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(SUPABASE_BUCKET)}/${encodePath(imagePath)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders("application/json"),
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  const data = await responseJson(response, "Create signed image URL");
  const signedPath = data.signedURL || data.signedUrl || data.signed_url;
  if (!signedPath) throw new Error("Supabase did not return a signed URL.");
  return signedPath.startsWith("http")
    ? signedPath
    : `${SUPABASE_URL}/storage/v1${signedPath}`;
}

async function graphPost(path, values) {
  const body = new URLSearchParams({
    ...values,
    access_token: instagramAccessToken,
  });
  const response = await fetch(
    `https://graph.instagram.com/${META_API_VERSION}/${path}`,
    { method: "POST", body }
  );
  return responseJson(response, `Instagram POST ${path}`);
}

async function graphGet(path, values) {
  const query = new URLSearchParams({
    ...values,
    access_token: instagramAccessToken,
  });
  const response = await fetch(
    `https://graph.instagram.com/${META_API_VERSION}/${path}?${query}`
  );
  return responseJson(response, `Instagram GET ${path}`);
}

async function waitForContainer(containerId) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const data = await graphGet(containerId, { fields: "status_code,status" });
    if (data.status_code === "FINISHED") return;
    if (["ERROR", "EXPIRED"].includes(data.status_code)) {
      throw new Error(`Instagram container ${data.status_code}: ${data.status || "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Instagram image processing timed out.");
}

async function savePublishedState(statePath, payload) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodePath(statePath)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders("application/json"),
      "x-upsert": "false",
    },
    body: JSON.stringify(payload, null, 2),
  });
  await responseJson(response, "Save publish state");
}

async function main() {
  await prepareInstagramToken();

  let info;
  if (AUTOMATED_RUN) {
    const queue = await syncScheduleQueue();
    const due = dueQueueItem(queue, SLOT);
    if (!due) {
      console.log(`No due ${SLOT} post within the 60-minute safety window; skipping.`);
      return;
    }
    info = dateInfo(parseIsoDate(due.targetDate));
    if (info.imagePath !== due.imagePath) {
      throw new Error(`Queue path mismatch: ${due.imagePath} !== ${info.imagePath}`);
    }
  } else {
    info = dateInfo(targetDate());
  }
  const statePath = `${PUBLISHED_STATE_PREFIX}/${info.iso}-${SLOT}.json`;

  const testPublish = process.env.TEST_PUBLISH === "true";

  if (!testPublish && await alreadyPublished(statePath)) {
    console.log(`Already published; skipping ${info.iso} ${SLOT}.`);
    return;
  }

  console.log(`Preparing ${info.iso} ${SLOT}: ${info.imagePath}`);
  const imageUrl = await createSignedImageUrl(info.imagePath);
  const caption = captionFor(info);

  const account = await graphGet("me", { fields: "user_id,username" });
  const instagramUserId = account.user_id || account.id;
  if (!instagramUserId) {
    throw new Error("Instagram /me did not return user_id.");
  }

  if (process.env.DRY_RUN === "true") {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Signed image check failed (${imageResponse.status}).`);
    }
    const contentType = imageResponse.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      throw new Error(`Expected an image but received: ${contentType || "unknown"}`);
    }
    console.log(`Dry run successful for @${account.username || "unknown"} (ID: ${instagramUserId}).`);
    console.log(`Caption preview:\n${caption}`);
    return;
  }

  const container = await graphPost(`${instagramUserId}/media`, {
    image_url: imageUrl,
    caption,
  });
  if (!container.id) throw new Error("Instagram did not return a container ID.");

  await waitForContainer(container.id);

  const published = await graphPost(`${instagramUserId}/media_publish`, {
    creation_id: container.id,
  });
  if (!published.id) throw new Error("Instagram did not return a media ID.");

  if (!testPublish) {
    await savePublishedState(statePath, {
      targetDate: info.iso,
      slot: SLOT,
      imagePath: info.imagePath,
      mediaId: published.id,
      publishedAt: new Date().toISOString(),
    });
  } else {
    console.log("Test publish mode: duplicate-prevention state was not saved.");
  }

  console.log(`Published successfully: ${published.id}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
