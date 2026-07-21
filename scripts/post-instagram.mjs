const REQUIRED_ENV = [
  "INSTAGRAM_ACCESS_TOKEN",
  "INSTAGRAM_USER_ID",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_BUCKET",
];

for (const name of REQUIRED_ENV) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const {
  INSTAGRAM_ACCESS_TOKEN,
  INSTAGRAM_USER_ID,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  SUPABASE_BUCKET,
} = process.env;

const SLOT = (process.env.SLOT || "").toUpperCase();
const TARGET_DATE = process.env.TARGET_DATE || "";
const META_API_VERSION = process.env.META_API_VERSION || "v23.0";

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
  0: "여유로운 일요일☀️ 행운 충전 완료!",
  1: "월요일 운세 배달 완료💌",
  2: "행운이 찾아오는 화요일🍀",
  3: "거의 다 왔어요🏃 오늘도 화이팅💪",
  4: "조금만 더 힘내요✨ 행운 가득한 목요일!",
  5: "기다리던 금요일 도착🎉 좋은 일만 가득하길!",
  6: "신나는 토요일🌈 행운도 함께 출발!",
};

function captionFor({ month, weekday }) {
  const hashtags =
    SLOT === "A"
      ? "#포스텔러 #오늘의운세 #띠별운세 #띠별오늘의운세 #사주"
      : "#포스텔러 #오늘의운세 #별자리운세 #별자리 #운세";

  return `${weekdayLines[weekday]}

포스텔러 사주 풀이 보시고🍀 명쾌한 해답을 얻어 가세요😆

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
    access_token: INSTAGRAM_ACCESS_TOKEN,
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
    access_token: INSTAGRAM_ACCESS_TOKEN,
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
  const info = dateInfo(targetDate());
  const statePath = `_published/${info.iso}-${SLOT}.json`;

  if (await alreadyPublished(statePath)) {
    console.log(`Already published; skipping ${info.iso} ${SLOT}.`);
    return;
  }

  console.log(`Preparing ${info.iso} ${SLOT}: ${info.imagePath}`);
  const imageUrl = await createSignedImageUrl(info.imagePath);
  const caption = captionFor(info);

  const container = await graphPost(`${INSTAGRAM_USER_ID}/media`, {
    image_url: imageUrl,
    caption,
  });
  if (!container.id) throw new Error("Instagram did not return a container ID.");

  await waitForContainer(container.id);

  const published = await graphPost(`${INSTAGRAM_USER_ID}/media_publish`, {
    creation_id: container.id,
  });
  if (!published.id) throw new Error("Instagram did not return a media ID.");

  await savePublishedState(statePath, {
    targetDate: info.iso,
    slot: SLOT,
    imagePath: info.imagePath,
    mediaId: published.id,
    publishedAt: new Date().toISOString(),
  });

  console.log(`Published successfully: ${published.id}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
