// Worker-wiring proof: cost_query registers and the azure catalog advertises it with
// the frozen azure_graph secret type. Imports the SDK, so it runs under the central
// workspace install alongside the sibling packages.

import { test, expect } from "bun:test";
import { FunctionRegistry, ReadOnlyCatalogInterface } from "@query-farm/vgi";
import { makeCostFunction } from "../src/functions.js";
import { makeCatalog, AZURE_GRAPH_SECRET } from "../src/catalog.js";
import { FakeCost } from "./fake-cost.js";

test("cost_query registers and the azure catalog advertises it (azure_graph secret)", () => {
  const g = new FakeCost([{ name: "Cost", type: "Number" }], [{ rows: [] }]);
  const clientFactory = () => ({ postJson: g.postJson, fetchJson: async () => ({}) });

  const functions = [makeCostFunction(clientFactory)];
  expect(functions.length).toBe(1);

  const registry = new FunctionRegistry();
  for (const f of functions) registry.register(f);

  const cat = makeCatalog(functions);
  expect(cat.name).toBe("azure");
  expect(cat.secretTypes?.[0]).toBe(AZURE_GRAPH_SECRET);
  expect(cat.schemas[0]!.functions!.map((f) => (f as { meta: { name: string } }).meta.name)).toEqual(["cost_query"]);

  // Constructs the read-only catalog interface without throwing.
  new ReadOnlyCatalogInterface(cat, registry);
});
