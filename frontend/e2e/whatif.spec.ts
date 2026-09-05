/**
 * What-if 핵심 flow E2E (D10) — 이 제품의 존재 이유를 브라우저로 왕복한다:
 * 온보딩 → 계정+개시잔액 → 반복 규칙 → 시나리오 fork·가설 편집 → 비교 차트.
 */
import { expect, test, type Page } from "./test";

const API_BASE = (process.env.MONEYMAP_E2E_API_BASE
  ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? "8765"}/api`).replace(/\/+$/, "");

function field(page: Page, label: string) {
  return page.locator(`.field:has(label:text-is("${label}"))`).locator("input, select");
}

function nav(page: Page, label: string) {
  return page.locator(".side nav").getByRole("button", { name: label, exact: true });
}

async function selectOptionContaining(select: ReturnType<typeof field>, text: string) {
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  expect(value).not.toBeNull();
  await select.selectOption(value!);
}

async function createRootCategory(page: Page, section: string, name: string) {
  await page.locator("tr.account-section", { hasText: section }).getByRole("button", { name: /새 분류/ }).click();
  const input = page.getByLabel(`${section} 새 분류 이름`);
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator("table.ledger")).toContainText(name);
}

async function createChildCategory(page: Page, parent: string, name: string) {
  await page.locator("tr.account-row", { hasText: parent }).first().getByRole("button", { name: /소분류/ }).click();
  const input = page.getByLabel(`${parent} 소분류 이름`);
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator("table.ledger")).toContainText(name);
}

// 주의: 두 테스트는 같은 DB를 공유한다 (webServer 1회 기동, 파일 순서 실행).
// 스킵 테스트가 먼저 — 거래가 없는 상태여야 성립하기 때문.

test("개시잔액이 0원이어도 '기록'으로 확인하고 진입할 수 있다", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("장부를 시작해볼까요?")).toBeVisible();

  // 0원짜리 빈 통장 하나만 등록 (기록할 개시잔액 거래가 없는 케이스)
  await nav(page, "계정·개시잔액").click();
  await createRootCategory(page, "자산", "빈통장");

  // 0원은 빈 금액의 암묵적 의미가 아니라 별도 확인 작업이다.
  await page.locator('tr:has-text("빈통장")').getByRole("button", { name: "0원으로 확인" }).click();
  await expect(page.locator(".toast")).toContainText("0원으로 확인됨");
  await expect(page.locator('tr:has-text("빈통장")')).toContainText("기록됨 (0원)");

  await nav(page, "대시보드").click();
  await expect(page.getByText("장부를 시작해볼까요?")).toBeHidden();
  await expect(page.locator(".strip .hero")).toHaveText("₩0"); // 0원으로 시작

  // 계정 보관(소프트 삭제, D23) — 목록에서 사라지고 복원 가능
  await nav(page, "계정·개시잔액").click();
  await page.locator('tr:has-text("빈통장")').getByRole("button", { name: "보관" }).click();
  await expect(page.locator(".toast")).toContainText("보관됨");
  await expect(page.getByText("보관된 계정 (1)")).toBeVisible();
  await page.getByRole("button", { name: "복원" }).click();
  await expect(page.locator(".toast")).toContainText("복원됨");
  await expect(page.getByText("보관된 계정")).toBeHidden();
});

test("그룹(대분류) 계정은 거래 입력에서 선택 불가 (D24)", async ({ page }) => {
  await page.goto("/");
  await nav(page, "계정·개시잔액").click();
  await createRootCategory(page, "자산", "은행묶음");
  // "그룹으로" 전환 → 그룹 badge
  await page.locator('tr:has-text("은행묶음")').getByRole("button", { name: "그룹으로" }).click();
  await expect(page.locator('tr:has-text("은행묶음")')).toContainText("그룹");
  // 하위 실계정 생성
  await createChildCategory(page, "은행묶음", "카카오뱅크");

  // 그룹은 접기/펼치기만 가능하고 실제 하위 계정만 선택한다.
  await nav(page, "거래 입력").click();
  const pay = page.getByRole("group", { name: "대변 계정", exact: true });
  await expect(pay.getByRole("radio", { name: / > 은행묶음$/ })).toHaveCount(0);
  await expect(pay.getByRole("radio", { name: /카카오뱅크$/ })).toBeEnabled();
});

test("개시잔액 상태 조회가 실패해도 계정 계층과 재시도는 유지된다", async ({ page }) => {
  await page.route("**/api/opening-balances", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ detail: "임시 오류" }),
  }));
  await page.goto("/");
  await nav(page, "계정·개시잔액").click();

  await expect(page.locator("tr.account-row", { hasText: "빈통장" })).toBeVisible();
  await expect(page.getByText("불러오지 못함").first()).toBeVisible();

  await page.unroute("**/api/opening-balances");
  await page.getByRole("button", { name: "다시 시도" }).first().click();
  await expect(page.locator("tr.account-row", { hasText: "빈통장" }).getByRole("button", { name: "0원으로 확인" })).toBeVisible();
});

test("표준 시드 후 그룹 아래 소분류를 추가하고 그 소분류로 기장한다", async ({ page }) => {
  await page.goto("/");
  await nav(page, "계정·개시잔액").click();
  await page.getByRole("button", { name: "표준 계정과목 추가" }).click();
  await expect(page.locator(".toast")).toContainText("표준 계정과목");
  await expect(page.locator("tr.account-row", { hasText: "식비" }).first()).toContainText("그룹");

  await createChildCategory(page, "식비", "야식");

  await nav(page, "거래 입력").click();
  await field(page, "금액").fill("12345");
  await page.getByRole("group", { name: "차변 계정", exact: true }).getByRole("radio", { name: /야식$/ }).check();
  await page.getByRole("group", { name: "대변 계정", exact: true }).getByRole("radio", { name: /현금$/ }).check();
  await field(page, "금액").press("Enter");
  await expect(page.locator(".toast")).toContainText("순자산 −₩12,345 반영");

  await nav(page, "대시보드").click();
  await expect(page.locator(".strip")).toContainText("₩12,345");
  await expect(page.locator("table.ledger", { hasText: "이번 달 지출 상위" })).toContainText("야식");
});

test("마이너스통장 개시잔액은 대시보드에서만 부채로 보고된다", async ({ page }) => {
  await page.goto("/");
  await nav(page, "계정·개시잔액").click();
  await createChildCategory(page, "입출금통장", "케이뱅크");

  const row = page.locator("tr.account-row", { hasText: "케이뱅크" });
  await row.getByRole("button", { name: "설정" }).click();
  const settingsRow = page.getByLabel("케이뱅크 마이너스통장").locator("xpath=ancestor::tr");
  await page.getByLabel("케이뱅크 마이너스통장").check();
  await settingsRow.getByRole("button", { name: "저장" }).click();
  await expect(row).toContainText("마이너스통장");
  await expect(row.getByRole("button", { name: "설정" })).toBeFocused();

  await page.reload();
  await nav(page, "계정·개시잔액").click();
  await expect(row).toContainText("마이너스통장");
  await expect(row.getByRole("radio", { name: "예금" })).not.toBeChecked();
  await expect(row.getByRole("radio", { name: "마이너스 사용" })).not.toBeChecked();
  await row.getByRole("radio", { name: "예금" }).focus();
  await row.getByRole("radio", { name: "예금" }).press("Space");
  await expect(row.getByRole("radio", { name: "예금" })).toBeChecked();
  await row.getByRole("radio", { name: "예금" }).press("ArrowRight");
  await expect(row.getByRole("radio", { name: "마이너스 사용" })).toBeChecked();
  await page.getByLabel("케이뱅크 개시잔액").fill("123456");
  await page.route("**/api/accounts/*/opening-balance", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await row.getByRole("button", { name: "기록", exact: true }).click();
  await expect(row.getByRole("button", { name: "설정" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "기록 중…" })).toBeDisabled();
  await expect(row).toContainText("기록됨");
  await page.unroute("**/api/accounts/*/opening-balance");

  await nav(page, "대시보드").click();
  const dashboardRow = page.locator("table.ledger tr", { hasText: "케이뱅크" });
  await expect(dashboardRow).toContainText("부채 · 마이너스 사용 중");
  await expect(dashboardRow).toContainText("-123,456");

  const accountResponse = await page.request.get(`${API_BASE}/accounts`);
  const accounts = await accountResponse.json();
  const overdraftId = accounts.find((account: { name: string }) => account.name === "케이뱅크").id;
  const incomeId = accounts.find((account: { name: string }) => account.name === "급여").id;
  const repayment = await page.request.post(`${API_BASE}/transactions`, {
    data: {
      date: new Date().toISOString().slice(0, 10),
      description: "마이너스통장 상환",
      postings: [
        { account_id: overdraftId, amount: 123456 },
        { account_id: incomeId, amount: -123456 },
      ],
    },
  });
  expect(repayment.ok()).toBe(true);
  await page.reload();
  const zeroRow = page.locator("table.ledger tr", { hasText: "케이뱅크" });
  await expect(zeroRow).toContainText("0");
  await expect(zeroRow).not.toContainText("마이너스 사용 중");
  await expect(page.locator("table.ledger tr", { hasText: "신용카드" })).toContainText("부채");
  await page.request.delete(`${API_BASE}/transactions/${(await repayment.json()).id}`);

  // 다음 공유 DB 테스트의 순자산을 변경하지 않도록 개시 거래를 되돌린다.
  await nav(page, "계정·개시잔액").click();
  await page.locator("tr.account-row", { hasText: "케이뱅크" }).getByRole("button", { name: "기록 취소" }).click();
  await expect(page.locator("tr.account-row", { hasText: "케이뱅크" })).toContainText("0원으로 확인");
});

test("온보딩부터 What-if 비교 차트까지", async ({ page }) => {
  // ── 1. 첫 실행 흐름 (앞 테스트의 0원 계정과 무관하게 자체 데이터로 진행)
  await page.goto("/");
  await expect(page.locator(".side .health")).toContainText("검산 정상");
  await nav(page, "계정·개시잔액").click();

  // ── 2. 계정 생성 + 개시잔액 (개시잔액 = equity 상대 거래, D4)
  await createChildCategory(page, "입출금통장", "Toss뱅크");
  await createChildCategory(page, "저축·적금", "신한적금");

  await page.locator('tr:has-text("Toss뱅크") input').fill("10000000");
  await page.locator('tr:has-text("Toss뱅크")').getByRole("button", { name: "기록" }).click();
  await expect(page.locator(".toast")).toContainText("개시잔액 기록됨"); // 저장 토스트 (D9)
  await expect(page.locator(".toast")).toContainText("실행취소");
  await expect(page.locator('tr:has-text("Toss뱅크")')).toContainText("₩10,000,000");
  // 개시잔액은 계정당 1회 — 기록 후 입력칸이 잠긴다
  await expect(page.locator('tr:has-text("Toss뱅크")')).toContainText("기록됨");
  await expect(page.locator('tr:has-text("Toss뱅크")').getByRole("button", { name: "기록", exact: true })).toHaveCount(0);

  // Escape는 수정을 취소하고 기존 이름을 유지한다
  await page.locator('tr:has-text("Toss뱅크")').getByRole("button", { name: "설정" }).click();
  await page.getByLabel("Toss뱅크 이름").fill("임시 이름");
  await page.getByLabel("Toss뱅크 이름").press("Escape");
  await expect(page.locator('tr:has-text("Toss뱅크")')).toBeVisible();
  await expect(page.getByText("임시 이름")).toHaveCount(0);

  // 기존 반복 규칙이 이름 변경 후에도 같은 account_id를 참조하는지 검증한다
  await nav(page, "반복 규칙").click();
  await expect(field(page, "어디서 (from)").locator("option", { hasText: "개시잔액" })).toHaveCount(0);
  await field(page, "내역").fill("월급");
  await selectOptionContaining(field(page, "어디서 (from)"), "급여");
  await selectOptionContaining(field(page, "어디로 (to)"), "Toss뱅크");
  await field(page, "금액/회").fill("3000000");
  await field(page, "금액/회").press("Enter");
  await expect(page.locator("table.ledger")).toContainText("Toss뱅크");

  // 계정 이름 수정 — 기존 거래·반복 규칙의 account_id는 그대로 유지된다
  await nav(page, "계정·개시잔액").click();
  await page.locator('tr:has-text("Toss뱅크")').getByRole("button", { name: "설정" }).click();
  await page.getByLabel("Toss뱅크 이름").fill("토스뱅크");
  await page.getByLabel("Toss뱅크 이름").press("Enter");
  await expect(page.locator(".toast")).toContainText('"Toss뱅크" → "토스뱅크" 이름 변경됨');
  await expect(page.locator("table.ledger")).toContainText("토스뱅크");

  await nav(page, "반복 규칙").click();
  await expect(page.locator("table.ledger")).toContainText("급여 → 토스뱅크");
  await expect(page.locator("table.ledger")).not.toContainText("Toss뱅크");

  // ── 2.5 거래 입력 — 지출 템플릿 (D22): 복식 미리보기 검산 후 저장
  await nav(page, "거래 입력").click();
  await field(page, "금액").fill("52000");
  await page.getByRole("group", { name: "차변 계정", exact: true }).getByRole("radio", { name: /야식$/ }).check();
  await page.getByRole("group", { name: "대변 계정", exact: true }).getByRole("radio", { name: /토스뱅크$/ }).check();
  await expect(page.locator(".txn-preview")).toContainText("검산 일치");
  await field(page, "금액").press("Enter"); // 저장 후 계속 (D12)
  await expect(page.locator(".toast")).toContainText("순자산 −₩52,000 반영");
  await expect(field(page, "금액")).toHaveValue(""); // 금액 비움 + 계속 입력 준비

  // 거래 내역에서 확인
  await nav(page, "거래 내역").click();
  await expect(page.getByRole("heading", { name: "거래 내역", exact: true })).toBeVisible();
  await expect(page.locator("table.ledger")).toContainText("야식");
  await expect(page.locator("table.ledger")).toContainText("₩52,000");

  // ── 3. 이름 변경 이후에도 기존 반복 규칙 참조 유지 확인
  await nav(page, "반복 규칙").click();
  await expect(page.locator("table.ledger")).toContainText("매월 25일");
  await expect(page.locator("table.ledger")).toContainText("토스뱅크");

  // ── 4. 시나리오 생성 — 최신 실제 규칙은 읽기 전용
  await nav(page, "시나리오").click();
  await field(page, "이름").fill("월 100만 더 저축");
  await page.getByRole("button", { name: "+ 새 시나리오" }).click();
  await expect(page.getByRole("heading", { name: "월 100만 더 저축", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "가정", exact: true }).click();

  const editor = page.getByRole("tabpanel");
  await expect(editor).toContainText("월급"); // actual 읽기 전용

  // 가설 규칙 추가 (자산→자산 이체 = 순자산 중립)
  await editor.locator('.field:has(label:text-is("내역")) input').fill("추가 저축");
  await selectOptionContaining(editor.locator('.field:has(label:text-is("어디서 (from)")) select'), "토스뱅크");
  await selectOptionContaining(editor.locator('.field:has(label:text-is("어디로 (to)")) select'), "신한적금");
  await editor.locator('.field:has(label:text-is("금액/회")) input').fill("1000000");
  await editor.getByRole("button", { name: "규칙 추가" }).click();
  await expect(editor).toContainText("추가 저축");

  // 즉시 미리보기 — 저축 이체는 순자산을 바꾸지 않는다
  await page.getByRole("tab", { name: "개요", exact: true }).click();
  await expect(page.locator(".scenario-summary")).toContainText("+₩0");

  // ── 5. 대시보드 — 비교 차트 (wedge)
  await nav(page, "대시보드").click();
  await expect(page.getByText("장부를 시작해볼까요?")).toBeHidden(); // 온보딩 졸업
  await expect(page.locator(".strip .hero")).toHaveText("₩9,935,655"); // 10,000,000 − 12,345 − 52,000

  const legend = page.locator(".legend");
  await expect(legend).toContainText("실제");
  await expect(legend).toContainText("현재 패턴 유지");
  await expect(legend).toContainText("월 100만 더 저축"); // 생성 시 자동 토글

  const chart = page.locator(".chart-wrap svg");
  await expect(chart).toBeVisible();
  expect(await chart.locator("path").count()).toBeGreaterThanOrEqual(3); // 시리즈 3개 이상

  // 크로스헤어 툴팁 — 값 + 기준선 근거 (D17, 툴팁은 게이트하지 않음)
  await chart.hover({ position: { x: 600, y: 100 } });
  await expect(page.locator(".chart-tip")).toContainText("현재 패턴 유지");
  await expect(page.locator(".chart-tip")).not.toContainText("변동지출 월평균");

  // 표 뷰 — 접근성 경로
  await page.getByRole("button", { name: "표로 보기" }).click();
  await expect(page.locator("table.ledger th", { hasText: "현재 패턴 유지" })).toBeVisible();

  // 상태 스트립 갱신 (D8)
  await expect(page.locator(".side .health")).toContainText("검산 정상");

  // 1024px: 페이지 전체는 고정하고 계정 원장만 내부 스크롤한다.
  await page.setViewportSize({ width: 1024, height: 900 });
  await nav(page, "계정·개시잔액").click();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1024);
  const ledgerOverflow = await page.locator(".accounts-ledger-wrap").first().evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(ledgerOverflow).toBe(true);

  // 1200px 미만: 대시보드 표를 한 열로 쌓는다.
  await page.setViewportSize({ width: 1100, height: 900 });
  await nav(page, "대시보드").click();
  // Dashboard는 여러 API를 병렬 로드하므로 실제 잔액이 렌더될 때까지 기다린다.
  // 초기 표 렌더와 온보딩 판정 사이의 짧은 전환을 레이아웃으로 오인하지 않는다.
  await expect(page.locator(".strip .hero")).toHaveText("₩9,935,655");
  const dashboardTables = page.locator(".two > div");
  await expect(dashboardTables).toHaveCount(2);
  const narrowTableTops = await dashboardTables.evaluateAll(
    (elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)),
  );
  expect(narrowTableTops[0]).not.toBe(narrowTableTops[1]);

  // 1440px: 대시보드 하단 표는 승인된 2열 배치를 유지한다.
  await page.setViewportSize({ width: 1440, height: 900 });
  await nav(page, "대시보드").click();
  await expect(dashboardTables).toHaveCount(2);
  const tableTops = await dashboardTables.evaluateAll(
    (elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)),
  );
  expect(tableTops[0]).toBe(tableTops[1]);
});
