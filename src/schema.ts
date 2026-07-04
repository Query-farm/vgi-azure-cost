// Arrow output schema + row→batch mapping for cost_query.
//
// RESTATEMENT-WATERMARK archetype: unlike resourcegraph (snapshot, no cursor) the scan
// carries a cross-scan cursor, so the schema closes with the strict marker columns; and
// unlike resourcegraph's single JSON blob, cost is WELL-TYPED here — Cost Management
// returns a real columnar `{columns, rows}` envelope, so we map it to named typed Arrow
// columns: an ISO `date`, one Utf8 column per grouping dimension, a Float64 `cost`, and
// a Utf8 `currency`.
//
// Schema is decided at onBind from `group_by` (SPEC §4 deferred-schema gotcha: the table
// schema must be known at bind, so we derive the dimension columns from the args, not
// from the first row). The dimension column names are the grouping-key names verbatim —
// they are exactly the overwrite key, so keeping them stable is load-bearing (§2 #3).
//
// Marker-row contract (graph-core §D): business rows carry `_row_kind` null; exactly ONE
// `_row_kind='marker'` row carries the cursor columns — `_watermark_next` (new high-water
// `to`), `_restated_from` (low edge of the overwritten window) and `_key_columns` (the
// ordered grouping-key column set, the §2 Forbidden #3 key-shape guard) — with every
// business column null.
//
// PII caveat (SPEC §4): a `TagKey:owner`/`TagKey:email` grouping can pull personal data
// into a dimension column, and those values ARE part of the overwrite key so they cannot
// simply be dropped — such a deployment must compose vgi-pii → vgi-mask with FPE so the
// masked value stays joinable as a key. Dimension groupings (ResourceGroup, ServiceName,
// Meter) are not PII-bearing.

import { Schema, Field, Utf8, Float64 } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import { ROW_KIND, MARKER, WATERMARK_NEXT } from "@vgi-azure/graph-core";
import { keyColumns, type CostRow } from "./cost-query.js";

export const DATE_COL = "date";
export const COST_COL = "cost";
export const CURRENCY_COL = "currency";
/** Cost-specific marker columns (alongside graph-core's `_watermark_next`). */
export const RESTATED_FROM_COL = "_restated_from";
export const KEY_COLUMNS_COL = "_key_columns";

/** Build the output schema for a given `group_by` (decided at onBind). One Utf8 column
 *  per grouping dimension, between the `date` and the `cost`/`currency` columns. */
export function costSchema(groupBy: string): Schema {
  const dims = keyColumns(groupBy);
  return new Schema([
    new Field(DATE_COL, new Utf8(), true),
    ...dims.map((d) => new Field(d, new Utf8(), true)),
    new Field(COST_COL, new Float64(), true),
    new Field(CURRENCY_COL, new Utf8(), true),
    new Field(ROW_KIND, new Utf8(), true),
    new Field(WATERMARK_NEXT, new Utf8(), true),
    new Field(RESTATED_FROM_COL, new Utf8(), true),
    new Field(KEY_COLUMNS_COL, new Utf8(), true),
  ]);
}

export interface CostMarker {
  /** New high-water `to` → `_watermark_next`. */ watermarkNext: string;
  /** Low edge of the overwritten window → `_restated_from`. */ restatedFrom: string;
  /** Ordered grouping-key column names → `_key_columns`. */ keyColumns: string[];
}

/**
 * Build one Arrow batch: the typed cost rows (`_row_kind` null and all marker columns
 * null — consumers read data via `WHERE _row_kind IS NULL`) followed by exactly ONE
 * strict marker row carrying `_watermark_next` / `_restated_from` / `_key_columns` with
 * every business column null. N+1 rows in one batch keep the cursor atomic with its
 * data. There is NO authoritative per-row watermark — the committed window edges are
 * only knowable after the last page, so they live solely on the marker row.
 */
export function buildCostBatch(schema: Schema, groupBy: string, rows: CostRow[], marker: CostMarker) {
  const dims = keyColumns(groupBy);
  const cols: Record<string, unknown[]> = {
    [DATE_COL]: [],
    [COST_COL]: [],
    [CURRENCY_COL]: [],
    [ROW_KIND]: [],
    [WATERMARK_NEXT]: [],
    [RESTATED_FROM_COL]: [],
    [KEY_COLUMNS_COL]: [],
  };
  for (const d of dims) cols[d] = [];

  for (const r of rows) {
    cols[DATE_COL]!.push(r.date);
    for (const d of dims) cols[d]!.push(r.dims[d] ?? null);
    cols[COST_COL]!.push(r.cost);
    cols[CURRENCY_COL]!.push(r.currency);
    cols[ROW_KIND]!.push(null); // business row
    cols[WATERMARK_NEXT]!.push(null);
    cols[RESTATED_FROM_COL]!.push(null);
    cols[KEY_COLUMNS_COL]!.push(null);
  }

  // The single strict marker row: all business cols null, cursor edges on the marker.
  cols[DATE_COL]!.push(null);
  for (const d of dims) cols[d]!.push(null);
  cols[COST_COL]!.push(null);
  cols[CURRENCY_COL]!.push(null);
  cols[ROW_KIND]!.push(MARKER);
  cols[WATERMARK_NEXT]!.push(marker.watermarkNext);
  cols[RESTATED_FROM_COL]!.push(marker.restatedFrom);
  cols[KEY_COLUMNS_COL]!.push(marker.keyColumns.join(","));

  return batchFromColumns(cols as Record<string, unknown[]>, schema);
}
