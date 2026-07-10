// The `azure` catalog descriptor + the azure_graph secret type. The secret shape is the
// frozen app-only client-credentials seam owned by the directory worker and reused
// VERBATIM across every vgi-azure worker (conformance checklist). Cost Management
// requests the ARM audience, but that binding lives in the worker's clientFactory
// (audience: 'arm'), NOT in the secret type — the same secret mints tokens for any
// audience, isolated by the (tenant_id, client_id, AUDIENCE) 3-tuple cache key.
//
// This file also carries the catalog- and schema-level vgi.* documentation/discovery
// tags that vgi-lint grades. Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags
// (keywords/categories/executable_examples/agent_test_tasks/example_queries) are JSON
// strings; every example SQL is catalog-qualified (azure.main.cost_query) so it binds
// when the catalog is attached. A LIVE cost query requires an attached `azure_graph`
// secret plus a network call to Azure Cost Management, so the executable examples are
// credential-free `LIMIT 0` bind probes (onBind derives the schema; process() — where
// the secret and network live — is never pumped).

import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import type { CatalogDescriptor, SecretTypeDescriptor, VgiFunction } from "@query-farm/vgi";

const REPO = "https://github.com/Query-farm/vgi-azure-cost";
const ISSUES = `${REPO}/issues`;

