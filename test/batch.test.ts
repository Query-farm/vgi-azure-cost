// Marker-row contract proof (graph-core §D) for the cost schema. Imports the SDK, so it
// runs under the central workspace install alongside the sibling packages.

import { test, expect } from "bun:test";
import { costSchema, buildCostBatch, DATE_COL, COST_COL, CURRENCY_COL, RESTATED_FROM_COL, KEY_COLUMNS_COL } from "../src/schema.js";
import { ROW_KIND, MARKER, WATERMARK_NEXT } from "@vgi-azure/graph-core";
import type { CostRow } from "../src/cost-query.js";

const GROUP_BY = "Dimension:ResourceGroup";

test("schema: date, one col per dim, Float64 cost, currency, then the control/marker columns", () => {
  expect(costSchema(GROUP_BY).fields.map((f) => f.name)).toEqual([
    DATE_COL, "ResourceGroup", COST_COL, CURRENCY_COL, ROW_KIND, WATERMARK_NEXT, RESTATED_FROM_COL, KEY_COLUMNS_COL,
  ]);
  // Ungrouped total: no dimension columns.
  expect(costSchema("").fields.map((f) => f.name)).toEqual([
    DATE_COL, COST_COL, CURRENCY_COL, ROW_KIND, WATERMARK_NEXT, RESTATED_FROM_COL, KEY_COLUMNS_COL,
  ]);
});

test("buildCostBatch: N typed cost rows + exactly ONE marker row carrying the cursor edges", () => {
  const schema = costSchema(GROUP_BY);
  const rows: CostRow[] = [
    { date: "2026-06-28", cost: 12.4, currency: "USD", dims: { ResourceGroup: "rg-a" } },
    { date: "2026-06-29", cost: 3.1, currency: "USD", dims: { ResourceGroup: "rg-b" } },
  ];
  const batch = buildCostBatch(schema, GROUP_BY, rows, {
    watermarkNext: "2026-06-30",
    restatedFrom: "2026-06-21",
    keyColumns: ["ResourceGroup"],
  }) as { numRows: number };
  expect(batch.numRows).toBe(3); // 2 data + 1 marker
});

test("buildCostBatch on an empty window still emits the single marker row (the cursor)", () => {
  const schema = costSchema(GROUP_BY);
  const batch = buildCostBatch(schema, GROUP_BY, [], {
    watermarkNext: "2026-06-30",
    restatedFrom: "2026-06-21",
    keyColumns: ["ResourceGroup"],
  }) as { numRows: number };
  expect(batch.numRows).toBe(1);
});
