# Azure Cost Management notebooks

[01 · When yesterday's cost changes](01_when_yesterdays_cost_changes.ipynb) follows
two incremental loads, including revisions to already-loaded days. SQL compares
blind append with replacement of the worker's returned window, then checks both
against an explicit fresh full-window scan. The saved notebook includes outputs
and two figures; all accounting data is synthetic.

## Install and run

Install [uv](https://docs.astral.sh/uv/), [Bun](https://bun.sh/) and Git. Bun
**1.3.14** was used for validation. This directory can be copied away from the
worker repository; it needs no parent checkout or root environment. From here:

```sh
uv sync --locked
uv run --locked python execute.py --timeout 300
```

The separate Python lock pins Haybarn **2.0.0rc11**, JupySQL, plotting and execution
tools. The runner creates a temporary kernel using its interpreter and executes
with this directory as cwd. It atomically replaces a notebook only after success.
Overrides require a separate destination. For an existing Jupyter frontend:

```sh
uv run --locked python -m ipykernel install --user \
  --name vgi-azure-cost-notebooks --display-name "Python (vgi-azure-cost notebooks)"
```

Select that kernel and **Restart Kernel → Run All** after editing parameters.
The runner does not register a global kernel. First runs require downloads.

## Two visible, portable connections

The notebook first attaches the actual native release with the literal location
`github-auto://Query-farm/vgi-azure-cost@v0.4.0`. Haybarn verifies and caches its
platform archive. That connection reads the credential-free dimensions manifest;
the native cost function's schema was also verified with a `LIMIT 0` bind probe.

The analytical connection uses the literal location `bash launch_fixture.sh`.
That small Bun/Git launcher clones the public remote revision
**8caf65fa35163e1cea5e8a9e656963d3dec80e73** into ignored `artifacts/`, verifies the
revision and unchanged source, and runs `bun install --frozen-lockfile` using
that revision's committed lock. Its SDK pins include `@query-farm/vgi 0.50.0`,
`@query-farm/vgi-rpc 0.29.7`, and Arrow 21.1.1. This source revision includes the
corrected bare-date `_restated_from` marker. There is no local worker build and
no source discovery outside this notebook directory.

`fixture_worker.ts` is an inspectable transport adapter. It imports the unchanged
remote `makeCostFunction` and `makeCatalog`, registers them with the real VGI SDK,
and uses the existing `ClientFactory` injection seam also used by the worker's
tests. The worker still constructs the query body, follows continuation links,
decodes rows and emits its own Arrow schema and marker. The adapter replaces only
the client: it maps the expected Azure endpoint URL to loopback and forwards the
original POST body. It rejects other upstream origins and non-loopback fixtures.

This explicitly tests the real function with a synthetic transport; it does **not**
exercise native-binary cost retrieval, Microsoft Entra authentication, permissions,
retry behavior or a real Azure account. The SQL secret is a public dummy value.
No environment credentials are read, no requests are forwarded to Azure, and no
private data is saved. The native and fixture connections are labelled separately.

## Focused experiment

```sh
uv run --locked python execute.py --timeout 300 \
  --parameters '{"LOOKBACK_DAYS": 0}' --output-dir artifacts/no-lookback
```

The default is **7**; accepted integers are **0–7**. Predict that the replacement
target remains unique but misses revisions before the previous watermark. Compare
the second batch's lower bound, the target totals, and the replacement error in
the second figure. Application checks should still pass: they verify correct
application inside the returned window, not a guarantee that older data is final.
Reset to **7** for the default.

Experiment copies carry the guide, runner, launcher, fixture, helper, lock and
branding assets. Generated source caches, logs, charts and experiments are ignored.

## Fixture and accounting semantics

`synthetic_cost_api.py` implements one local HTTP cost-query endpoint. Its columnar
envelope and pagination follow `test/fake-cost.ts` in the pinned source (Query Farm,
MIT). It returns at most three rows per page and records request bodies so the
notebook can verify unchanged continuation payloads. Unsupported endpoints,
windows, grouping or cost type fail explicitly; there is no live fallback.

Coverage is **17–30 June 2026 UTC, inclusive**. There are no ledger entries before
24 June. The first load ends on 28 June. The revised snapshot raises a compute
entry on 25 June by USD 22 and removes a USD 10 storage entry on 26 June; later days
also become available. These are invented ledger adjustments, not recorded spend,
model prices or a forecast. The full reference scan is a deliberate validation
request against that same revised snapshot.

Business rows have `_row_kind IS NULL`; the single marker is control information.
Its `_restated_from` and `_watermark_next` define the inclusive replacement window.
Zero lookback still overlaps the prior watermark day. The target key includes
scope, date and ResourceGroup; a changed grouping-key shape requires a full reload.
Only USD is used. Costs are Float64, and SQL comparisons use a stated tolerance.
Missing/removed ledger rows are not fabricated as incoming zero-valued records.

All tables and the stored watermark are in memory. The notebook demonstrates the
update sequence; it does not implement durable crash recovery. In production, data
replacement and the watermark must commit atomically on one transactional
connection. A fixed seven-day lookback catches this fixture's revisions without
guaranteeing that all real late adjustments will be covered.

## Validation and upgrades

The source suite passes 10 Bun tests (42 expectations) and own-source typechecking.
The CI-prescribed structural metadata check with vgi-lint 2.5.1 reports 100/100,
L1 structural assurance, and zero findings; it intentionally does not run live
cost examples. Notebook execution supplies a separate SQL/HTTP fixture check.

The launcher uses the remote revision's frozen lock because a fresh nested Bun
Git dependency resolution failed on the transitive bare Git reference. It never
changes the user's root lock. To upgrade, change the explicit release/revision
pins, inspect the remote lock, rerun both parameter sets, and review the figures
before replacing successful saved outputs. The community VGI extension is
downloaded independently of the Python lock.

The unchanged local Strata Sun and VGI marks link to Query.Farm and VGI.

## SQL credential isolation

The notebook creates Haybarn with a fresh temporary `secret_directory` and
`allow_persistent_secrets=False` before attaching workers. It fully drains and
checks an empty secret inventory, then creates only explicitly `TEMPORARY`
public fixture secrets and verifies their `persistent=false`, `storage=memory`
metadata. Cleanup removes the temporary directory after closing the connection.
Existing user SQL secrets are neither read, modified nor deleted.
