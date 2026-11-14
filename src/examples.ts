// The cost_query example queries, defined ONCE and fed to every carrier: the function's
// native `examples`, its described `vgi.example_queries` tag (VGI515), and the schema-level
// `vgi.example_queries` list. The vgi-lint agent simulator only shows an agent the first 5
// examples of each function, so the composed example stays within that window.
//
// None of these run without an attached azure_graph secret and a live Cost Management
// call, so they are shown-only; the credential-free bind probes live in the catalog's
// vgi.executable_examples.
//
// Every scan re-pulls a trailing RESTATEMENT window before `from` (7 days for ActualCost,
// back toward the open billing period for AmortizedCost), so examples that describe a
// fixed period filter `date` back to that period; the watermark example deliberately
// does not (the whole window is what the caller overwrites).

export interface ExampleQuery {
  description: string;
  sql: string;
}

/** Composed: two cost_query scans (ActualCost and AmortizedCost) over the same period,
 *  joined per service. The difference is how much reservation / savings-plan purchase
 *  cost amortization moves between billed and spread-out spend. Each scan's restatement
 *  lookback differs (7 days vs. the open billing period), so both are cut back to June. */
export const ACTUAL_VS_AMORTIZED_BY_SERVICE: ExampleQuery = {
  description:
    "Actual vs amortized June cost per service, from two cost_query scans joined on ServiceName; " +
    "amortization_shift (amortized − actual) shows where reservation/savings-plan purchases are " +
    "spread out (largest absolute shift first; the date filter drops the restatement-lookback days each scan re-pulls)",
  sql:
    "WITH actual AS (SELECT \"ServiceName\", currency, sum(cost) AS actual_cost " +
    "FROM azure.main.cost_query('subscriptions/<guid>', '2026-06-01', '2026-06-30', " +
    "group_by := 'Dimension:ServiceName') " +
    "WHERE _row_kind IS NULL AND date BETWEEN '2026-06-01' AND '2026-06-30' GROUP BY ALL), " +
    "amortized AS (SELECT \"ServiceName\", currency, sum(cost) AS amortized_cost " +
    "FROM azure.main.cost_query('subscriptions/<guid>', '2026-06-01', '2026-06-30', " +
    "cost_type := 'AmortizedCost', group_by := 'Dimension:ServiceName') " +
    "WHERE _row_kind IS NULL AND date BETWEEN '2026-06-01' AND '2026-06-30' GROUP BY ALL) " +
    "SELECT \"ServiceName\", currency, round(coalesce(actual_cost, 0), 2) AS actual_cost, " +
    "round(coalesce(amortized_cost, 0), 2) AS amortized_cost, " +
    "round(coalesce(amortized_cost, 0) - coalesce(actual_cost, 0), 2) AS amortization_shift " +
    "FROM actual FULL JOIN amortized USING (\"ServiceName\", currency) " +
    "ORDER BY abs(amortization_shift) DESC, \"ServiceName\"",
};

export const COST_QUERY_EXAMPLES: ExampleQuery[] = [
  {
    description:
      "Daily actual cost by resource group for June (data rows only; the date filter drops the 7-day restatement lookback the scan also re-pulls)",
    sql:
      "SELECT date, \"ResourceGroup\", cost, currency FROM azure.main.cost_query(" +
      "'subscriptions/<guid>', '2026-06-01', '2026-06-30', granularity := 'Daily', " +
      "group_by := 'Dimension:ResourceGroup') WHERE _row_kind IS NULL AND date >= '2026-06-01' " +
      "ORDER BY date, \"ResourceGroup\"",
  },
  {
    description:
      "Monthly amortized cost totals for January–June (the date filter drops the open prior month the amortized lookback also re-pulls)",
    sql:
      "SELECT date, cost, currency FROM azure.main.cost_query(" +
      "'subscriptions/<guid>', '2026-01-01', '2026-06-30', granularity := 'Monthly', " +
      "cost_type := 'AmortizedCost') WHERE _row_kind IS NULL AND date >= '2026-01-01' ORDER BY date",
  },
  {
    description: "Read the restatement watermark to persist for the next incremental scan",
    sql:
      "SELECT _watermark_next, _restated_from, _key_columns FROM azure.main.cost_query(" +
      "'subscriptions/<guid>', '2026-06-01', '2026-06-30') WHERE _row_kind = 'marker'",
  },
  {
    description:
      "Daily cost by service and cost-center tag for June (multi-axis grouping; restatement-lookback days filtered out)",
    sql:
      "SELECT date, \"ServiceName\", \"costcenter\", cost, currency FROM azure.main.cost_query(" +
      "'subscriptions/<guid>', '2026-06-01', '2026-06-30', granularity := 'Daily', " +
      "group_by := 'Dimension:ServiceName,TagKey:costcenter') WHERE _row_kind IS NULL AND date >= '2026-06-01' " +
      "ORDER BY date, \"ServiceName\", \"costcenter\"",
  },
  ACTUAL_VS_AMORTIZED_BY_SERVICE,
];
