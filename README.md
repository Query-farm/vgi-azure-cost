# vgi-azure-cost

A [VGI](https://query.farm) worker (**Azure Cost Management**) for DuckDB. Azure Cost Management actual and amortized cost as typed DuckDB rows. The `cost_query` table function pulls a subscription's, resource group's, billing account's or management group's spend by day or month over a trailing restatement window, optionally grouped by dimension (ResourceGroup, ServiceName, Meter, ...) or tag key, as (date, grouping dims, cost, currency) rows plus a marker row carrying the next watermark. Azure restates past days' costs, so apply results by overwriting the window `[_restated_from, _watermark_next]` keyed on (scope, date, grouping dims), never by a blind `INSERT`. A credential-free `dimensions` view lists the `group_by` tokens `cost_query` accepts.

## Quick start

Every [GitHub release](https://github.com/Query-farm/vgi-azure-cost/releases) ships a prebuilt worker binary. The `vgi` extension downloads the one for your platform, checks its SHA-256 and caches it, so there is nothing to install besides DuckDB:

```sql
INSTALL vgi FROM community;
LOAD vgi;

ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-azure-cost@v0.2.1');

-- Bind cost_query and expose its result columns (credential-free; drop LIMIT 0 and
-- attach an azure_graph secret to pull real daily cost)
SELECT date, cost, currency FROM azure.main.cost_query('subscriptions/00000000-0000-0000-0000-000000000000', '2026-01-01', '2026-01-31') LIMIT 0;

-- Bind cost_query grouped by resource group and expose its result columns, including the
-- ResourceGroup dimension column (credential-free)
SELECT date, "ResourceGroup", cost, currency FROM azure.main.cost_query('subscriptions/00000000-0000-0000-0000-000000000000', '2026-01-01', '2026-01-31', group_by := 'Dimension:ResourceGroup') LIMIT 0;
```

The examples are credential-free `LIMIT 0` bind probes: they check that each function binds and show its result columns without calling Azure. To pull real rows, create an `azure_graph` secret (see [Credentials](#credentials)) and drop the `LIMIT 0`.

All the Query Farm Azure workers use the catalog name `azure`. To attach more than one in the same session, give each its own alias (for example `ATTACH 'azure' AS azure_cost (...)`) and qualify queries with that alias instead of `azure`.

Prebuilt binaries cover macOS (Apple silicon), Linux (x86-64 and arm64). `github-auto://` needs an explicit release tag; change `@v0.2.1` to move to a newer release.

### Other ways to run it

- **Docker** (the image bundles the worker; needs a container runtime):

  ```sql
  ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'docker://ghcr.io/query-farm/vgi-azure-cost:0.2.1');
  ```

- **Manual download.** Download the archive for your platform from the [releases page](https://github.com/Query-farm/vgi-azure-cost/releases), verify it against its `.sha256` file (a cosign `.cosign.bundle` is published alongside), unpack it, and set `LOCATION` to the path of the extracted worker executable.

### Build from source

To build and test the worker yourself, see [Development](#development).

## Credentials

Live queries authenticate with an `azure_graph` secret holding app-only Microsoft Entra client credentials for a service principal: `TENANT_ID`, `CLIENT_ID` and `CLIENT_SECRET` (the client secret is redacted when secrets are listed). The worker registers the `azure_graph` secret type when it is attached, so create the secret after the `ATTACH`:

```sql
ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-azure-cost@v0.2.1');
CREATE SECRET azure_sp (TYPE azure_graph, TENANT_ID '<tenant-guid>', CLIENT_ID '<app-guid>', CLIENT_SECRET '<secret>');
```

For this worker the service principal needs Cost Management reader access on the scope being queried (tokens are minted for the Azure Resource Manager audience).

## Development

Requires [Bun](https://bun.sh). `bun install` also fetches the shared `@vgi-azure/graph-core` package from GitHub.

```bash
bun install && bun test
bun run typecheck
```

To attach a local checkout, point `LOCATION` at the launch wrapper:

```sql
ATTACH 'azure' AS azure (TYPE vgi, LOCATION '/path/to/vgi-azure-cost/bin/vgi-azure-cost-worker');
```

## License

MIT. See [LICENSE](LICENSE).
