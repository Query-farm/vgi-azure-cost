// THE archetype proof for vgi-azure-cost: a RESTATEMENT-WATERMARK cursor over a dataset
// that mutates in place. Imports ONLY @vgi-azure/graph-core + our own src + bun:test —
// NO @query-farm/* — so it runs without the SDK installed.
//
// It exercises the pure driver (cost-query.ts) end to end against an in-process fake
// Cost Management server, proving:
//   1. continuation pages RE-POST the IDENTICAL ORIGINAL body (committee blocker: the
//      $skiptoken rides in the nextLink URL, the body is NEVER dropped);
//   2. the columnar `{columns, rows}` envelope maps to WELL-TYPED rows (Float64 cost,
//      ISO date, currency, grouping-dimension values);
//   3. rows from EVERY page in the nextLink chain are collected;
//   4. the trailing restatement window (effFrom = from − lookback) is re-pulled and,
//      because the apply is an OVERWRITE keyed on (scope,date,dims), a restated day
//      converges to the LATEST value — 13.07, not a double-counted 25.47.

import { test, expect } from "bun:test";
import { isoToMs, msToIso } from "@vgi-azure/graph-core";
import {
  collectCost,
  restatementFloor,
  costQueryBody,
  keyColumns,
  keyShapeChanged,
  ACTUAL_LOOKBACK_DAYS,
  DAY_MS,
  type CostRow,
} from "../src/cost-query.js";
import { FakeCost, type CostColumnDef } from "./fake-cost.js";

const SCOPE = "subscriptions/sub-1";
// A realistic grouped Daily ActualCost column set: Cost Management returns UsageDate as
// a yyyymmdd integer and the grouping dimension as its own column.
const COLS: CostColumnDef[] = [
  { name: "Cost", type: "Number" },
  { name: "ResourceGroup", type: "String" },
  { name: "UsageDate", type: "Number" },
  { name: "Currency", type: "String" },
];

function collectArgs(over: Partial<Parameters<typeof collectCost>[1]> = {}) {
  return {
    scope: SCOPE,
    from: "2026-06-24",
    to: "2026-06-30",
    granularity: "Daily",
    group_by: "Dimension:ResourceGroup",
    cost_type: "ActualCost",
    lookbackDays: ACTUAL_LOOKBACK_DAYS,
    ...over,
  };
}

test("continuation pages RE-POST the IDENTICAL original body (the $skiptoken is in the URL)", async () => {
  const g = new FakeCost(COLS, [
    { rows: [[12.4, "rg-a", 20260628, "USD"]] }, // page 0 → nextLink
    { rows: [[3.1, "rg-b", 20260629, "USD"]] }, // page 1 (final)
  ]);

  await collectCost(g.postJson, collectArgs());

  // Two POSTs: the original + one continuation.
  expect(g.calls.length).toBe(2);
  // The continuation went to the nextLink URL (carries the $skiptoken)…
  expect(g.calls[1]!.url).toContain("$skiptoken=1");
  // …and re-POSTed the EXACT SAME body — NOT undefined/empty (the committee blocker).
  expect(g.calls[1]!.body).toEqual(g.calls[0]!.body);
  expect(g.calls[1]!.body).not.toBeUndefined();
  // And that body is the real query, not a stub: timePeriod + dataset survived.
  const body = g.calls[0]!.body as { type: string; timePeriod: { from: string; to: string }; dataset: unknown };
  expect(body.type).toBe("ActualCost");
  expect(body.timePeriod.to).toBe("2026-06-30");
  // effFrom = from − 7d (the trailing restatement window low edge).
  expect(body.timePeriod.from).toBe(restatementFloor("2026-06-24", "ActualCost", ACTUAL_LOOKBACK_DAYS));
});

test("columnar {columns, rows} maps to WELL-TYPED rows, and ALL pages are collected", async () => {
  const g = new FakeCost(COLS, [
    { rows: [[12.4, "rg-a", 20260628, "USD"]] },
    { rows: [[3.1, "rg-b", 20260629, "USD"]] },
    { rows: [[0.0, "rg-c", 20260630, "USD"]] },
  ]);

  const r = await collectCost(g.postJson, collectArgs());

  expect(r.pages).toBe(3);
  expect(r.rows.length).toBe(3); // every page's rows collected
  const first = r.rows[0]!;
  expect(typeof first.cost).toBe("number"); // Float64, not a JSON blob
  expect(first.cost).toBe(12.4);
  expect(first.currency).toBe("USD");
  expect(first.date).toBe("2026-06-28"); // yyyymmdd int → ISO date
  expect(first.dims.ResourceGroup).toBe("rg-a"); // grouping-key dimension value
  // The marker edges: watermark = to, restated_from = from − lookback, key = the dims.
  expect(r.watermarkNext).toBe("2026-06-30");
  expect(r.restatedFrom).toBe(restatementFloor("2026-06-24", "ActualCost", ACTUAL_LOOKBACK_DAYS));
  expect(r.keyColumns).toEqual(["ResourceGroup"]);
});

