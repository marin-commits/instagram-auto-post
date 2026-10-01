# Instagram Auto Post

포스텔러 [오늘의 운세 이미지 페이지](https://event.forceteller.com/outsourced)에서 매월 다음 달 띠별·별자리 운세 이미지를 준비하고, Supabase 비공개 Storage에 보관합니다. 트위터 탭은 사용하지 않습니다.

## 월별 이미지 준비

GitHub Actions의 `Import next month's fortune images`가 한국시간 **매월 1일 09:00**에 실행됩니다. 첫날 사이트나 네트워크 오류가 있었다면 **2일 09:00**에 다시 시도합니다. 재시도는 누락된 파일만 채우며 이미 있는 이미지를 덮어쓰지 않습니다.

- 사이트에서 '다음 달' 띠별 운세 ZIP과 별자리 운세 ZIP을 각각 내려받습니다.
- 날짜·분류·이미지 개수(월 일수 × 2)·PNG 형식·1080×1350 크기를 확인합니다.
- `insta-images/YYMM/MMDD{A|B}.png`에 저장합니다. A는 띠별, B는 별자리입니다.
- 예: 2026년 11월 1일 → `2611/1101A.png`, `2611/1101B.png`.
- 성공 또는 실패는 기존 Slack 웹훅으로 알립니다.

이미 60장이 들어 있으면 사이트를 다시 내려받지 않고 종료합니다. 부분 업로드가 중단되어도 다음 실행에서 누락분만 채웁니다. 사람이 기존 파일을 고쳐 올린 경우 그 파일은 유지됩니다.

수동 점검은 Actions → `Import next month's fortune images` → Run workflow에서 `dry_run`을 켜고 실행합니다. 이 경우 두 ZIP을 실제로 내려받고 검사하지만 업로드하지 않습니다. 수동 실행에서 `dry_run`을 끄면 다음 달 누락 파일을 즉시 채웁니다.

## 매일 게시

별도의 Supabase Cron이 `Instagram Auto Post` 워크플로를 실행합니다.

- A: 운세 날짜 전날 21:05 KST
- B: 운세 날짜 전날 21:35 KST

게시 프로그램은 비공개 PNG를 RGB JPEG로 변환해 Meta가 접근할 임시 공개 주소로 전달한 뒤 임시 파일을 삭제합니다. 게시가 성공하면 `_published-v2/YYYY-MM-DD-{A|B}.json`에 기록되어 정규 중복 게시를 막습니다.

## GitHub Actions Secrets

- `INSTAGRAM_ACCESS_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_BUCKET` (현재 `insta-images`)
- `SLACK_WEBHOOK_URL`

인스타그램 토큰은 기존 게시 프로그램이 7일마다 갱신하고, 비공개 Supabase의 `_config/instagram-token.json`에 저장합니다.
