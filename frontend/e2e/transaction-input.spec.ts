import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const accounts = [
  {id:101,name:"식비",type:"expense",parent_id:null,is_placeholder:true},
  {id:102,name:"점심비",type:"expense",parent_id:101},
  {id:103,name:"현금",type:"asset",parent_id:null},
  {id:104,name:"카드",type:"liability",parent_id:null},
  {id:105,name:"저축",type:"asset",parent_id:null},
  {id:106,name:"보관통장",type:"asset",parent_id:null,archived:true},
  {id:107,name:"개시잔액",type:"equity",parent_id:null,is_system:true},
].map((a,i)=>({currency:"KRW",position:i,version:1,archived:false,is_system:false,is_placeholder:false,is_overdraft:false,...a}));
const matched = (key="점심",credit=104) => ({ item_key:key,status:"matched",source_transaction_id:9,debit_account_id:102,credit_account_id:credit,unavailable_reason:null });
const item=(page:Page)=>page.getByLabel("아이템 (선택)",{exact:true});
const memo=(page:Page)=>page.getByLabel("메모 (선택)",{exact:true});
const amount=(page:Page)=>page.getByLabel("금액",{exact:true});
const save=(page:Page)=>page.getByRole("button",{name:"저장 (Enter)",exact:true});
const group=(page:Page,side="차변")=>page.getByRole("group",{name:`${side} 계정`,exact:true});
async function start(page:Page) {
  await page.route("**/api/accounts",r=>r.fulfill({json:accounts}));
  await page.route("**/api/transaction-input/recent?*",r=>r.fulfill({json:[]}));
  await page.route("**/api/transaction-input/last-pair?*",r=>r.fulfill({json:{...matched(new URL(r.request().url()).searchParams.get("item")!),status:"none",debit_account_id:null,credit_account_id:null}}));
  await page.goto("/transactions/new");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
  await expect(group(page).locator("input[data-account=\"102\"]")).toBeAttached();
}
async function selectPair(page:Page) {
  await group(page).getByLabel("차변 계정 검색").fill("점심비");
  await group(page).getByRole("radio",{name:/점심비$/}).check();
  await group(page,"대변").getByLabel("대변 계정 검색").fill("현금");
  await group(page,"대변").getByRole("radio",{name:/현금$/}).check();
}

test("click accounts, optional item, memo newline, preview/save and reset",async({page})=>{
  await start(page); const payloads:any[]=[];
  await page.route("**/api/transactions",async r=>{ if(r.request().method()!=="POST") return r.continue(); payloads.push(r.request().postDataJSON()); await r.fulfill({status:201,json:{id:700,...payloads.at(-1)}}); });
  await expect(page.locator(".txn-page select")).toHaveCount(0);
  await expect(group(page).getByRole("radio",{name:/ > 식비$/})).toHaveCount(0);
  await expect(group(page).getByRole("radio",{name:/보관통장|개시잔액/})).toHaveCount(0);
  await selectPair(page); await amount(page).fill("9000"); await memo(page).fill("팀 점심"); await memo(page).press("Enter"); await memo(page).pressSequentially("둘째 줄");
  expect(payloads).toHaveLength(0); await expect(page.locator(".txn-preview")).toContainText("검산 일치");
  await amount(page).press("Enter"); await expect.poll(()=>payloads.length).toBe(1);
  expect(payloads[0]).toMatchObject({description:"",memo:"팀 점심\n둘째 줄",postings:[{account_id:102,amount:9000},{account_id:103,amount:-9000}]});
  await expect(amount(page)).toHaveValue(""); await expect(memo(page)).toHaveValue(""); await expect(amount(page)).toBeFocused();
  await expect(group(page).getByRole("radio",{name:/점심비$/})).toBeChecked();
});

