# Instagram Auto Post

Supabase 비공개 Storage의 오늘의 운세 이미지를 Instagram 피드에 자동 게시합니다.

## 게시 일정 (Asia/Seoul)

- 매일 21:00: 다음 날 띠별운세 `A`
- 매일 21:30: 다음 날 별자리운세 `B`

GitHub Actions cron은 UTC 기준으로 각각 12:00, 12:30에 실행됩니다. GitHub 사정에 따라 실제 실행이 몇 분 지연될 수 있습니다.

## 이미지 파일 규칙

버킷: `insta-images`

경로: `YYMM/MMDD{A|B}.png`

예시:

- 2026-07-24 띠별운세: `2607/0724A.png`
- 2026-07-24 별자리운세: `2607/0724B.png`

## 필요한 GitHub Actions Secrets

Repository Settings → Secrets and variables → Actions에 등록합니다.

- `INSTAGRAM_ACCESS_TOKEN`
- `INSTAGRAM_USER_ID`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_BUCKET` (현재 값: `insta-images`)

## 수동 테스트

Actions → Instagram Auto Post → Run workflow에서 게시 종류와 대상 날짜를 선택합니다.

주의: 수동 실행도 실제 Instagram 피드에 게시됩니다. 같은 날짜/종류가 이미 성공했다면 중복 게시 방지 상태 파일 때문에 건너뜁니다.
