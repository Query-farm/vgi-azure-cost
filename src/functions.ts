// The VGI table function: cost_query. One Cost Management query over a trailing
// restatement window, drained across every properties.nextLink (re-POSTing the ORIGINAL
// body). The GraphClient (bound to the ARM audience) is injected via a ClientFactory so
// the worker wires the real MSAL-backed client and tests inject a fake.
//
// CONFORMANCE (graph-core-SPEC checklist):
//   - cost_query IS a table function, so name:=value works on its optional args
//     (granularity, group_by, cost_type, restatement_lookback_days) — they live in
//     argDefaults; scope/from/to have no default so they stay positional & required.
//   - State is fully serializable: plain-string resolved args + a done flag. No Date,
//     no RecordBatch, no live socket. The in-scan paging cursor (nextLink) never enters
//     state — it is a local loop variable in collectCost, safe to restart from page 1
//     because the caller's apply is an OVERWRITE (SPEC §2).
//   - The cross-scan cursor is CALLER-HELD: `from`/`to` in, `_watermark_next` /
//     `_restated_from` / `_key_columns` out on the marker row. Route the day-boundary
//     watermark forward only after the window's rows are durable (no eager ack).

import { defineTableFunction, secretsOfType, type OutputCollector } from "@query-farm/vgi";
import { Utf8, Int64 } from "@query-farm/apache-arrow";
import { collectCost, keyColumns, ACTUAL_LOOKBACK_DAYS, COST_TYPES, GRANULARITIES } from "./cost-query.js";
import { costSchema, buildCostBatch } from "./schema.js";
import type { GraphClient } from "@vgi-azure/graph-core";

export type ClientFactory = (secret: Record<string, unknown>) => GraphClient;

export interface Args {
  /** ARM scope: subscriptions/{id} | providers/Microsoft.Billing/billingAccounts/{id} |
   *  managementGroups/{id} | …/resourceGroups/{name}. Required (positional). */
  scope: string;
  /** Low edge of the requested window (ISO date/instant). This IS the caller-held
   *  watermark: pass back the prior scan's `_watermark_next`. Required (positional). */
  from: string;
  /** High edge of the requested window (ISO date/instant), typically today (UTC).
   *  Required (positional). */
  to: string;
  /** Daily | Monthly | None. Named (name:=value). */
  granularity: string;
  /** Comma list, each `Dimension:Name` or `TagKey:Name`
   *  (e.g. `Dimension:ResourceGroup,TagKey:costcenter`); compiled into dataset.grouping.
   *  "" → ungrouped total. CHANGING this between scans changes the overwrite-key shape →
   *  full reload, not incremental (SPEC §2 #3). Named (name:=value). */
  group_by: string;
  /** ActualCost | AmortizedCost. AmortizedCost auto-widens the lookback toward the open
   *  billing period (open-period-clamped). Named (name:=value). */
  cost_type: string;
  /** ActualCost trailing restatement-window size in days (default 7). Named (name:=value). */
  restatement_lookback_days: number;
}

/** Fully serializable in-scan state — resolved arg strings + a done flag. No Date, no
 *  RecordBatch, no socket, no cross-scan cursor (that is caller-held / on the marker). */
export interface State {
  done: boolean;
  scope: string;
  from: string;
  to: string;
  granularity: string;
  group_by: string;
  cost_type: string;
  lookbackDays: number;
}

