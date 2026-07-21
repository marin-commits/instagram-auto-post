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
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_BUCKET` (현재 값: `insta-images`)

## Instagram 토큰 자동 갱신

최초 토큰은 `INSTAGRAM_ACCESS_TOKEN` Secret에서 읽습니다. 이후 7일마다 Meta 갱신 API를 호출하고, 갱신된 토큰을 비공개 Supabase 경로 `_config/instagram-token.json`에 저장합니다. 게시 작업은 이 최신 토큰을 우선 사용합니다.

계정 비밀번호 변경, 앱 권한 해제 또는 Meta의 강제 무효화가 발생한 경우에는 새 토큰을 발급해 GitHub Secret을 갱신하고 Supabase의 `_config/instagram-token.json`을 삭제해야 합니다.

## 수동 테스트

Actions → Instagram Auto Post → Run workflow에서 게시 종류와 대상 날짜를 선택합니다.

Instagram 계정 ID는 액세스 토큰의 `/me` 응답에서 자동으로 확인합니다.\n\n주의: 수동 실행도 실제 Instagram 피드에 게시됩니다. 같은 날짜/종류가 이미 성공했다면 중복 게시 방지 상태 파일 때문에 건너뜁니다.