test("late response fills untouched side, item changes and memo never recall amount",async({page})=>{
  await start(page); let held:Route|undefined;
  await page.route("**/api/transaction-input/last-pair?*",r=>{held=r;});
  await item(page).fill("점심"); await amount(page).fill("500"); await memo(page).fill("이번만");
  await expect.poll(()=>!!held).toBe(true);
  await group(page).getByRole("radio",{name:/저축$/}).check();
  await held!.fulfill({json:matched()});
  await expect(group(page).getByRole("radio",{name:/저축$/})).toBeChecked(); await expect(group(page,"대변").getByRole("radio",{name:/카드$/})).toBeChecked();
  await expect(amount(page)).toHaveValue("500"); await expect(memo(page)).toHaveValue("이번만");
  await item(page).fill("다른 아이템"); await expect(group(page,"대변").getByRole("radio",{name:/카드$/})).not.toBeChecked(); await expect(group(page).getByRole("radio",{name:/저축$/})).toBeChecked();
});

test("old item response and IME do not apply or submit",async({page})=>{
  await start(page); const held:Route[]=[];let posts=0;
  await page.route("**/api/transaction-input/last-pair?*",r=>{held.push(r);});
  await page.route("**/api/transactions",r=>{posts++;return r.abort();});
  await item(page).dispatchEvent("compositionstart"); await item(page).fill("점심"); await item(page).press("Enter");
  await page.waitForTimeout(260); expect(held).toHaveLength(0); expect(posts).toBe(0);
  await item(page).dispatchEvent("compositionend"); await expect.poll(()=>held.length).toBe(1);
  await item(page).fill("저녁"); await expect.poll(()=>held.length).toBe(2);
  await held[1].fulfill({json:matched("저녁",103)}); await held[0].fulfill({json:matched("점심",104)}).catch(()=>{});
  await expect(group(page,"대변").getByRole("radio",{name:/현금$/})).toBeChecked(); await expect(group(page,"대변").getByRole("radio",{name:/카드$/})).not.toBeChecked();
});

test("legacy confirm, unavailable split, recent same-item retries and independent failures",async({page})=>{
  await start(page);let calls=0;
  await page.route("**/api/transaction-input/recent?*",r=>r.fulfill({json:[{id:9,date:"2026-09-05",description:"점심",amount:100,posting_count:2,debit_account_id:102,credit_account_id:104}]}));
  await page.route("**/api/transaction-input/last-pair?*",r=>{calls++;return r.fulfill({json:calls===1?{...matched(),status:"legacy_confirmation_required"}:{...matched(),status:"unavailable",unavailable_reason:"split",debit_account_id:null,credit_account_id:null}});});
  await page.reload(); await item(page).fill("점심"); await expect(page.getByRole("button",{name:"이전 기록 확인 후 불러오기"})).toBeVisible();
  await expect(group(page).getByRole("radio",{name:/점심비$/})).not.toBeChecked(); await page.getByRole("button",{name:"이전 기록 확인 후 불러오기"}).click(); await expect(group(page).getByRole("radio",{name:/점심비$/})).toBeChecked();
  await page.locator(".txn-recent").getByRole("button",{name:"점심",exact:true}).click(); await expect.poll(()=>calls).toBe(2); await expect(page.locator(".txn-recall")).toContainText("분할 입력");
  await expect(group(page).getByRole("radio",{name:/점심비$/})).toBeChecked();
});

test("pending save blocks duplicate submits and preserves newer draft/focus",async({page})=>{
  await start(page);let held:Route|undefined;let posts=0;
  await page.route("**/api/transactions",r=>{if(r.request().method()==="POST"){posts++;held=r;}else return r.continue();});
  await selectPair(page);await amount(page).fill("123");await memo(page).fill("저장 메모");await save(page).click();await expect.poll(()=>posts).toBe(1);
  await amount(page).fill("456");await amount(page).press("Enter");await memo(page).fill("새 메모");
  await held!.fulfill({status:201,json:{id:700}});await expect(page.locator(".toast")).toContainText("저장됨");
  expect(posts).toBe(1);await expect(amount(page)).toHaveValue("456");await expect(memo(page)).toHaveValue("새 메모");await expect(memo(page)).toBeFocused();
});

test("save failure keeps draft and never silently retries unknown result",async({page})=>{
  await start(page);let posts=0;await page.route("**/api/transactions",r=>{posts++;return r.abort("failed");});
  await selectPair(page);await amount(page).fill("123");await memo(page).fill("유지");await save(page).click();
  await expect(page.getByRole("alert")).toContainText("거래 내역을 확인");await expect(amount(page)).toHaveValue("123");await expect(memo(page)).toHaveValue("유지");expect(posts).toBe(1);
});

