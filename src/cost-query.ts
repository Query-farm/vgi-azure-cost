// The Azure Cost Management query driver — pure logic over graph-core's postJson, no
// SDK / no network. This is the RESTATEMENT-WATERMARK archetype: the deliberate
// contrast to both the directory delta token (opaque, monotonic, exactly-once window)
// and the resourcegraph snapshot (no cursor at all).
//
// The cross-scan cursor here is a CALLER-HELD DATE WATERMARK over a dataset that is
// restated retroactively (SPEC §2). Azure cost figures for a past day are NOT final
// when first reported — amortization, late marketplace/metered usage, credits, refunds
// and tax move them for days-to-weeks. So a row keyed by (scope, date, grouping-dims)
// is MUTABLE, and the durable contract is:
//
//   - each scan re-queries a trailing restatement window [effFrom, effTo], where
//     effFrom = args.from − LOOKBACK (open-period-clamped for AmortizedCost);
//   - the caller OVERWRITES (DELETE+INSERT / UPSERT) that window keyed by
//     (scope, date, grouping-dims) — idempotent by OVERWRITE, never by append;
//   - the new high-water `to` rides back on a marker row as `_watermark_next`, the low
//     edge as `_restated_from`, and the grouping-key column set as `_key_columns`
//     (the §2 Forbidden #3 key-shape-stability guard).
//
// The cursor is CALLER-HELD: args.from IS the watermark. There is NO state.watermarkDate
// term in effFrom (that would be a phantom same-scan cursor / dead code — SPEC §2 step 1).
//
// AUDIENCE = arm: Cost Management lives on the ARM control plane, so the OAuth2 scope is
// https://management.azure.com/.default (SPEC §3) — the ONLY thing that differs from the
// Graph workers. The audience binding lives in the worker's clientFactory, not here.

import { isoToMs, msToIso } from "@vgi-azure/graph-core";

/** Pinned API version — never inline a version string at a call site (SPEC §2). */
export const COST_API_VERSION = "2023-03-01";

export type CostType = "ActualCost" | "AmortizedCost";
export type Granularity = "Daily" | "Monthly" | "None";

/** Default trailing restatement window for ActualCost (SPEC §2 step 1). */
export const ACTUAL_LOOKBACK_DAYS = 7;
/** AmortizedCost open-period lookback CAP (days) — clamps a month-boundary scan so it
 *  re-pulls the restated open period WITHOUT ballooning to two closed months and
 *  blowing the (very low) Cost Management throttle budget (SPEC §1/§2 step 1). */
export const AMORTIZED_LOOKBACK_DAYS_CAP = 35;

export const DAY_MS = 86_400_000;

/** Column-name aliases Cost Management uses for the three well-typed roles. Cost is
 *  well-typed here (unlike resourcegraph's heterogeneous objectArray), so we map it to
 *  a real Float64 column rather than a JSON blob. */
const COST_NAMES = new Set(["Cost", "CostUSD", "PreTaxCost", "PreTaxCostUSD"]);
const CURRENCY_NAMES = new Set(["Currency", "CurrencyCode", "BillingCurrency"]);
const DATE_NAMES = new Set(["UsageDate", "BillingMonth", "Date"]);

/** Build the Cost Management query endpoint for a scope (subscriptions/{id},
 *  providers/Microsoft.Billing/billingAccounts/{id}, management groups, …). */
export function costQueryUrl(scope: string): string {
  const s = scope.replace(/^\/+|\/+$/g, ""); // trim leading/trailing slashes
  return `https://management.azure.com/${s}/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}`;
}

export interface Grouping {
  type: "Dimension" | "TagKey";
  name: string;
}

/** Parse the `group_by` comma list — each `Dimension:Name` or `TagKey:Name`
 *  (a bare token defaults to a Dimension) — into `dataset.grouping` entries. */
export function parseGroupBy(groupBy: string): Grouping[] {
  if (!groupBy) return [];
  return groupBy
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((tok) => {
      const idx = tok.indexOf(":");
      if (idx < 0) return { type: "Dimension" as const, name: tok };
      const type = tok.slice(0, idx).trim();
      const name = tok.slice(idx + 1).trim();
      return { type: type === "TagKey" ? ("TagKey" as const) : ("Dimension" as const), name };
    });
}

