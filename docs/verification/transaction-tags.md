# 거래 태그 선택기 검증

2026-10-24 · [설계·동작 계약](../designs/transaction-tags.md).

태그 전용 Playwright 8개 통과. 입력·수정 공통 UI를 포함한 최종 전체 E2E는 241개 통과했다.

모바일 axe에서 후보의 부모 div가 독립적인 스크롤 영역으로 인식되는 문제를 발견해 실제 제어 대상인 listbox로 스크롤을 옮겼다. 칩의 flex/wrap/6px 간격도 검토·수정했다. 390px 캡처와 터치 높이·가로 넘침·axe 검사는 통과했다.

## 최종 결과

- 백엔드 `cd backend && uv run pytest`: **560 passed**, 22.83초.
- 전체 E2E: **241 passed**, 4.1분. `MONEYMAP_E2E_BACKEND_PORT=18770 MONEYMAP_E2E_FRONTEND_PORT=15178 npm run e2e`, 임시 DB 격리.
- 프런트 `npm run build`: TypeScript·Vite 통과.
- `git diff --check`: 통과.
- 전용 테스트 8개는 다중 선택·생성·저장 payload·Escape/Tab·포커스·IME/keyCode229·NFC/공백/영문 대소문자·20개/50자 경계·늦은 응답 후 새 태그 보존·대량 후보·모바일 axe를 포함한다.
- 기존 입력·수정 테스트 42개도 변경된 선택기로 전체 실행에서 통과했다. 저장 충돌·응답 유실·잠금·모바일 IME·실제 원장 round trip을 유지한다.
- 데스크톱 1440px과 모바일 390px 캡처를 직접 확인했다. 긴 이름 줄바꿈, 가로 넘침 없음, 44px 조작 영역, 칩 간격을 확인했다.
- 새 API·스키마·의존성 추가 없음. 빌드에는 기존 500KB 번들 경고, 백엔드에는 기존 Starlette/httpx 사용 중단 예고가 남아 있으며 실패가 아니다.

## 리뷰와 상태

정확성·테스트·유지보수, 디자인·접근성·성능·단순화, 같은 모델의 독립 문맥 adversarial 소스 리뷰를 수행했다. 칩 레이아웃 누락을 수정했고 최종 미해결 발견 사항은 없다. 외부 모델 검토나 계측된 커버리지 수치를 주장하지 않는다.

분기 `feature/transaction-tag-picker`에서 로컬 구현·검증 완료. 별도 ship 전이며 VERSION·릴리스 CHANGELOG를 변경하지 않았다. 앞선 반복규칙·무이자 할부 PR #15는 이 작업 착수 전 main `74b9c30`으로 병합했다.

스크린샷은 `/tmp/moneymap-tag-picker-final/`의 테스트별 출력에 있으며 장기 보존은 보장하지 않는다.