test("split conversion keeps draft, prevents partial-row saves, and picker returns focus",async({page})=>{
  await start(page);await selectPair(page);await amount(page).fill("100");await memo(page).fill("분할 메모");await page.getByRole("button",{name:"분할 입력",exact:true}).click();
  await expect(memo(page)).toHaveValue("분할 메모");await expect(save(page)).toBeEnabled();
  await page.getByRole("button",{name:"+ 행 추가",exact:true}).click();await expect(save(page)).toBeEnabled();
  await page.getByLabel("3행 금액",{exact:true}).fill("0");await expect(save(page)).toBeDisabled();await expect(page.locator(".txn-preview tbody")).not.toContainText("₩100");
  await page.getByRole("button",{name:"기본 입력으로",exact:true}).click();await expect(page.getByRole("alert")).toContainText("작성한 내용은 유지");
  await page.getByRole("button",{name:/3행 계정/}).click();await page.getByRole("group",{name:"3행 계정",exact:true}).getByRole("radio",{name:/현금$/}).click();
  await expect(page.getByRole("button",{name:/3행 계정/})).toBeFocused();await expect(page.locator(".split-picker")).toHaveCount(0);
  await page.getByRole("button",{name:"3행 삭제",exact:true}).click();await expect(save(page)).toBeEnabled();
  let posts=0;await page.route("**/api/transactions",r=>{posts++;return r.abort();});await item(page).press("Enter");expect(posts).toBe(0);
  await page.getByRole("button",{name:"기본 입력으로",exact:true}).click();await expect(amount(page)).toHaveValue("100");await expect(memo(page)).toHaveValue("분할 메모");
});

test("explicit debt fill ignores a late result after amount edit",async({page})=>{
  await start(page);let held:Route|undefined;await page.route("**/api/balances?*",r=>{held=r;});
  await group(page).getByRole("radio",{name:/카드$/}).check();await group(page,"대변").getByRole("radio",{name:/현금$/}).check();await expect(amount(page)).toHaveValue("");
  await page.getByRole("button",{name:"오늘 부채 잔액으로 채우기"}).click();await expect.poll(()=>!!held).toBe(true);await amount(page).fill("50");
  await held!.fulfill({json:{accounts:[{account_id:104,balance:-9000}]}});await expect(page.getByRole("button",{name:"오늘 부채 잔액으로 채우기"})).toBeEnabled();await expect(amount(page)).toHaveValue("50");
  await page.route("**/api/balances?*",r=>r.fulfill({json:{accounts:[{account_id:104,balance:-9000}]}}));await page.getByRole("button",{name:"오늘 부채 잔액으로 채우기"}).click();await expect(amount(page)).toHaveValue("9,000");
});

test("mobile sticky selection, search reset, keyboard choice, and accessibility",async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});await start(page);await selectPair(page);
  await group(page).getByLabel("차변 계정 검색").fill("없는계정");await expect(group(page).getByText("검색 결과가 없습니다.")).toBeVisible();await group(page).getByRole("button",{name:"검색어 지우기"}).click();
  await expect(group(page).getByRole("radio",{name:/점심비$/})).toBeChecked();
  const radio=group(page).getByRole("radio",{name:/점심비$/});await radio.focus();await radio.press("Enter");await expect(radio).toBeChecked();
  await expect(page.locator(".txn-top-summary")).toHaveCSS("position","sticky");await expect(page.locator(".txn-savebar")).toHaveCSS("position","fixed");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const audit=await new AxeBuilder({page}).include(".txn-page").withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze();expect(audit.violations).toEqual([]);
  await page.screenshot({path:testInfo.outputPath("mobile.png"),fullPage:true});
  await page.setViewportSize({width:390,height:460});await expect(page.locator(".txn-savebar")).toHaveCSS("position","static");await expect(page.locator(".txn-top-summary")).toHaveCSS("position","static");
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:testInfo.outputPath("desktop.png"),fullPage:true});
});

