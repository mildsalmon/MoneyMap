# 최근 입력 더보기 검증 결과

- Date: 2026-10-03
- Base: main 8679a41 (pull --ff-only 완료)
- Branch: feature/recent-input-load-more
- Status: DONE, 구현·리뷰·QA 완료. v0.8.4.0 ship 진행, main 머지·배포 대기.

## 구현

최근 입력의 기존 대상·저장 ID 순서를 보존하며 5건씩 추가한다. 선택적인
`before_id`를 API→서비스→포트→SQLite에 전달한다. 여섯 번째 행으로 다음 페이지를
판단한다. 중복 클릭은 잠그고, 추가 조회 실패는 기존 목록과 커서를 보존한다.
저장·실행취소 시 컴포넌트를 장부 세대로 다시 마운트하여 최신 첫 페이지를 조회한다.
기존 요청은 취소하고 늦은 응답은 무시한다.

## 자동 검증

| 검증 | 결과 |
|---|---|
| backend `uv run pytest -q` | 480 passed, 16.50s |
| 리뷰 후 강화한 HTTP cursor test | 1 passed, 0.48s |
| frontend production build | PASS |
| 신규 frontend E2E | 5 passed |
| frontend 전체 E2E | 171 passed, 2.7m |
| git diff --check | PASS |

로그: `/tmp/moneymap-recent-backend.log`, `/tmp/moneymap-recent-e2e.log`.
기존 경고: Starlette TestClient httpx deprecation, Vite 500kB chunk 안내.

## gstack review

Security, Performance, API Contract, Testing, Maintainability, Design,
Simplification 렌즈를 세 개의 독립 리뷰 에이전트에 나누어 확인했다.
동일 모델 계열 리뷰이며 외부 Claude/Codex 교차 검증으로 간주하지 않는다.
Codex 안에서 실행 중이므로 중첩 Codex CLI 리뷰는 생략했다.

테스트 보완 1건: 빈 DB만 사용하는 HTTP 테스트는 before_id 전달 누락을 잡지 못함.
거래 7건을 HTTP로 생성하여 첫 5건과 커서 이후 나머지 2건의 ID를 정확히 검증하도록
보완했다. 해당 테스트 통과와 리뷰어 재확인을 완료했다. 미해결 지적 없음.
소스 adversarial 검토에서는 추가 문제를 찾지 못했다. 이 검토의 테스트 확인은
summary 기준이며, 테스트 전문은 Testing 리뷰어가 별도로 확인했다.

## gstack browse

별도 임시 DB(`/tmp/moneymap-recent-qa-20261003.db`)의 합성 거래 12건으로 확인했다.
사용자의 실제 장부는 변경하지 않았다.

- 실제 API로 5 → 10 → 12건, 마지막 입력 안내와 더보기 제거 확인.
- 마지막 항목 선택 후 아이템과 계정 추천 확인.
- 1440px / 390px 레이아웃 확인. 모바일 마지막 안내도 저장 바 위에서 확인 가능.
- 스크린샷: `/tmp/moneymap-recent-desktop.png`, `/tmp/moneymap-recent-mobile.png`.
- 기존 browse 세션의 서버 종료 로그가 남아 있었으나 현재 페이지 방문 이후 새 앱 오류 없음.

## 작업 보존

원래 fix/input-recall-refresh의 미커밋 작업은
`preserve-before-main-pull-2026-10-03` stash에 보존했다. 할부 설계와 새 백로그 항목
(반복 규칙 수정·할부·통계)은 현재 TODO에 선택 복원했다. 오래된 P1 중복 구현과
거래내역 작업은 이 브랜치에 적용하지 않았다. ship에서 VERSION을 0.8.4.0으로 올리고 릴리스 변경 기록을 확정한다.
