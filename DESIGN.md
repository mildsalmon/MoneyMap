# Design System — MoneyMap "잉크와 원장 (Ink & Ledger)"

기억될 한 가지: **"숫자가 한 치도 안 틀리는 도구."** 모든 디자인 결정은 이 문장에 복무한다.
첫인상 선언: "돈을 예쁘게 보여주는 곳이 아니라, 단 1원도 어긋나지 않게 붙잡는 곳."

## Product Context
- **What this is:** 복식부기 개인 가계부 + What-if 미래 자산 시뮬레이터 (로컬 단일 사용자)
- **Who it's for:** 소유자 본인 — 매일 거래를 입력하고 주간 단위로 시나리오를 검토
- **Space/industry:** 개인 재무 도구 (whooing, Actual Budget, YNAB, ProjectionLab 인접)
- **Project type:** 데스크톱 우선 반응형 웹앱 (localhost, 1440px 기준 + 720px 이하 모바일, 순수 APP UI — 마케팅 페이지 없음)

## Aesthetic Direction
- **Direction:** 종이 원장 모더니즘 — "100년 된 회계장부의 디지털 재제본". 정밀 계측기 같은 조용한 작업대.
- **Decoration level:** minimal — 그림자·zebra striping·장식 요소 금지. 괘선(hairline rule)과 종이 톤, 타이포그래피가 전부.
- **Mood:** 화려해서가 아니라 조용해서 믿음이 가는. "크다"가 아니라 "틀리지 않는다".
- **카테고리 이탈 (의도적):** 남색 사이드바 + 흰 카드 + 보라 액센트의 핀테크 SaaS 문법을 폐기한다.
- **Reference:** actualbudget.org, projectionlab.com (관습 확인용), whooing (입력 UX)

## Typography
- **전체 (본문/UI/테이블):** Pretendard Variable — 한국어 숫자-heavy UI의 표준. CDN: jsdelivr `pretendard@v1.3.9` variable dynamic-subset.
- **의식용 숫자 (히어로 순자산, 검산 합계 행만):** IBM Plex Mono 500/600 — "숫자는 다른 물질"이라는 선언. 이 두 자리 외에는 사용 금지 (남발하면 템플릿 냄새).
- **모든 금액:** `font-variant-numeric: tabular-nums lining-nums` + 우측 정렬. 예외 없음.
- **히어로 숫자는 원 단위까지 전체 표기** (`₩42,180,000`) — 축약 금지. 그 외 축약은 `4,218만`/`5.1억` ("M" 금지).
- **Scale:** 11(메타/badge) · 12(라벨) · 13(테이블 본문) · 14(기본 UI) · 16(폼 입력/섹션 제목) · 20(스트립 값) · 28~44(히어로 순자산)
- **Weights:** 400(본문) · 500(금액 기본) · 600(라벨/강조) · 650(핵심 잔액/선택 상태) · 750(화면 제목)

## Color
- **Approach:** restrained — 색은 드물고, 나올 때마다 의미가 있다.

라이트 (기본):
```css
--bg: #FAF6EE;               /* 미색 종이 */
--surface: #FFFDF7;
--surface-selected: #F0EDE2;
--ink: #211D17;              /* 먹 — 본문 텍스트 */
--muted: #6F6759;             /* 작은 보조 텍스트도 AA 대비 확보 */
--faint: #766F63;             /* 최소 4.5:1 대비 */
--line: #D8D5C9;             /* 괘선 */
--line-strong: #A8A290;
--accent: #1B6E4F;           /* 장부초록 — 주요 액션, 기준선, 긍정 변화 */
--accent-soft: #E2EEE7;
--scenario: #3563E9;         /* 청사진파랑 — 가설/시나리오 전용 */
--scenario-soft: #E4EAFC;
--danger: #C2372B;           /* 인주빨강 — "나쁜 변화" 전용 */
--danger-soft: #F7E0DC;
--warning: #9A6B12;
```