test("RESTATEMENT: re-pulling the trailing window OVERWRITES a restated day (13.07, not 25.47)", async () => {
  // The caller's target table, keyed on (scope, date, grouping dims) — the overwrite key.
  type Store = Map<string, number>;
  const keyOf = (scope: string, row: CostRow) => `${scope}|${row.date}|${row.dims.ResourceGroup}`;
  // APPLY BY OVERWRITE: delete every key in the re-pulled window, then insert the fresh
  // rows. This is the §2 contract — NOT a blind INSERT (that double-counts).
  function applyOverwrite(store: Store, scope: string, rows: CostRow[]): void {
    for (const r of rows) store.delete(keyOf(scope, r)); // window overwrite
    for (const r of rows) if (r.cost != null) store.set(keyOf(scope, r), r.cost);
  }

  // Scan 1: day 2026-06-27 first reports 12.40.
  const g = new FakeCost(COLS, [{ rows: [[12.4, "rg-a", 20260627, "USD"]] }]);
  const store: Store = new Map();
  const r1 = await collectCost(g.postJson, collectArgs({ from: "2026-06-27", to: "2026-06-28" }));
  applyOverwrite(store, SCOPE, r1.rows);
  expect(store.get(`${SCOPE}|2026-06-27|rg-a`)).toBe(12.4);

  // Azure RESTATES 2026-06-27 upward (12.40 → 13.07) — same key, new value.
  g.setPages([{ rows: [[13.07, "rg-a", 20260627, "USD"]] }]);

  // Scan 2: resume with the persisted watermark as `from`. The trailing window re-pulls
  // 2026-06-27 and the caller OVERWRITES it.
  const r2 = await collectCost(g.postJson, collectArgs({ from: r1.watermarkNext, to: "2026-06-29" }));
  applyOverwrite(store, SCOPE, r2.rows);

  // Converged to the LATEST value — overwrite-by-key, not append. 13.07, not 12.40+13.07.
  expect(store.get(`${SCOPE}|2026-06-27|rg-a`)).toBe(13.07);
  expect([...store.values()].reduce((a, b) => a + b, 0)).toBe(13.07);
});

test("AmortizedCost widens the lookback toward the open period = max(openPeriodStart, from−cap)", async () => {
  const CAP_MS = 35 * DAY_MS;
  const monthIdx = (iso: string) => Number(iso.slice(5, 7)) - 1; // 0-based month of `from`
  const floorFor = (from: string) => Math.max(Date.UTC(2026, monthIdx(from) - 1, 1), isoToMs(from) - CAP_MS);

  // Just after a month rollover (from early in July): the open-period start (first of the
  // still-open prior month, June 1) beats the cap, so the scan RE-PULLS the open period.
  const nearRollover = restatementFloor("2026-07-02", "AmortizedCost", ACTUAL_LOOKBACK_DAYS);
  expect(isoToMs(nearRollover)).toBe(Date.UTC(2026, 5, 1)); // 2026-06-01 (open-period wins)
  expect(isoToMs(nearRollover)).toBe(floorFor("2026-07-02"));

  // Deeper into the month (from late July): the naive open-period start (June 1) would be
  // ~50 days back, so the 35-day CAP binds and prevents re-querying two full months.
  const deep = restatementFloor("2026-07-20", "AmortizedCost", ACTUAL_LOOKBACK_DAYS);
  expect(isoToMs(deep)).toBe(isoToMs("2026-07-20") - CAP_MS); // cap wins (2026-06-15)
  expect(isoToMs(deep)).toBe(floorFor("2026-07-20"));

  // ActualCost is the plain from − lookback floor (no open-period widening).
  expect(restatementFloor("2026-07-20", "ActualCost", ACTUAL_LOOKBACK_DAYS)).toBe(
    msToIso(isoToMs("2026-07-20") - ACTUAL_LOOKBACK_DAYS * DAY_MS),
  );
});

test("group_by change flips the overwrite-key shape → keyShapeChanged warns for a full reload", () => {
  const scan1 = keyColumns("Dimension:ResourceGroup");
  const scan2 = keyColumns("Dimension:ResourceGroup,TagKey:costcenter");
  expect(scan1).toEqual(["ResourceGroup"]);
  expect(scan2).toEqual(["ResourceGroup", "costcenter"]);
  expect(keyShapeChanged(scan1, scan2)).toBe(true); // caller must reload, not append
  expect(keyShapeChanged(scan1, keyColumns("Dimension:ResourceGroup"))).toBe(false);
});

test("the original body carries the compiled dataset.grouping for the requested group_by", () => {
  const body = costQueryBody("2026-06-01", "2026-06-30", {
    granularity: "Daily",
    groupBy: "Dimension:ResourceGroup,TagKey:costcenter",
    costType: "ActualCost",
  }) as { dataset: { grouping: { type: string; name: string }[]; aggregation: unknown } };
  expect(body.dataset.grouping).toEqual([
    { type: "Dimension", name: "ResourceGroup" },
    { type: "TagKey", name: "costcenter" },
  ]);
  expect(body.dataset.aggregation).toEqual({ totalCost: { name: "Cost", function: "Sum" } });
});