test("real save, reload, last-pair recall, undo fallback and multiline memo history",async({page,request})=>{
  const base=process.env.MONEYMAP_E2E_API_BASE??`http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT??8765}/api`;
  const suffix=String(Date.now());
  const ids:number[]=[];
  for(const [name,type] of [[`식사${suffix}`,"expense"],[`지갑${suffix}`,"asset"],[`카드${suffix}`,"liability"]]) {
    const res=await request.post(`${base}/accounts`,{data:{name,type}});expect(res.ok()).toBe(true);ids.push((await res.json()).id);
  }
  const created:number[]=[];
  try {
  const description=`\ufeff회식&? ${suffix}\u0085`,text="첫 줄\n<em>그대로 남기는 메모</em> 🥗";
  await page.goto("/transactions/new");await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
  await item(page).fill(description);await memo(page).fill(text);await amount(page).fill("1500");
  await group(page).getByRole("radio",{name:new RegExp(`식사${suffix}$`)}).check();await group(page,"대변").getByRole("radio",{name:new RegExp(`지갑${suffix}$`)}).check();
  const saved=page.waitForResponse(r=>r.url()===`${base}/transactions`&&r.request().method()==="POST"&&r.ok());await save(page).click();const first=await(await saved).json(); created.push(first.id);
  await expect(amount(page)).toHaveValue("");await page.reload();await item(page).fill(description);await expect(group(page,"대변").getByRole("radio",{name:new RegExp(`지갑${suffix}$`)})).toBeChecked();await expect(memo(page)).toHaveValue("");
  await amount(page).fill("1700");await group(page,"대변").getByRole("radio",{name:new RegExp(`카드${suffix}$`)}).check();const secondSaved=page.waitForResponse(r=>r.url()===`${base}/transactions`&&r.request().method()==="POST"&&r.ok());await save(page).click();const second=await(await secondSaved).json(); created.push(second.id);
  await expect(page.locator(".txn-recall")).toContainText("마지막으로 저장한 계정");
  const deleted=page.waitForResponse(r=>r.url()===`${base}/transactions/${second.id}`&&r.request().method()==="DELETE"&&r.ok());await page.locator(".toast").getByRole("button",{name:/실행취소/}).click();await deleted;
  await expect(group(page,"대변").getByRole("radio",{name:new RegExp(`지갑${suffix}$`)})).toBeChecked();
  const history=await(await request.get(`${base}/transactions`)).json();expect(history.find((t:any)=>t.id===first.id)).toMatchObject({description,memo:text});expect(history.some((t:any)=>t.id===second.id)).toBe(false);
  await page.goto("/transactions");const row=page.getByRole("row").filter({hasText:`회식&? ${suffix}`});await row.getByText("메모 보기",{exact:true}).click();await expect(row.locator("details p")).toHaveText(text);await expect(row.locator("details em")).toHaveCount(0);
  } finally {
    for(const id of created) await request.delete(`${base}/transactions/${id}`);
  }
});

test("failed refresh clears obsolete automatic pair and manual recovery stays savable",async({page})=>{
  await start(page);let calls=0;
  await page.route("**/api/transaction-input/recent?*",r=>r.fulfill({json:[{id:9,date:"2026-09-05",description:"점심",amount:100,posting_count:2,debit_account_id:102,credit_account_id:104}]}));
  await page.route("**/api/transaction-input/last-pair?*",r=>++calls===1?r.fulfill({json:matched()}):r.fulfill({status:503,json:{detail:"lookup failed"}}));
  await page.reload();await item(page).fill("점심");await amount(page).fill("100");await expect(group(page,"대변").getByRole("radio",{name:/카드$/})).toBeChecked();await expect(save(page)).toBeEnabled();
  await page.locator(".txn-recent").getByRole("button",{name:"점심",exact:true}).click();await expect(page.locator(".txn-recall")).toContainText("불러오지 못했습니다");await expect(save(page)).toBeDisabled();await expect(group(page,"대변").getByRole("radio",{name:/카드$/})).not.toBeChecked();
  await selectPair(page);await expect(save(page)).toBeEnabled();
});