export function makeCostFunction(clientFactory: ClientFactory) {
  return defineTableFunction<Args, State>({
    name: "cost_query",
    description:
      "Azure Cost Management actual/amortized cost over a trailing RESTATEMENT window, as typed " +
      "DuckDB rows (date, grouping dims, Float64 cost, currency). Costs are restated retroactively, " +
      "so each scan re-pulls [from−lookback, to] and the caller MUST apply by OVERWRITE keyed on " +
      "(scope, date, grouping dims) — never a blind INSERT (that double-counts, SPEC §2 #2). The new " +
      "high-water `to` rides back on a marker row as _watermark_next (persist only after the rows are " +
      "durable); _restated_from is the low edge to overwrite; _key_columns guards the group_by key " +
      "shape — a change is a full reload, not an incremental resume (§2 #3). Continuation pages re-POST " +
      "the ORIGINAL query body (the $skiptoken is in the nextLink URL). AUDIENCE: arm.",
    args: {
      scope: new Utf8(),
      from: new Utf8(),
      to: new Utf8(),
      granularity: new Utf8(),
      group_by: new Utf8(),
      cost_type: new Utf8(),
      restatement_lookback_days: new Int64(),
    },
    // Optional args in argDefaults so they are NAMED (granularity:=, group_by:=, …);
    // scope/from/to have no default so they stay positional & required.
    argDefaults: {
      granularity: "Daily",
      group_by: "",
      cost_type: "ActualCost",
      restatement_lookback_days: ACTUAL_LOOKBACK_DAYS,
    },
    // Machine-readable constraints so agents discover valid inputs (VGI317). granularity
    // and cost_type are CLOSED sets sourced verbatim from cost-query.ts (GRANULARITIES /
    // COST_TYPES) so the constraint can never drift from the code that validates them.
    // scope / from / to / group_by are OPEN (arbitrary ARM paths, dates, dimension/tag
    // names) so they declare no choices — their descriptions are worded as formats, not
    // enumerations. restatement_lookback_days is a non-negative day count.
    argConstraints: {
      granularity: { choices: GRANULARITIES },
      cost_type: { choices: COST_TYPES },
      restatement_lookback_days: { ge: 0 },
    },
    argDocs: {
      scope:
        "The ARM scope to query, e.g. `subscriptions/{id}`, " +
        "`providers/Microsoft.Billing/billingAccounts/{id}`, `managementGroups/{id}`, or " +
        "`subscriptions/{id}/resourceGroups/{name}`. Required (positional). The service principal " +
        "in the azure_graph secret must have Cost Management reader access on this scope.",
      from:
        "Low edge of the requested window (ISO date or instant, e.g. `2026-06-01`). This IS the " +
        "caller-held watermark: on an incremental scan pass back the prior scan's `_watermark_next`. " +
        "The function re-pulls a trailing restatement window starting `from − restatement_lookback_days` " +
        "(open-period-clamped for AmortizedCost). Required (positional).",
      to:
        "High edge of the requested window (ISO date or instant), typically today (UTC). Rides back on " +
        "the marker row as `_watermark_next`, the new high-water watermark to persist. Required (positional).",
      granularity:
        "Time bucketing of the returned rows: `Daily`, `Monthly`, or `None` (a single total over the " +
        "window). Named (name:=value). Defaults to `Daily`.",
      group_by:
        "Comma-separated grouping list, each token `Dimension:Name` or `TagKey:Name` (e.g. " +
        "`Dimension:ResourceGroup,TagKey:costcenter`; a bare token defaults to a Dimension). Each " +
        "becomes an extra result column and part of the overwrite key. Empty (the default) returns an " +
        "ungrouped total. CHANGING this between scans changes the overwrite-key shape → full reload, " +
        "not incremental. Named (name:=value).",
      cost_type:
        "`ActualCost` (billed cost as incurred) or `AmortizedCost` (reservation/savings-plan purchases " +
        "spread across the benefit period). AmortizedCost auto-widens the trailing lookback toward the " +
        "open, still-restating billing period (capped). Named (name:=value). Defaults to `ActualCost`.",
      restatement_lookback_days:
        "Size in days of the trailing ActualCost restatement window re-pulled on each scan " +
        "(effFrom = from − this). Guards against retroactive restatement of recently-reported costs. " +
        "Named (name:=value). Defaults to 7. (AmortizedCost instead uses an open-period clamp.)",
    },
    examples: [
      {
        sql:
          "SELECT date, \"ResourceGroup\", cost, currency FROM azure.main.cost_query(" +
          "'subscriptions/<guid>', '2026-06-01', '2026-06-30', granularity := 'Daily', " +
          "group_by := 'Dimension:ResourceGroup') WHERE _row_kind IS NULL",
        description: "Daily actual cost by resource group over a month (data rows only)",
      },
      {
        sql:
          "SELECT date, cost, currency FROM azure.main.cost_query(" +
          "'subscriptions/<guid>', '2026-01-01', '2026-06-30', granularity := 'Monthly', " +
          "cost_type := 'AmortizedCost') WHERE _row_kind IS NULL",
        description: "Ungrouped monthly amortized cost total",
      },
      {
        sql:
          "SELECT _watermark_next, _restated_from, _key_columns FROM azure.main.cost_query(" +
          "'subscriptions/<guid>', '2026-06-01', '2026-06-30') WHERE _row_kind = 'marker'",
        description: "Read the restatement watermark to persist for the next incremental scan",
      },
      {
        sql:
          "SELECT date, \"ServiceName\", \"costcenter\", cost, currency FROM azure.main.cost_query(" +
          "'subscriptions/<guid>', '2026-06-01', '2026-06-30', granularity := 'Daily', " +
          "group_by := 'Dimension:ServiceName,TagKey:costcenter') WHERE _row_kind IS NULL",
        description: "Cost by service and cost-center tag over a month (multi-axis grouping)",
      },
    ],
    tags: {
      "vgi.category": "cost-management",
      "vgi.title": "Azure Cost Query",
      // The native duckdb_functions().examples carrier drops descriptions, so mirror the
      // `examples` array here as a described JSON tag (VGI515). Kept byte-identical to the
      // `examples` above so the two never drift.
      "vgi.example_queries": JSON.stringify([
        {
          description: "Daily actual cost by resource group over a month (data rows only)",
          sql:
            "SELECT date, \"ResourceGroup\", cost, currency FROM azure.main.cost_query(" +
            "'subscriptions/<guid>', '2026-06-01', '2026-06-30', granularity := 'Daily', " +
            "group_by := 'Dimension:ResourceGroup') WHERE _row_kind IS NULL",
        },
        {
          description: "Ungrouped monthly amortized cost total",
          sql:
            "SELECT date, cost, currency FROM azure.main.cost_query(" +
            "'subscriptions/<guid>', '2026-01-01', '2026-06-30', granularity := 'Monthly', " +
            "cost_type := 'AmortizedCost') WHERE _row_kind IS NULL",
        },
        {
          description: "Read the restatement watermark to persist for the next incremental scan",
          sql:
            "SELECT _watermark_next, _restated_from, _key_columns FROM azure.main.cost_query(" +
            "'subscriptions/<guid>', '2026-06-01', '2026-06-30') WHERE _row_kind = 'marker'",
        },
        {
          description: "Cost by service and cost-center tag over a month (multi-axis grouping)",
          sql:
            "SELECT date, \"ServiceName\", \"costcenter\", cost, currency FROM azure.main.cost_query(" +
            "'subscriptions/<guid>', '2026-06-01', '2026-06-30', granularity := 'Daily', " +
            "group_by := 'Dimension:ServiceName,TagKey:costcenter') WHERE _row_kind IS NULL",
        },
      ]),
      "vgi.keywords": JSON.stringify([
        "azure",
        "cost",
        "cost management",
        "finops",
        "billing",
        "spend",
        "actual cost",
        "amortized cost",
        "restatement",
        "watermark",
      ]),
      "vgi.doc_llm":
        "Query Azure Cost Management for actual or amortized cost of an ARM scope over a trailing " +
        "restatement window, returned as typed rows: an ISO `date`, one Utf8 column per grouping " +
        "dimension named in `group_by`, a Float64 `cost`, and a `currency`. Because Azure restates " +
        "past-day costs for days-to-weeks, each scan re-pulls [from−lookback, to] and the caller MUST " +
        "apply by OVERWRITE keyed on (scope, date, grouping dims) — never a blind INSERT. Read data " +
        "rows with `WHERE _row_kind IS NULL`; the single marker row carries `_watermark_next` (persist " +
        "as the next `from`), `_restated_from` (low edge to overwrite), and `_key_columns` (the " +
        "group_by key shape). Requires an app-only azure_graph secret (ARM audience).",
      "vgi.doc_md":
        "## cost_query\n\n" +
        "Azure Cost Management actual/amortized cost for an ARM scope over a trailing restatement " +
        "window. The output schema is DEFERRED — it is derived at bind time from the `group_by` " +
        "argument (one extra column per grouping dimension), so it varies by call.\n\n" +
        "Read data rows with `WHERE _row_kind IS NULL`. Persist the marker row's `_watermark_next` as " +
        "the next `from`, and apply each scan by OVERWRITE over `[_restated_from, _watermark_next]` " +
        "keyed on (scope, date, grouping dims) — never a blind INSERT (that double-counts on every " +
        "restatement). Grouping tokens (`Dimension:…` / `TagKey:…`) each add a result column and " +
        "join the overwrite key; `cost_type := 'AmortizedCost'` spreads reservation/savings-plan " +
        "purchases across their benefit period.",
      // The result schema is DYNAMIC (varies by the `group_by` argument), so it is
      // documented as vgi.result_dynamic_columns_md (VGI307/VGI326) — one Name | Type |
      // Description variant table per shape. The default (ungrouped) variant adds no
      // dimension columns; the grouped variant shows the extra Utf8 column injected per
      // grouping token (here `ResourceGroup`), positioned between `date` and `cost`.
      "vgi.result_dynamic_columns_md":
        "The result schema is DEFERRED — decided at bind time from the `group_by` argument. " +
        "**One extra `VARCHAR` column is injected per grouping token**, named exactly as the " +
        "dimension/tag key (e.g. `group_by := 'Dimension:ResourceGroup,TagKey:costcenter'` adds a " +
        "`ResourceGroup` and a `costcenter` column), positioned between `date` and `cost`. The two " +
        "variant tables below show the default ungrouped shape and a representative grouped shape.\n\n" +
        "### Default (empty `group_by`) — no dimension columns\n\n" +
        "| Name | Type | Description |\n" +
        "| --- | --- | --- |\n" +
        "| date | VARCHAR | ISO date of the cost bucket (per `granularity`). NULL on the marker row. |\n" +
        "| cost | DOUBLE | Cost for the bucket (Float64). NULL on the marker row. |\n" +
        "| currency | VARCHAR | Billing currency code (e.g. USD). NULL on the marker row. |\n" +
        "| _row_kind | VARCHAR | NULL for data rows; `marker` for the single trailing cursor row. |\n" +
        "| _watermark_next | VARCHAR | On the marker row, the new high-water `to` to persist and pass back as the next `from`; NULL on data rows. |\n" +
        "| _restated_from | VARCHAR | On the marker row, the low edge of the overwritten (restated) window; NULL on data rows. |\n" +
        "| _key_columns | VARCHAR | On the marker row, the ordered grouping-key column set (comma-joined) guarding the group_by key shape; NULL on data rows. |\n\n" +
        "### Grouped (e.g. `group_by := 'Dimension:ResourceGroup'`) — one extra dimension column\n\n" +
        "| Name | Type | Description |\n" +
        "| --- | --- | --- |\n" +
        "| date | VARCHAR | ISO date of the cost bucket (per `granularity`). NULL on the marker row. |\n" +
        "| ResourceGroup | VARCHAR | The grouping-dimension value (one such column per `group_by` token); part of the overwrite key. NULL on the marker row. |\n" +
        "| cost | DOUBLE | Cost for the bucket (Float64). NULL on the marker row. |\n" +
        "| currency | VARCHAR | Billing currency code (e.g. USD). NULL on the marker row. |\n" +
        "| _row_kind | VARCHAR | NULL for data rows; `marker` for the single trailing cursor row. |\n" +
        "| _watermark_next | VARCHAR | On the marker row, the new high-water `to` to persist and pass back as the next `from`; NULL on data rows. |\n" +
        "| _restated_from | VARCHAR | On the marker row, the low edge of the overwritten (restated) window; NULL on data rows. |\n" +
        "| _key_columns | VARCHAR | On the marker row, the ordered grouping-key column set (comma-joined) guarding the group_by key shape; NULL on data rows. |",
    },
    // Schema decided at bind from group_by (deferred-schema gotcha, SPEC §4).
    onBind: (p) => ({ outputSchema: costSchema(p.args.group_by) }),
    initialState: (p): State => ({
      done: false,
      scope: p.args.scope,
      from: p.args.from,
      to: p.args.to,
      granularity: p.args.granularity,
      group_by: p.args.group_by,
      cost_type: p.args.cost_type,
      lookbackDays: Number(p.args.restatement_lookback_days),
    }),
    process: async (p, state: State, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const secret = secretsOfType(p.secrets, "azure_graph")[0];
      if (!secret) throw new Error("cost_query: attach an 'azure_graph' secret (TYPE azure_graph)");
      const client = clientFactory(secret as Record<string, unknown>);
      const schema = costSchema(state.group_by);

      const result = await collectCost(client.postJson, {
        scope: state.scope,
        from: state.from,
        to: state.to,
        granularity: state.granularity,
        group_by: state.group_by,
        cost_type: state.cost_type,
        lookbackDays: state.lookbackDays,
      });

      out.emit(
        buildCostBatch(schema, state.group_by, result.rows, {
          watermarkNext: result.watermarkNext,
          restatedFrom: result.restatedFrom,
          keyColumns: result.keyColumns,
        }),
      );
      state.done = true; // next process() call hits the done branch and finishes.
    },
  });
}

/** Re-export for the worker/tests: the ordered grouping-key column set for a group_by. */
export { keyColumns };
