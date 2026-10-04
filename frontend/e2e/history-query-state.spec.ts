import { expect, test } from "./test";
import { criteriaKey, historyCriteriaError, historyKey, historyPreset, historySearch, readHistoryQuery, validHistoryDate } from "../src/views/historyQueryState";
import { historyReturn } from "../src/views/transactionEditState";

for (const [today, start] of [["2026-09-13", "2026-08-14"], ["2026-03-31", "2026-03-01"], ["2024-03-31", "2024-03-01"],
  ["2026-01-13", "2025-12-14"], ["2024-02-29", "2024-01-30"], ["2026-05-31", "2026-05-01"]]) {
  test(`calendar month clamps then adds one day: ${today}`, () => {
    expect(historyPreset("recent", today)).toEqual({ start, end: today, tag: "" });
  });
}
test("presets include this month's future days and previous month across a year", () => {
  expect(historyPreset("this-month", "2026-09-13")).toMatchObject({ start: "2026-09-01", end: "2026-09-30" });
  expect(historyPreset("last-month", "2026-01-13")).toMatchObject({ start: "2025-12-01", end: "2025-12-31" });
});
test("URL dates required as a pair, defaults concrete, tag round trip and same-day valid", () => {
  const query = readHistoryQuery(new URLSearchParams("tag=여행+%26+Tea"), "2026-09-13").query!;
  expect(query).toEqual({ start: "2026-08-14", end: "2026-09-13", tag: "여행 & Tea", page: 1 });
  expect(readHistoryQuery(new URLSearchParams(historySearch(query))).query).toEqual(query);
  expect(historyCriteriaError({ start: "2024-02-29", end: "2024-02-29", tag: "" })).toBeUndefined();
  expect(validHistoryDate("0001-01-01")).toBe(true);
  for (const date of ["0000-01-01", "2026-02-29", "2026-02-30", "2026-13-01", "20260101", "2026-01-01T00:00:00"]) expect(validHistoryDate(date)).toBe(false);
  for (const search of ["start=2026-09-01", "end=2026-09-13", "start=&end=", "start=2026-09-15&end=2026-09-13", ...["0", "-1", "1.5", "1.0", "abc", "", "9007199254740992"].map(page => `page=${page}`)]) {
    expect(readHistoryQuery(new URLSearchParams(search)).error, search).toBeTruthy();
    expect(readHistoryQuery(new URLSearchParams(search)).query, search).toBeUndefined();
  }
});
test("return snapshot retains only query UI, and restoration keys include every condition", () => {
  const query = { start: "2026-01-01", end: "2026-01-31", tag: "데이트", page: 2 };
  const draft = { ...query, end: "", memo: "not UI", amount: 100 };
  const result = historyReturn({ query, draft, tagFilter: "데이트", scrollY: 300, scrollLeft: 40, focusId: 71, memo: "not UI" });
  expect(result.query).toEqual(query);
  expect(result.draft).toEqual({ start: query.start, end: "", tag: query.tag });
  expect(result).not.toHaveProperty("memo");
  expect(historyReturn({ query: { ...query, page: 0 } }).query).toBeNull();
  expect(historyReturn({ query: { ...query, start: "bad" } }).query).toBeNull();
  for (const patch of [{ start: "2025-01-01" }, { end: "2027-01-01" }, { tag: "엄마" }, { page: 3 }]) expect(historyKey({ ...query, ...patch })).not.toBe(historyKey(query));
  expect(criteriaKey(query)).toBe(criteriaKey({ ...query, page: 3 }));
});
