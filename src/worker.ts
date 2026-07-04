// vgi-azure-cost stdio worker entry. DuckDB spawns this and ATTACHes it:
//   ATTACH 'cost' AS cost (TYPE vgi, LOCATION '/path/to/worker.ts');
//   CREATE SECRET a (TYPE azure_graph, TENANT_ID '…', CLIENT_ID '…', CLIENT_SECRET '…');
//   -- daily actual cost by resource group over a trailing restatement window:
//   SELECT * FROM cost.cost_query(
//     scope := 'subscriptions/<guid>', from := '2026-06-01', to := '2026-06-30',
//     granularity := 'Daily', group_by := 'Dimension:ResourceGroup');
//   -- incremental: pass the prior scan's _watermark_next back as `from`, then APPLY BY
//   --   OVERWRITE over [_restated_from, _watermark_next] keyed on (scope,date,dims).
//
// AUDIENCE = arm: Cost Management lives on the ARM control plane, so the clientFactory
// below hands the query a https://management.azure.com/.default token — NEVER a
// graph.microsoft.com token. The (tenant_id, client_id, AUDIENCE) cache key in graph-core
// enforces the binding so an ARM caller is never served a Graph token (and vice-versa).

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { TokenCache, makeGraphClient, type Fetch } from "@vgi-azure/graph-core";
import { makeMsalMinter } from "@vgi-azure/node-auth";
import { makeCostFunction } from "./functions.js";
import { makeCatalog } from "./catalog.js";

const cache = new TokenCache(makeMsalMinter());

const clientFactory = (secret: Record<string, unknown>) =>
  makeGraphClient({
    fetch: globalThis.fetch as unknown as Fetch,
    cache,
    cred: {
      tenantId: String(secret.tenant_id ?? ""),
      clientId: String(secret.client_id ?? ""),
      clientSecret: secret.client_secret != null ? String(secret.client_secret) : undefined,
    },
    audience: "arm", // ARM control plane — https://management.azure.com/.default
  });

const functions = [makeCostFunction(clientFactory)];

const registry = new FunctionRegistry();
for (const f of functions) registry.register(f);

const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);

new Worker({ functions, catalogInterface }).run();
