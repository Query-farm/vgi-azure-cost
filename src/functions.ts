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
import { collectCost, keyColumns, ACTUAL_LOOKBACK_DAYS } from "./cost-query.js";
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