/** The ORDERED grouping-key column names for this scan — the overwrite-key shape.
 *  Emitted on the marker row as `_key_columns`; a change between scans is a full
 *  reload, not an incremental resume (SPEC §2 Forbidden #3). */
export function keyColumns(groupBy: string): string[] {
  return parseGroupBy(groupBy).map((g) => g.name);
}

/** True when the resumed watermark's key shape differs from this scan's — the caller
 *  MUST reload (TRUNCATE + recreate) rather than append, else old-shape rows orphan and
 *  totals double (SPEC §2 Forbidden #3). The worker warns; enforcement is the caller's. */
export function keyShapeChanged(priorKeyColumns: string[], currentKeyColumns: string[]): boolean {
  return priorKeyColumns.join(",") !== currentKeyColumns.join(",");
}

/** Conservative start of the OPEN + still-restating billing period for AmortizedCost:
 *  the UTC first-of-the-PREVIOUS-month. Reservation/savings-plan amortization restates
 *  prior months across the benefit period, and just after a rollover the just-closed
 *  month is still open — so the amortized restatement window legitimately reaches into
 *  last month. The 35-day cap in restatementFloor then bounds HOW FAR, so a
 *  month-boundary scan re-pulls the open period WITHOUT ballooning to two full closed
 *  months and blowing the throttle budget (SPEC §1/§2 step 1). Date.UTC handles the
 *  month=−1 rollover (January → previous December) itself. */
