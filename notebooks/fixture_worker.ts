/** Run the unchanged Git-pinned cost function/catalog with its existing test seam.
 * Only the injected HTTP client differs from production. Authentication is not
 * exercised: all POSTs go to the notebook's synthetic loopback fixture. The real
 * function still constructs requests, follows pages, decodes rows and emits its
 * actual Arrow schema and restatement marker through the VGI SDK.
 */
import { FunctionRegistry, ReadOnlyCatalogInterface, Worker } from "@query-farm/vgi";
// launch_fixture.sh copies this adapter beside the remotely pinned source.
import { makeCostFunction } from "./src/functions.ts";
import { makeCatalog } from "./src/catalog.ts";

const rawBase = process.env.NOTEBOOK_AZURE_COST_FIXTURE_URL;
if (!rawBase) throw new Error("Start the notebook's synthetic HTTP fixture first");
const base = new URL(rawBase);
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") {
  throw new Error("This fixture launcher accepts only an HTTP loopback fixture");
}

const clientFactory = () => ({
  fetchJson: async () => { throw new Error("This fixture supports cost-query POSTs only"); },
  postJson: async (url: string, body: unknown): Promise<Record<string, unknown>> => {
    const original = new URL(url);
    if (original.origin !== "https://management.azure.com") {
      throw new Error("Unexpected upstream URL in the pinned cost function");
    }
    const local = new URL(original.pathname + original.search, base);
    const response = await fetch(local, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Synthetic fixture: ${response.status} ${await response.text()}`);
    return await response.json() as Record<string, unknown>;
  },
});

const functions = [makeCostFunction(clientFactory)];
const registry = new FunctionRegistry();
for (const fn of functions) registry.register(fn);
const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);
new Worker({ functions, catalogInterface }).run();
