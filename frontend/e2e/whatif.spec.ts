/**
 * What-if 핵심 flow E2E (D10) — 이 제품의 존재 이유를 브라우저로 왕복한다:
 * 온보딩 → 계정+개시잔액 → 반복 규칙 → 시나리오 fork·가설 편집 → 비교 차트.
 */
import { expect, test, type Page } from "@playwright/test";

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

  // 금액을 비워둔 채(=0원) 기록 → 거래 없이 확인 표시만
  await page.locator('tr:has-text("빈통장")').getByRole("button", { name: "기록" }).click();
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

  // 거래 입력의 결제 수단 셀렉트: 은행묶음은 disabled, 카카오뱅크는 선택 가능
  await nav(page, "거래 입력").click();
  const pay = field(page, "어디서 나갔나? (결제 수단)");
  await expect(pay.locator("option", { hasText: "은행묶음" })).toBeDisabled();
  await expect(pay.locator("option", { hasText: "카카오뱅크" })).toBeEnabled();
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
  await selectOptionContaining(field(page, "무엇에? (비용)"), "야식");
  await selectOptionContaining(field(page, "어디서 나갔나? (결제 수단)"), "현금");
  await field(page, "금액").press("Enter");
  await expect(page.locator(".toast")).toContainText("순자산 −₩12,345 반영");

  await nav(page, "대시보드").click();
  await expect(page.locator(".strip")).toContainText("₩12,345");
  await expect(page.locator("table.ledger", { hasText: "이번 달 지출 상위" })).toContainText("야식");
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
  await expect(page.locator('tr:has-text("Toss뱅크")').getByRole("button", { name: "기록" })).toHaveCount(0);

  // ── 2.5 거래 입력 — 지출 템플릿 (D22): 복식 미리보기 검산 후 저장
  await nav(page, "거래 입력").click();
  await field(page, "금액").fill("52000");
  await selectOptionContaining(field(page, "무엇에? (비용)"), "야식");
  await selectOptionContaining(field(page, "어디서 나갔나? (결제 수단)"), "Toss뱅크");
  await expect(page.locator(".panel")).toContainText("검산 일치");
  await field(page, "금액").press("Enter"); // 저장 후 계속 (D12)
  await expect(page.locator(".toast")).toContainText("순자산 −₩52,000 반영");
  await expect(field(page, "금액")).toHaveValue(""); // 금액 비움 + 계속 입력 준비

  // 거래 내역에서 확인
  await nav(page, "거래 내역").click();
  await expect(page.locator("table.ledger")).toContainText("야식");
  await expect(page.locator("table.ledger")).toContainText("₩52,000");

  // ── 3. 반복 규칙 (월급)
  await nav(page, "반복 규칙").click();
  await field(page, "내역").fill("월급");
  await selectOptionContaining(field(page, "어디서 (from)"), "급여");
  await selectOptionContaining(field(page, "어디로 (to)"), "Toss뱅크");
  await field(page, "금액/회").fill("3000000");
  await field(page, "금액/회").press("Enter"); // 키보드 저장 (D12)
  await expect(page.locator("table.ledger")).toContainText("매월 25일");

  // ── 4. 시나리오 fork — copy-on-fork 확인 (D5)
  await nav(page, "시나리오").click();
  await field(page, "이름").fill("월 100만 더 저축");
  await page.getByRole("button", { name: "+ 새 시나리오" }).click();
  await expect(page.locator(".toast")).toContainText("규칙 1개가 복사됨");

  const editor = page.locator(".panel", { hasText: "시나리오: 월 100만 더 저축" });
  await expect(editor).toContainText("월급"); // 복사된 규칙

  // 가설 규칙 추가 (자산→자산 이체 = 순자산 중립)
  await editor.locator('.field:has(label:text-is("내역")) input').fill("추가 저축");
  await selectOptionContaining(editor.locator('.field:has(label:text-is("어디서 (from)")) select'), "Toss뱅크");
  await selectOptionContaining(editor.locator('.field:has(label:text-is("어디로 (to)")) select'), "신한적금");
  await editor.locator('.field:has(label:text-is("금액/회")) input').fill("1000000");
  await editor.getByRole("button", { name: "규칙 추가" }).click();
  await expect(editor).toContainText("추가 저축");

  // 즉시 미리보기 — 저축 이체는 순자산을 바꾸지 않는다
  await expect(editor).toContainText("1년 뒤");
  await expect(editor).toContainText("차이: +₩0");

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
  await expect(page.locator(".chart-tip")).toContainText("기준선 근거");

  // 표 뷰 — 접근성 경로
  await page.getByRole("button", { name: "표로 보기" }).click();
  await expect(page.locator("table.ledger th", { hasText: "현재 패턴 유지" })).toBeVisible();

  // 상태 스트립 갱신 (D8)
  await expect(page.locator(".side .health")).toContainText("검산 정상");
});
