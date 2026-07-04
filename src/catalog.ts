// The `azure` catalog descriptor + the azure_graph secret type. The secret shape is the
// frozen app-only client-credentials seam owned by the directory worker and reused
// VERBATIM across every vgi-azure worker (conformance checklist). Cost Management
// requests the ARM audience, but that binding lives in the worker's clientFactory
// (audience: 'arm'), NOT in the secret type — the same secret mints tokens for any
// audience, isolated by the (tenant_id, client_id, AUDIENCE) 3-tuple cache key.

import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import type { CatalogDescriptor, SecretTypeDescriptor, VgiFunction } from "@query-farm/vgi";

export const AZURE_GRAPH_SECRET: SecretTypeDescriptor = {
  name: "azure_graph",
  description: "Microsoft Entra app-only (client-credentials) credentials for Azure ARM / Microsoft Graph",
  schema: new Schema([
    new Field("tenant_id", new Utf8(), true),
    new Field("client_id", new Utf8(), true),
    new Field("client_secret", new Utf8(), true, new Map([["redact", "true"]])),
  ]),
};

export function makeCatalog(functions: VgiFunction[]): CatalogDescriptor {
  return {
    name: "azure",
    defaultSchema: "main",
    comment:
      "Azure Cost Management (actual/amortized cost) as typed DuckDB rows over a restatement-aware " +
      "date watermark — apply by OVERWRITE keyed on (scope,date,dims) — vgi-azure-cost",
    sourceUrl: "https://query.farm",
    secretTypes: [AZURE_GRAPH_SECRET],
    schemas: [{ name: "main", functions }],
  };
}
