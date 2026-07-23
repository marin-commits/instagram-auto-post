# Instagram Auto Post

Supabase 비공개 Storage에 이미지를 일괄 업로드하면 파일명에서 게시 날짜와 종류를 읽어 Instagram 예약표를 자동 생성하고 게시합니다.

## 게시 일정 (Asia/Seoul)

- `MMDD A`: 해당 날짜 전날 21:00에 띠별운세 게시
- `MMDD B`: 해당 날짜 전날 21:30에 별자리운세 게시

예: `2607/0724A.png`는 2026-07-23 21:00, `2607/0724B.png`는 21:30에 게시됩니다.

GitHub Actions cron은 UTC 12:00/12:30에 실행됩니다. 실행될 때마다 버킷 파일 전체를 읽어 `_queue/instagram-schedule.json`을 자동 갱신합니다. 예약보다 60분 이상 늦게 시작된 작업은 새벽 오게시 방지를 위해 게시하지 않습니다.

## 이미지 일괄 업로드 규칙

버킷: `insta-images`

경로: `YYMM/MMDD{A|B}.png`

- 2026-07-24 띠별운세: `2607/0724A.png`
- 2026-07-24 별자리운세: `2607/0724B.png`

두 달치 이미지를 한 번에 올려도 됩니다. 별도 예약 입력은 필요하지 않으며, 다음 자동 실행에서 파일명이 예약표에 반영됩니다. 파일명이 규칙과 다르거나 폴더 월과 파일 월이 다르면 안전하게 제외됩니다.

## 중복 및 지연 방지

성공한 게시물은 `_published-v2/YYYY-MM-DD-{A|B}.json`으로 기록되어 다시 게시되지 않습니다. 예약 실행이 60분 이상 지연되면 게시를 건너뜁니다.

## 필요한 GitHub Actions Secrets

Repository Settings → Secrets and variables → Actions:

- `INSTAGRAM_ACCESS_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_BUCKET` (현재 값: `insta-images`)

## Instagram 토큰 자동 갱신

최초 토큰은 `INSTAGRAM_ACCESS_TOKEN` Secret에서 읽습니다. 이후 7일마다 Meta 갱신 API를 호출하고 최신 토큰을 비공개 Supabase 경로 `_config/instagram-token.json`에 저장합니다.

계정 비밀번호 변경, 앱 권한 해제 또는 Meta의 강제 무효화가 발생하면 새 토큰을 발급해 GitHub Secret을 갱신하고 `_config/instagram-token.json`을 삭제해야 합니다.

## 수동 테스트

Actions → Instagram Auto Post → Run workflow에서 게시 종류와 대상 날짜를 선택합니다.

수동 실행은 예약 큐와 별개입니다. `dry_run`은 실제 게시 없이 검사하고, `test_publish`은 게시 성공 기록을 남기지 않는 테스트 게시입니다.