test("responsive widths, long duplicate paths, reduced motion and split accessibility",async({page},testInfo)=>{
  await start(page);
  const long="아주 긴 계정 이름이 같은 항목을 여러 그룹에서 사용하는 경우";
  const expanded=[...accounts,{...accounts[0],id:201,name:"회사 식비"},{...accounts[1],id:202,parent_id:201,name:long},{...accounts[1],id:203,name:long},{...accounts[2],id:204,name:"보관 자식이 있는 부모"},{...accounts[2],id:205,parent_id:204,archived:true,name:"숨은 자식"}];
  await page.route("**/api/accounts",r=>r.fulfill({json:expanded}));await page.reload();
  await group(page).getByLabel("차변 계정 검색").fill("회사 식비");await group(page).getByRole("radio",{name:`비용 > 회사 식비 > ${long}`,exact:true}).check();
  await group(page,"대변").getByLabel("대변 계정 검색").fill("식비");await group(page,"대변").getByRole("radio",{name:`비용 > 식비 > ${long}`,exact:true}).check();
  await expect(group(page).getByRole("radio",{name:/보관 자식이 있는 부모$/})).toHaveCount(0);
  await page.emulateMedia({reducedMotion:"reduce"});
  for(const width of [1440,1024,721,720,390,320]) {
    await page.setViewportSize({width,height:900});
    await page.locator("main").evaluate(e=>{e.scrollTop=0;});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`page ${width}`).toBe(true);
    expect(await page.locator("main").evaluate(e=>e.scrollWidth<=e.clientWidth),`main ${width}`).toBe(true);
    await expect(page.locator(".txn-selected").first()).toContainText(`회사 식비 > ${long}`);
    if(width===1440||width===390) await page.screenshot({path:testInfo.outputPath(`input-${width}.png`)});
    if(width<=720) {
      await group(page).getByLabel("차변 계정 검색").focus();
      await group(page).getByLabel("차변 계정 검색").evaluate(e=>e.scrollIntoView({block:"center"}));
      const fieldBox=await group(page).getByLabel("차변 계정 검색").boundingBox(),bar=await page.locator(".txn-savebar").boundingBox(),summary=await page.locator(".txn-top-summary").boundingBox();
      expect(fieldBox!.y+fieldBox!.height).toBeLessThanOrEqual(bar!.y);
      expect(fieldBox!.y).toBeGreaterThanOrEqual(summary!.y+summary!.height);
      expect(await group(page).locator(".account-choice").first().evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
  }
  // 1440px at 200% browser scaling has a 720 CSS-pixel layout viewport.
  await page.setViewportSize({width:720,height:450});await expect(page.locator(".txn-savebar")).toHaveCSS("position","static");
  await page.getByRole("button",{name:"분할 입력",exact:true}).click();await page.getByRole("button",{name:/1행 계정/}).click();
  const audit=await new AxeBuilder({page}).include(".txn-page").withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze();expect(audit.violations).toEqual([]);
  await page.getByRole("button",{name:"계정 선택 닫기"}).click();await expect(page.getByRole("button",{name:/1행 계정/})).toBeFocused();
});

test("failed undo keeps its recovery message visible and does not refresh recall",async({page})=>{
  await start(page);let calls=0;
  await page.route("**/api/transaction-input/last-pair?*",r=>{calls++;return r.fulfill({json:matched()});});
  await page.route("**/api/transactions",r=>r.request().method()==="POST"?r.fulfill({status:201,json:{id:700}}):r.continue());
  await page.route("**/api/transactions/700",r=>r.fulfill({status:503,json:{detail:"삭제 실패"}}));
  await item(page).fill("점심");await amount(page).fill("100");await expect(save(page)).toBeEnabled();await save(page).click();await expect(page.locator(".txn-recall")).toContainText("마지막으로 저장한 계정");
  const before=calls;await page.locator(".toast").getByRole("button",{name:"실행취소",exact:true}).click();await expect(page.locator(".toast")).toContainText("삭제하지 못했습니다");expect(calls).toBe(before);
});


test("arrow keys follow the visible type/tree order and Space never submits", async ({page}) => {
  await start(page);
  const picker=group(page), cash=picker.getByRole("radio",{name:/현금$/}), savings=picker.getByRole("radio",{name:/저축$/}), card=picker.getByRole("radio",{name:/카드$/});
  await cash.focus();await cash.press("ArrowRight");await expect(savings).toBeFocused();await expect(savings).toBeChecked();
  await savings.press("ArrowDown");await expect(card).toBeFocused();await expect(card).toBeChecked();
  await card.press("Space");await expect(card).toBeChecked();await expect(page.locator(".toast")).toBeHidden();
});