export function openPeriodStartMs(refMs: number): number {
  const d = new Date(refMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
}

/**
 * Compute effFrom for the trailing restatement window (SPEC §2 step 1).
 *
 *   ActualCost:    effFrom = args.from − lookbackDays
 *   AmortizedCost: effFrom = max(openPeriodStart, args.from − CAP)  ← open-period clamp
 *
 * The AmortizedCost widen toward the open period is CAPPED so a scan just after a month
 * rollover re-pulls the restated open period without silently re-querying two full
 * closed months. The cursor is CALLER-HELD — this reads only args.from, never a
 * state.watermarkDate (which initialState always starts null, making any such term dead
 * code that reads as a same-scan cursor this worker does not have).
 */
export function restatementFloor(from: string, costType: string, lookbackDays: number): string {
  const fromMs = isoToMs(from);
  if (costType === "AmortizedCost") {
    const openStart = openPeriodStartMs(fromMs);
    const capFloor = fromMs - AMORTIZED_LOOKBACK_DAYS_CAP * DAY_MS;
    return msToIso(Math.max(openStart, capFloor));
  }
  return msToIso(fromMs - lookbackDays * DAY_MS);
}

/** Build the Cost Management POST body. This exact object is re-POSTed VERBATIM on
 *  every continuation page (the $skiptoken rides in the nextLink URL, NOT the body). */
export function costQueryBody(
  effFrom: string,
  effTo: string,
  opts: { granularity: string; groupBy: string; costType: string },
): Record<string, unknown> {
  const grouping = parseGroupBy(opts.groupBy).map((g) => ({ type: g.type, name: g.name }));
  const dataset: Record<string, unknown> = {
    granularity: opts.granularity,
    aggregation: { totalCost: { name: "Cost", function: "Sum" } },
  };
  if (grouping.length) dataset.grouping = grouping;
  return {
    type: opts.costType,
    timeframe: "Custom",
    timePeriod: { from: effFrom, to: effTo },
    dataset,
  };
}

export interface CostColumn {
  name: string;
  type?: string;
}

/** One decoded Cost Management response page. `nextLink` (inside `properties`) is the
 *  in-scan continuation the caller re-POSTs the ORIGINAL body to. */
export interface CostPage {
  columns: CostColumn[];
  rows: unknown[][];
  nextLink: string | null;
}

export function decodePage(raw: Record<string, unknown>): CostPage {
  const props = (raw.properties ?? {}) as Record<string, unknown>;
  const columns = (Array.isArray(props.columns) ? props.columns : []) as CostColumn[];
  const rows = (Array.isArray(props.rows) ? props.rows : []) as unknown[][];
  const nextLink =
    typeof props.nextLink === "string" && props.nextLink.length > 0 ? (props.nextLink as string) : null;
  return { columns, rows, nextLink };
}

/** One mapped cost row: the well-typed cost + currency + date, plus the grouping-key
 *  dimension values (the overwrite key). */
export interface CostRow {
  date: string | null;
  cost: number | null;
  currency: string | null;
  /** Grouping-key column name → value (String; part of the overwrite key). */
  dims: Record<string, string | null>;
}

/** Normalize a date cell: Cost Management returns Daily `UsageDate` as a yyyymmdd
 *  integer and Monthly `BillingMonth` as an ISO datetime — both map to an ISO date. */
export function normalizeDate(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    const s = String(v);
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return s;
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** Map one response page (columns + positional rows) to typed CostRows, pulling the
 *  grouping-key columns named in `keyCols` as the overwrite-key dimensions. */
export function mapPage(columns: CostColumn[], rows: unknown[][], keyCols: string[]): CostRow[] {
  const costIdx = columns.findIndex((c) => COST_NAMES.has(c.name));
  const curIdx = columns.findIndex((c) => CURRENCY_NAMES.has(c.name));
  const dateIdx = columns.findIndex((c) => DATE_NAMES.has(c.name));
  const keyIdx = keyCols.map((k) => columns.findIndex((c) => c.name === k));
  return rows.map((r) => {
    const dims: Record<string, string | null> = {};
    keyCols.forEach((k, i) => {
      const ci = keyIdx[i]!;
      const v = ci >= 0 ? r[ci] : null;
      dims[k] = v == null ? null : String(v);
    });
    return {
      date: dateIdx >= 0 ? normalizeDate(r[dateIdx]) : null,
      cost: costIdx >= 0 && r[costIdx] != null ? Number(r[costIdx]) : null,
      currency: curIdx >= 0 && r[curIdx] != null ? String(r[curIdx]) : null,
      dims,
    };
  });
}

export interface CostResult {
  rows: CostRow[];
  /** Low edge of the overwritten window → marker `_restated_from`. */
  restatedFrom: string;
  /** New high-water `to` → marker `_watermark_next` (the cross-scan cursor out). */
  watermarkNext: string;
  /** Ordered grouping-key column names → marker `_key_columns` (§2 #3). */
  keyColumns: string[];
  /** Pages fetched this scan (telemetry). */
  pages: number;
}

export interface CollectArgs {
  scope: string;
  from: string;
  to: string;
  granularity: string;
  group_by: string;
  cost_type: string;
  lookbackDays: number;
}

/**
 * Drain a Cost Management query to completion: POST the body for the trailing window
 * [effFrom, effTo], then follow every `properties.nextLink` — RE-POSTING THE ORIGINAL
 * BODY VERBATIM on each page (committee blocker, SPEC §4/§6.7). The $skiptoken rides in
 * the nextLink URL; the body is NEVER dropped — sending `undefined` there drops the
 * query and yields a 400/empty page, silently truncating the result.
 *
 * The paging cursor is IN-SCAN ONLY (a local loop variable, never persisted across
 * scans): a crash simply restarts the window from page 1, which is safe precisely
 * because the caller's apply is an OVERWRITE keyed by (scope, date, dims) (SPEC §2).
 *
 * The loss-safety contract lives in the CALLER: persist `watermarkNext` only after the
 * window's rows are durable (no eager ack), and APPLY BY OVERWRITE — DELETE+INSERT /
 * UPSERT over [restatedFrom, watermarkNext], never a blind INSERT (SPEC §2 Forbidden #2:
 * an append double-counts on every restatement).
 */
export async function collectCost(
  postJson: (url: string, body: unknown) => Promise<Record<string, unknown>>,
  args: CollectArgs,
): Promise<CostResult> {
  const restatedFrom = restatementFloor(args.from, args.cost_type, args.lookbackDays);
  const watermarkNext = args.to;
  const keyCols = keyColumns(args.group_by);
  // The ONE original body, reused verbatim on every page.
  const body = costQueryBody(restatedFrom, watermarkNext, {
    granularity: args.granularity,
    groupBy: args.group_by,
    costType: args.cost_type,
  });

  const rows: CostRow[] = [];
  let url = costQueryUrl(args.scope);
  let pages = 0;
  for (;;) {
    const raw = await postJson(url, body); // ← SAME body every page (never undefined)
    pages++;
    const page = decodePage(raw);
    rows.push(...mapPage(page.columns, page.rows, keyCols));
    if (page.nextLink) {
      url = page.nextLink; // follow the continuation URL VERBATIM
      continue;
    }
    break;
  }

  return { rows, restatedFrom, watermarkNext, keyColumns: keyCols, pages };
}