export const AZURE_GRAPH_SECRET: SecretTypeDescriptor = {
  name: "azure_graph",
  description: "Microsoft Entra app-only (client-credentials) credentials for Azure ARM / Microsoft Graph",
  schema: new Schema([
    new Field("tenant_id", new Utf8(), true),
    new Field("client_id", new Utf8(), true),
    new Field("client_secret", new Utf8(), true, new Map([["redact", "true"]])),
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Azure Cost Management",
  "vgi.doc_llm":
    "Azure Cost Management actual and amortized cost as typed DuckDB rows over a trailing " +
    "RESTATEMENT window. Reach for it to pull a subscription's, resource group's, billing " +
    "account's, or management group's spend by day/month, optionally grouped by dimension " +
    "(ResourceGroup, ServiceName, Meter, …) or tag key, as (date, grouping dims, Float64 cost, " +
    "currency) rows. Azure restates past-day costs for days-to-weeks (amortization, late metered " +
    "usage, credits, refunds, tax), so each scan re-pulls a trailing window [from−lookback, to] " +
    "and the caller MUST apply by OVERWRITE keyed on (scope, date, grouping dims) — never a blind " +
    "INSERT, which double-counts. The new high-water `to` rides back on a marker row as " +
    "_watermark_next (persist it as the next `from` only after the rows are durable); _restated_from " +
    "is the low edge of the window to overwrite; _key_columns guards the group_by key shape (a " +
    "change is a full reload, not an incremental resume). Requires an app-only (client-credentials) " +
    "'azure_graph' secret (tenant_id, client_id, client_secret) whose service principal has Cost " +
    "Management reader access on the queried scope; tokens are minted for the ARM audience.",
  "vgi.doc_md":
    "## Azure Cost Management\n\n" +
    "Azure Cost Management actual/amortized cost as typed DuckDB rows over a restatement-aware date " +
    "watermark, exposed as one DuckDB table function.\n\n" +
    "- **`cost_query`** — Actual or amortized cost for an ARM scope over a trailing restatement " +
    "window, as (date, grouping dims, Float64 cost, currency) rows plus a marker row carrying the " +
    "next watermark.\n\n" +
    "Read data rows with `WHERE _row_kind IS NULL`. Take the next `from` watermark from the single " +
    "marker row's `_watermark_next`, and OVERWRITE the window `[_restated_from, _watermark_next]` " +
    "keyed on (scope, date, grouping dims) — never a blind INSERT (that double-counts on every " +
    "restatement). An app-only `azure_graph` secret (Microsoft Entra client credentials with Cost " +
    "Management reader access) is required; tokens are minted for the ARM audience.",
  "vgi.keywords": JSON.stringify([
    "azure",
    "cost management",
    "finops",
    "billing",
    "spend",
    "cost",
    "amortized cost",
    "actual cost",
    "subscription",
    "resource group",
    "restatement",
    "watermark",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // Guaranteed-runnable, catalog-qualified example (VGI509/VGI906). A LIVE cost query
  // needs an attached azure_graph secret and a network call to Azure Cost Management, so
  // this is a credential-free `LIMIT 0` bind probe: onBind derives the schema from the
  // group_by argument (no secret needed) and exposes the result columns without fetching,
  // while process() — where the secret and network live — is never pumped. Drop the
  // `LIMIT 0` and attach an azure_graph secret to pull real cost. The scope/from/to
  // placeholders are syntactically valid but never dereferenced by a bind probe. The
  // fuller, data-returning queries live in the function's `examples` and the schema
  // `example_queries` (which are NOT executed by the linter).
  "vgi.executable_examples": JSON.stringify([
    {
      name: "cost_bind_probe",
      description:
        "Bind cost_query and expose its result columns (credential-free; drop LIMIT 0 and attach an azure_graph secret to pull real daily cost)",
      sql:
        "SELECT date, cost, currency FROM azure.main.cost_query(" +
        "'subscriptions/00000000-0000-0000-0000-000000000000', '2026-01-01', '2026-01-31') LIMIT 0",
    },
    {
      name: "cost_grouped_bind_probe",
      description:
        "Bind cost_query grouped by resource group and expose its result columns, including the ResourceGroup dimension column (credential-free)",
      sql:
        "SELECT date, \"ResourceGroup\", cost, currency FROM azure.main.cost_query(" +
        "'subscriptions/00000000-0000-0000-0000-000000000000', '2026-01-01', '2026-01-31', " +
        "group_by := 'Dimension:ResourceGroup') LIMIT 0",
    },
    {
      name: "list_group_by_dimensions",
      description:
        "Browse the credential-free dimensions manifest to discover the group_by tokens cost_query accepts (runs with no secret)",
      sql: "SELECT token, kind FROM azure.main.dimensions ORDER BY kind, token",
    },
  ]),
  // The agent-suitability suite (VGI152), catalog only. Cost queries require an
  // azure_graph secret and return tenant-/scope-specific, restatement-mutable and
  // non-deterministic data, so those tasks are graded by success_criteria (LLM judge)
  // rather than an exact-compare reference_sql (which would need live credentials and
  // stable ground truth). The reference_sql on the first task is the canonical call
  // shape (it names cost_query so coverage counts it, VGI520) — not an exact-value
  // oracle. The credential-free `dimensions` view IS graded by an exact check_sql.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "daily_cost_by_resource_group",
      prompt:
        "Show the daily Azure cost for subscription 00000000-0000-0000-0000-000000000000 during January 2026, broken down by resource group.",
      reference_sql:
        "SELECT date, \"ResourceGroup\", cost, currency FROM azure.main.cost_query(" +
        "'subscriptions/00000000-0000-0000-0000-000000000000', '2026-01-01', '2026-01-31', " +
        "granularity := 'Daily', group_by := 'Dimension:ResourceGroup') WHERE _row_kind IS NULL",
      success_criteria:
        "The answer calls cost_query with scope := 'subscriptions/00000000-0000-0000-0000-000000000000', from := '2026-01-01', to := '2026-01-31', granularity := 'Daily', and group_by := 'Dimension:ResourceGroup', filters to data rows (_row_kind IS NULL), and returns date, the ResourceGroup dimension column, and cost.",
    },
    {
      name: "browse_group_by_dimensions",
      prompt: "Which values can I pass to cost_query's group_by argument to break the cost down?",
      check_sql: "SELECT count(*) > 0 FROM azure.main.dimensions WHERE kind = 'Dimension'",
      success_criteria:
        "The answer browses the azure.main.dimensions view (or otherwise lists valid group_by tokens such as Dimension:ResourceGroup, Dimension:ServiceName, and the TagKey:<name> template) and explains that a token value goes straight into cost_query's group_by argument.",
    },
    {
      name: "save_watermark",
      prompt: "After pulling cost, how do I get the value to pass as `from` on the next incremental scan?",
      success_criteria:
        "The answer selects _watermark_next from the marker row (_row_kind = 'marker') of cost_query(...) and explains it should be persisted (only after the rows are durable) and passed back as the `from` argument next time.",
    },
    {
      name: "overwrite_not_insert",
      prompt: "How should I apply each cost_query scan into my warehouse table so totals do not double-count?",
      success_criteria:
        "The answer explains that costs are restated retroactively, so each scan re-pulls a trailing window and the caller must apply by OVERWRITE (DELETE+INSERT / UPSERT) over [_restated_from, _watermark_next] keyed on (scope, date, grouping dims), never a blind INSERT.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Azure Cost",
  "vgi.doc_llm":
    "The Azure Cost Management query function. cost_query returns actual or amortized cost for an " +
    "ARM scope (subscription, resource group, billing account, management group) over a trailing " +
    "restatement window as typed rows — an ISO date, one column per requested grouping dimension, a " +
    "Float64 cost, and a currency — followed by one marker row whose _watermark_next is the high-water " +
    "`to` to persist as the next `from`. Because past-day costs are restated for days-to-weeks, each " +
    "scan re-pulls [from−lookback, to] and the caller overwrites that window keyed on (scope, date, " +
    "grouping dims). Requires an app-only azure_graph secret with Cost Management reader access.",
  "vgi.doc_md":
    "## Azure Cost Management query\n\n" +
    "| Function | Returns |\n" +
    "| --- | --- |\n" +
    "| `cost_query` | actual/amortized cost rows + restatement watermark marker |\n\n" +
    "Read data rows with `WHERE _row_kind IS NULL`; take the next `from` watermark from the single " +
    "marker row's `_watermark_next` and OVERWRITE `[_restated_from, _watermark_next]` keyed on " +
    "(scope, date, grouping dims). Requires an app-only `azure_graph` secret (ARM audience).",
  "vgi.keywords": JSON.stringify([
    "azure",
    "cost management",
    "finops",
    "billing",
    "spend",
    "actual cost",
    "amortized cost",
    "restatement",
    "watermark",
  ]),
  domain: "finops",
  // Ordered navigation registry; the function's vgi.category and the dimensions view's
  // vgi.category reference these `name`s.
  "vgi.categories": JSON.stringify([
    {
      name: "cost-management",
      title: "Cost Management",
      description:
        "Azure Cost Management actual/amortized spend as typed rows over a restatement-aware date watermark.",
    },
    {
      name: "discovery",
      title: "Discovery",
      description:
        "Credential-free browsable entry points that describe how to query the catalog before any secret or argument is supplied.",
    },
  ]),
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
      description: "Read the watermark to persist for the next incremental scan",
      sql:
        "SELECT _watermark_next, _restated_from, _key_columns FROM azure.main.cost_query(" +
        "'subscriptions/<guid>', '2026-06-01', '2026-06-30') WHERE _row_kind = 'marker'",
    },
  ]),
};

/** The credential-free discovery view: a static manifest of the `group_by` tokens
 *  cost_query accepts, so an agent has a browsable entry point (VGI146) — `SELECT * FROM
 *  azure.main.dimensions` — before guessing arguments. Self-contained VALUES, no worker
 *  RPC, so it binds and scans without an azure_graph secret. */
const DIMENSIONS_VIEW_TAGS: Record<string, string> = {
  domain: "finops",
  "vgi.category": "discovery",
  "vgi.title": "Cost Grouping Dimensions",
  "vgi.keywords": JSON.stringify([
    "dimensions",
    "group by",
    "grouping",
    "discovery",
    "manifest",
    "cost",
    "tag key",
  ]),
  "vgi.doc_llm":
    "A static, credential-free manifest of the grouping tokens the cost_query `group_by` argument " +
    "accepts. One row per token with its kind (Dimension or TagKey) and a one-line description. " +
    "Browse this view to learn which `group_by` values are valid before supplying credentials — " +
    "each `token` value drops straight into group_by (comma-join several to break cost down along " +
    "multiple axes). TagKey:<name> is a template: replace <name> with one of your own resource tag " +
    "keys such as costcenter or env.",
  "vgi.doc_md":
    "## dimensions\n\n" +
    "A credential-free manifest of the `group_by` tokens `cost_query` accepts — a browsable entry " +
    "point for discovery. Each row is one `token` (e.g. `Dimension:ResourceGroup`), its `kind` " +
    "(`Dimension` or `TagKey`), and a short `description`. Drop a `token` value straight into " +
    "`cost_query(..., group_by := <token>)`; comma-join several to group along multiple axes. " +
    "`TagKey:<name>` is a template — replace `<name>` with one of your resource tag keys.",
  "vgi.example_queries": JSON.stringify([
    {
      description: "List the Dimension group_by tokens cost_query accepts",
      sql: "SELECT token, description FROM azure.main.dimensions WHERE kind = 'Dimension' ORDER BY token",
    },
  ]),
};

const DIMENSIONS_VIEW_COLUMN_COMMENTS: Record<string, string> = {
  token: "The group_by token to pass to cost_query (e.g. Dimension:ResourceGroup or TagKey:costcenter).",
  kind: "Whether the token groups by a built-in cost Dimension or by a resource TagKey.",
  description: "A one-line summary of what grouping by this token produces.",
};

// A single-statement VALUES scan — self-contained, no worker call, so it binds and scans
// without an azure_graph secret. Column names/order are pinned by the trailing AS list.
const DIMENSIONS_VIEW_DEFINITION =
  "SELECT token, kind, description FROM (VALUES " +
  "('Dimension:ResourceGroup', 'Dimension', 'Cost grouped by Azure resource group.'), " +
  "('Dimension:ServiceName', 'Dimension', 'Cost grouped by Azure service (e.g. Virtual Machines, Storage).'), " +
  "('Dimension:MeterCategory', 'Dimension', 'Cost grouped by meter category.'), " +
  "('Dimension:MeterSubCategory', 'Dimension', 'Cost grouped by meter subcategory.'), " +
  "('Dimension:ResourceLocation', 'Dimension', 'Cost grouped by Azure region.'), " +
  "('Dimension:ResourceId', 'Dimension', 'Cost grouped by full ARM resource id.'), " +
  "('Dimension:ChargeType', 'Dimension', 'Cost grouped by charge type (Usage, Purchase, Refund).'), " +
  "('Dimension:PublisherType', 'Dimension', 'Cost grouped by publisher type (Azure, Marketplace, AWS).'), " +
  "('TagKey:<name>', 'TagKey', 'Cost grouped by a resource tag key — replace <name>, e.g. TagKey:costcenter or TagKey:env.')" +
  ") AS t(token, kind, description)";

export function makeCatalog(functions: VgiFunction[]): CatalogDescriptor {
  return {
    name: "azure",
    defaultSchema: "main",
    comment:
      "Azure Cost Management (actual/amortized cost) as typed DuckDB rows over a restatement-aware " +
      "date watermark — apply by OVERWRITE keyed on (scope,date,dims) — vgi-azure-cost",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    secretTypes: [AZURE_GRAPH_SECRET],
    schemas: [
      {
        name: "main",
        comment:
          "Azure Cost Management actual/amortized cost as typed rows over a restatement-aware date watermark.",
        tags: SCHEMA_TAGS,
        views: [
          {
            name: "dimensions",
            definition: DIMENSIONS_VIEW_DEFINITION,
            comment:
              "Credential-free manifest of the group_by tokens cost_query accepts (a browsable discovery entry point).",
            columnComments: DIMENSIONS_VIEW_COLUMN_COMMENTS,
            tags: DIMENSIONS_VIEW_TAGS,
          },
        ],
        functions,
      },
    ],
  };
}
