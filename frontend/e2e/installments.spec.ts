import { test, expect, type Page } from "./test";

const API = (process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`).replace(/\/$/, "");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const prefixes = new Set<string>();
test.afterEach(async ({request}) => {
  const data = await (await request.get(`${API}/installments`)).json();
  for (const plan of data.plans.filter((p: {description: string}) => prefixes.has(p.description))) {
    // Unlink refunds and payments before the transactions they depend on.
    const linked = new Set<number>(plan.allocations.map((a: {transaction_id: number}) => a.transaction_id));
    for (const tid of [...linked].sort((a,b) => b-a)) {
      const revision = (await (await request.get(`${API}/installments`)).json()).revision;
      expect((await request.put(`${API}/installments/allocations`, {data: {request_id: crypto.randomUUID(), expected_revision: revision, transaction_id: tid, kind: "payment", allocations: []}})).ok()).toBe(true);
    }
    const revision = (await (await request.get(`${API}/installments`)).json()).revision;
    expect((await request.delete(`${API}/installments/${plan.id}`, {data: {request_id: crypto.randomUUID(), expected_revision: revision}})).ok()).toBe(true);
  }
  const txns = await (await request.get(`${API}/transactions`)).json();
  for (const txn of txns.filter((t: {description: string}) => [...prefixes].some(p => t.description.startsWith(p)))) {
    expect((await request.delete(`${API}/transactions/${txn.id}`)).ok()).toBe(true);
  }
  prefixes.clear();
});
async function setup(page: Page, interest = false) {
  const prefix = `할부-${Date.now()}`;
  prefixes.add(prefix);
  const ids: Record<string, number> = {};
  for (const [key,type] of [["비용","expense"],["카드","liability"],["통장","asset"], ...(interest ? [["이자","expense"],["수수료","expense"]] : [])]) {
    const response = await page.request.post(`${API}/accounts`, {data:{name:`${prefix}-${key}`,type}});
    expect(response.status()).toBe(201);
    ids[key]=(await response.json()).id;
  }
  await page.goto("/installments");
  await expect(page.getByRole("heading",{name:"할부 관리",exact:true})).toBeVisible();
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await page.getByText("새 할부 구매",{exact:true}).click();
  await page.getByLabel("구매 내역",{exact:true}).fill(prefix);
  await page.getByRole("combobox",{name:"구매 계정 (비용·자산)",exact:true}).selectOption(String(ids["비용"]));
  await page.getByRole("combobox",{name:"카드 계정 (부채)",exact:true}).selectOption(String(ids["카드"]));
  await page.getByRole("combobox",{name:"납부 통장",exact:true}).selectOption(String(ids["통장"]));
  await page.getByLabel("구매 총액 (원)",{exact:true}).fill("1200000");
  await page.getByLabel("할부 개월 수",{exact:true}).fill("6");
  await page.getByRole("button",{name:"회차 미리보기",exact:true}).click();
  await expect(page.getByRole("button",{name:"구매·할부 일정 저장",exact:true})).toBeVisible();
  return {ids,prefix};
}

test("purchase preview, combined payment, refund, protection and mobile layout", async ({page}, testInfo) => {
  const {ids,prefix}=await setup(page);
  await page.getByRole("button",{name:"구매·할부 일정 저장",exact:true}).click();
  const plan=page.locator(".installment-plan").filter({has:page.getByRole("heading",{name:prefix,exact:true})});
  await expect(plan).toContainText("₩1,200,000");
  await plan.getByRole("button",{name:"회차·납부 보기"}).click();
  await expect(plan.getByRole("row")).toHaveCount(7);
  const transaction=await page.request.post(`${API}/transactions`,{data:{date:today(),description:`${prefix} 실제납부`,postings:[{account_id:ids["카드"],amount:400000},{account_id:ids["통장"],amount:-400000}]}});
  expect(transaction.status()).toBe(201);
  const tid=(await transaction.json()).id;
  await page.getByLabel("거래 검색 (내역 또는 거래 번호)").fill(`${prefix} 실제납부`);
  await expect(page.getByRole("combobox",{name:"실제 거래",exact:true}).locator("option")).toHaveCount(2);
  await page.getByRole("combobox",{name:"실제 거래",exact:true}).selectOption(String(tid));
  await page.getByLabel(`${prefix} 1회 배분액`,{exact:true}).fill("200000");
  await page.getByLabel(`${prefix} 2회 배분액`,{exact:true}).fill("200000");
  let refused = false;
  await page.route("**/api/installments/allocations", route => {
    if (!refused) { refused = true; return route.fulfill({status:409, json:{detail:{code:"installment_revision_conflict",message:"최신 목록 확인 후 다시 저장하세요"}}}); }
    return route.continue();
  });
  await page.getByRole("button",{name:"배분 저장",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("최신 목록");
  await expect(page.getByLabel(`${prefix} 1회 배분액`,{exact:true})).toHaveValue("200000");
  await page.getByRole("button",{name:"배분 저장",exact:true}).click();
  await expect(plan).toContainText("₩800,000");
  expect((await page.request.delete(`${API}/transactions/${tid}`)).status()).toBe(409);
  await expect(plan.getByRole("button",{name:"일정 삭제 (구매 거래 유지)"})).toBeDisabled();
  const refundResponse=await page.request.post(`${API}/transactions`,{data:{date:today(),description:`${prefix} 부분환불`,postings:[{account_id:ids["카드"],amount:150000},{account_id:ids["비용"],amount:-150000}]}});
  expect(refundResponse.status()).toBe(201);
  const refundId=(await refundResponse.json()).id;
  await page.getByLabel("거래 검색 (내역 또는 거래 번호)").fill(`${prefix} 부분환불`);
  await expect(page.getByRole("combobox",{name:"실제 거래",exact:true}).locator("option")).toHaveCount(2);
  await page.getByRole("combobox",{name:"실제 거래",exact:true}).selectOption(String(refundId));
  await page.getByRole("combobox",{name:"연결 종류",exact:true}).selectOption("refund");
  await page.getByLabel(`${prefix} 3회 배분액`,{exact:true}).fill("150000");
  await page.getByRole("button",{name:"배분 저장",exact:true}).click();
  await expect(plan).toContainText("₩650,000");
  await page.screenshot({path: testInfo.outputPath("installments-desktop.png"), fullPage: true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const box=await page.getByRole("button",{name:"배분 저장",exact:true}).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path: testInfo.outputPath("installments-mobile.png"), fullPage: true});
  await page.reload();
  await expect(plan).toContainText("₩650,000");
});

for (const failure of ["lost", "malformed"]) test(`${failure} save response survives reload and exact retry creates one purchase`,async({page})=>{
  const {prefix}=await setup(page);
  let dropped=false;
  await page.route("**/api/installments",async route=>{
    if(route.request().method()==="POST" && !dropped){
      dropped=true;
      const response=await route.fetch();
      expect(response.status()).toBe(201);
      if (failure === "lost") await route.abort("failed");
      else await route.fulfill({json: null});
    } else await route.continue();
  });
  await page.getByRole("button",{name:"구매·할부 일정 저장",exact:true}).click();
  await expect(page.getByRole("button",{name:"저장 결과 다시 확인"})).toBeEnabled();
  await page.reload();
  await page.getByRole("button",{name:"저장 결과 다시 확인"}).click();
  await expect(page.getByRole("button",{name:"저장 결과 다시 확인"})).toHaveCount(0);
  const list=await (await page.request.get(`${API}/installments`)).json();
  expect(list.plans.filter((p:{description:string})=>p.description===prefix)).toHaveLength(1);
});

test("stalled preview times out, preserves draft and permits another preview", async ({page}) => {
  const {prefix}=await setup(page);
  await page.route("**/api/installments/preview", () => {});
  await page.getByLabel("구매 총액 (원)", {exact:true}).fill("600000");
  await page.getByRole("button", {name:"회차 미리보기", exact:true}).click();
  await expect(page.getByRole("button", {name:"회차 미리보기", exact:true})).toBeDisabled();
  await expect(page.getByRole("alert")).toBeVisible({timeout:20_000});
  await expect(page.getByLabel("구매 내역", {exact:true})).toHaveValue(prefix);
  await expect(page.getByLabel("구매 총액 (원)", {exact:true})).toHaveValue("600000");
  await expect(page.getByRole("button", {name:"회차 미리보기", exact:true})).toBeEnabled();
  await page.unroute("**/api/installments/preview");
  await page.getByRole("button", {name:"회차 미리보기", exact:true}).click();
  await expect(page.getByRole("button", {name:"구매·할부 일정 저장", exact:true})).toBeEnabled();
});

test("stalled committed save times out and retries the exact command once", async ({page}) => {
  const {prefix}=await setup(page);
  const commands: unknown[]=[];
  await page.route("**/api/installments", async route => {
    if (route.request().method() !== "POST") return route.continue();
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) {
      const response=await route.fetch();
      expect(response.status()).toBe(201);
      return; // Commit succeeded, but no response reaches the browser.
    }
    return route.continue();
  });
  await page.getByRole("button", {name:"구매·할부 일정 저장", exact:true}).click();
  await expect(page.getByRole("button", {name:"저장 결과 다시 확인"})).toBeDisabled();
  await expect(page.getByRole("button", {name:"저장 결과 다시 확인"})).toBeEnabled({timeout:20_000});
  await page.getByRole("button", {name:"저장 결과 다시 확인"}).click();
  await expect(page.getByRole("button", {name:"저장 결과 다시 확인"})).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  const list=await (await page.request.get(`${API}/installments`)).json();
  expect(list.plans.filter((p:{description:string})=>p.description===prefix)).toHaveLength(1);
});

test("reschedule, link and unlink payment, then delete schedule while keeping purchase", async ({page}) => {
  const {ids,prefix}=await setup(page);
  await page.getByRole("button", {name:"구매·할부 일정 저장", exact:true}).click();
  const plan=page.locator(".installment-plan").filter({has:page.getByRole("heading", {name:prefix,exact:true})});
  await plan.getByRole("button", {name:"회차·납부 보기"}).click();
  const next=new Date(`${today()}T12:00:00`);
  next.setDate(next.getDate()+1);
  const nextDate=`${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,"0")}-${String(next.getDate()).padStart(2,"0")}`;
  await page.getByLabel(`${prefix} 1회 예정일`, {exact:true}).fill(nextDate);
  await plan.getByRole("button", {name:"날짜 저장", exact:true}).click();
  await expect(plan.getByRole("button", {name:"날짜 저장", exact:true})).toHaveCount(0);
  await expect(page.getByLabel(`${prefix} 1회 예정일`, {exact:true})).toHaveValue(nextDate);
  const response=await page.request.post(`${API}/transactions`, {data:{date:today(),description:`${prefix} 납부`,postings:[{account_id:ids["카드"],amount:200000},{account_id:ids["통장"],amount:-200000}]}});
  expect(response.status()).toBe(201);
  const tid=(await response.json()).id;
  await page.getByLabel("거래 검색 (내역 또는 거래 번호)").fill(`${prefix} 납부`);
  await expect(page.getByRole("combobox", {name:"실제 거래",exact:true}).locator("option")).toHaveCount(2);
  await page.getByRole("combobox", {name:"실제 거래",exact:true}).selectOption(String(tid));
  await page.getByLabel(`${prefix} 1회 배분액`, {exact:true}).fill("200000");
  await page.getByRole("button", {name:"배분 저장",exact:true}).click();
  await expect(plan.getByRole("button", {name:"일정 삭제 (구매 거래 유지)"})).toBeDisabled();
  page.on("dialog", d => d.accept());
  await page.getByRole("button", {name:"이 거래의 배분 모두 해제",exact:true}).click();
  await expect(plan.getByRole("button", {name:"일정 삭제 (구매 거래 유지)"})).toBeEnabled();
  await plan.getByRole("button", {name:"일정 삭제 (구매 거래 유지)"}).click();
  await expect(plan).toHaveCount(0);
  const transactions=await (await page.request.get(`${API}/transactions`)).json();
  expect(transactions.filter((t:{description:string})=>t.description===prefix)).toHaveLength(1);
  expect(transactions.filter((t:{id:number})=>t.id===tid)).toHaveLength(1);
});

test("합성 유이자 명세서의 부분 납부·환불과 중도상환을 실제 원장과 검산한다", async ({page}, testInfo) => {
  const {ids,prefix} = await setup(page, true);
  await page.getByLabel("구매 총액 (원)", {exact:true}).fill("20000");
  await page.getByLabel("할부 개월 수").fill("2");
  await page.getByLabel("유이자 할부 명세서 입력").check();
  await page.getByLabel("이자 비용 계정").selectOption(String(ids["이자"]));
  await page.getByLabel("수수료 비용 계정").selectOption(String(ids["수수료"]));
  for (const [row,interest,fee] of [[1,600,100],[2,400,0]]) {
    await page.getByLabel(`${row}회 명세서 이자`,{exact:true}).fill(String(interest));
    await page.getByLabel(`${row}회 명세서 수수료`,{exact:true}).fill(String(fee));
  }
  await page.getByRole("button",{name:"회차 미리보기"}).click();
  await page.getByRole("button",{name:"구매·할부 일정 저장"}).click();
  const plan = page.locator(".installment-plan").filter({has: page.getByRole("heading",{name:prefix,exact:true})});
  await plan.getByRole("button",{name:"회차·납부 보기"}).click();
  const row1 = plan.getByRole("row").nth(1);
  const cells = (principal: string, interest: string, fee: string, unpaid: string) =>
    expect(row1.getByRole("cell")).toHaveText(["1회", "", "₩10,000", principal, interest, fee, unpaid, /예정|확인 필요/]);
  await cells("₩10,000","₩600","₩100","₩10,700");

  async function selectTransaction(label: string, kind: string, postings: [string,number][]) {
    const description = prefix + label;
    const response = await page.request.post(`${API}/transactions`,{data:{
      date:today(), description, postings: postings.map(([key,amount]) => ({account_id:ids[key], amount})),
    }});
    expect(response.status()).toBe(201);
    await page.getByLabel("거래 검색 (내역 또는 거래 번호)").fill(description);
    await page.getByRole("combobox",{name:"실제 거래",exact:true}).selectOption(String((await response.json()).id));
    await page.getByLabel("연결 종류").selectOption(kind);
  }
  async function saveSplit(total: string) {
    await expect(page.getByText("배분 합계 " + total,{exact:true})).toBeVisible();
    const response = page.waitForResponse(r => r.url().endsWith("/installments/allocations") && r.request().method()==="PUT");
    await page.getByRole("button",{name:"배분 저장",exact:true}).click();
    expect((await response).status()).toBe(200);
  }
  const split = (row: number, component: string, amount: string) =>
    page.getByLabel(`${prefix} ${row}회 ${component}배분액`,{exact:true}).fill(amount);

  await selectTransaction("부분납","payment",[["카드",5000],["이자",600],["수수료",100],["통장",-5700]]);
  await split(1,"","5000"); await split(1,"이자 ","600"); await split(1,"수수료 ","100");
  await saveSplit("₩5,700");
  await cells("₩5,000","₩0","₩0","₩5,000");
  await selectTransaction("원금환불","refund",[["카드",1000],["비용",-1000]]);
  await split(1,"","1000"); await saveSplit("₩1,000");
  await cells("₩4,000","₩0","₩0","₩4,000");
  await selectTransaction("이자환급","rebate",[["통장",200],["이자",-200]]);
  await split(1,"이자 ","200"); await saveSplit("₩200");
  await expect(plan.getByText(/납부한 비용 환급 ₩200/)).toBeVisible();
  await cells("₩4,000","₩0","₩0","₩4,000");
  await plan.screenshot({path:testInfo.outputPath("부분납-환급.png")});

  await plan.getByText("2회 명세서·중도상환 조정",{exact:true}).click();
  const editor = plan.locator("details[open]");
  await editor.getByLabel("취소된 미래 이자").fill("400");
  await editor.getByLabel("추가 중도상환 수수료").fill("80");
  await editor.getByRole("button",{name:"회차 명세서 저장"}).click();
  await expect(plan).toContainText("확인된 미지급 총액 ₩14,080");
  await selectTransaction("중도상환","payment",[["카드",14000],["수수료",80],["통장",-14080]]);
  await split(1,"","4000"); await split(2,"","10000"); await split(2,"수수료 ","80");
  await saveSplit("₩14,080");
  await expect(plan).toContainText("남은 원금 ₩0 · 확인된 미지급 총액 ₩0");
  const balances = (await (await page.request.get(`${API}/balances`)).json()).accounts;
  for (const [key,amount] of Object.entries({"통장":-19580,"카드":0,"비용":19000,"이자":400,"수수료":180})) {
    expect(balances.find((a:{account_id:number})=>a.account_id === ids[key]).balance).toBe(amount);
  }
  await plan.screenshot({path:testInfo.outputPath("중도상환.png")});
});