다크 (토글): bg `#191713` / surface `#211E19` / ink `#EAE5DA` / muted `#97917F` / line `#38342C` / accent `#3E9C77` / scenario `#7793EE` / danger `#D7604F` — 채도 10~20% 감쇄, 종이의 온기 유지.

- **시맨틱 규칙 (절대):**
  - 빨강은 사용자가 손해를 보거나 데이터가 잘못됐을 때만. **부채 잔액·대출 원금·카드 미지급금에 빨강 금지** — 부채는 나쁜 것이 아니라 장부의 한쪽. 중립색 + `−` 부호 + "부채" badge로.
  - 차트: 실제=먹 실선 / 현재 패턴 유지=장부초록 실선 / 시나리오=청사진파랑 파선(+점선). **색만으로 구분 금지** — 선 스타일 병행 (색약 대비).

## Spacing
- **Base unit:** 4px
- **Density:** compact — 테이블 행 높이 32px, 헤더 12px/600, 본문 13px
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48)

## Layout
- **Approach:** grid-disciplined 작업대. 1440px 데스크톱을 기준으로 하되 720px 이하에서도 핵심 작업을 유지한다.
- **구조:** 데스크톱은 좌측 사이드바(168px, 하단 장부 상태 스트립) + 메인 캔버스. 모바일은 상단 3열 내비게이션 + 단일 열 메인 캔버스. (승인 와이어프레임 v3 기준)
- **대시보드 3영역:** 테두리 없는 순자산 스트립 → full-width 차트 워크벤치(카드에 가두지 않음) → 컴팩트 테이블.
- **카드 사용 규칙:** 카드(테두리 박스)는 "분리된 작업 패널"(복식 미리보기, 시나리오 편집기)에만. 정보 나열에 카드 금지.
- **테이블:** zebra 금지, 괘선과 여백으로 읽힘. hover는 배경만 미세하게. 검산 합계 행은 상단 실선 + **하단 이중선**(부기 관습).
- **Border radius:** sm 4px / md 6px — 그 이상 금지 (bubbly 금지).

## Motion
- **Approach:** minimal-functional — 이해를 돕는 전환만.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro 100ms(hover/focus) · short 150-250ms(상태 전환, 토스트) — 그 이상의 안무 금지. 입장 애니메이션 금지.

## Anti-slop (금지 목록)
보라 그라데이션 / navy sidebar+white cards+purple CTA / 3열 아이콘 그리드 / 전부 가운데 정렬 / decorative blob·glassmorphism / 카드 중첩 / 이모지 아이콘(Lucide만) / system-ui 폰트 / zebra striping / 카테고리 무지개색 / 부채를 빨강으로 겁주기

## 관련 문서
- UI 동작 명세: `~/.gstack/projects/MoneyMap/mildsalmon-master-ui-spec-20260705.md` (D6~D22 결정)
- 와이어프레임: `~/.gstack/projects/MoneyMap/designs/dashboard-whatif-20260704/wireframes.html`
- 이 시스템의 프리뷰: `~/.gstack/projects/MoneyMap/designs/design-system-20260705/preview.html`

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-05 | 초기 시스템 "잉크와 원장" 작성 | /design-consultation — 리서치(Actual/ProjectionLab) + Codex + 독립 Claude 3자 수렴. 기억될 한 가지="숫자가 한 치도 안 틀리는 도구" |
| 2026-07-05 | Plex Mono는 히어로·검산에만 | Codex(단독 Pretendard) vs 독립안(전면 모노)의 절충 — 도장 찍는 자리에만 다른 잉크 |
| 2026-07-05 | 사이드바 유지 (독립안의 폐지 제안 기각) | 승인 와이어프레임 v3·상태 스트립과 충돌, 매일 쓰는 도구의 관습 가치 |
| 2026-07-05 | "마감(締) 리추얼" 백로그 | 독립안 아이디어 — 하루 마감 시 이중 밑줄+검산. v1.5 후보 |
| 2026-08-19 | muted/faint 대비를 WCAG AA로 상향 | 11~13px 보조 텍스트가 종이 배경에서도 4.5:1 이상 읽히도록 조정 |
