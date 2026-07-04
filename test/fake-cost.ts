// A tiny stateful fake of the Cost Management /query endpoint — enough to prove the
// restatement-watermark archetype: it RECORDS every POST body it was handed (so the
// test can assert the ORIGINAL body is re-POSTed on continuation pages, not dropped),
// serves a multi-page `properties.nextLink` chain, and can RESTATE a prior day's cost so
// the overwrite-keyed apply can be proven idempotent. No network. Used only by the test.
//
// Shape mirrors directory/test/fake-graph.ts + loganalytics/test/fake-loganalytics.ts:
// a stateful fake with a postJson method matching graph-core's GraphClient.postJson.

export interface CostColumnDef {
  name: string;
  type: string;
}

/** A recorded POST: the URL and the (deep-cloned) request body. */
export interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/** One canned response page: its rows + whether a nextLink follows. */
export interface CannedPage {
  rows: unknown[][];
}

const HOST = "https://management.azure.com";

export class FakeCost {
  /** Every POST this fake received, in order (assert the wire contract on these). */
  readonly calls: Captured[] = [];

  constructor(
    private readonly columns: CostColumnDef[],
    /** The pages, in order; page i>0 is reached via a `$skiptoken=i` nextLink. */
    private pages: CannedPage[],
    private readonly scope: string = "subscriptions/sub-1",
  ) {}

  /** Replace the canned pages (e.g. after a restatement between scans). */
  setPages(pages: CannedPage[]): void {
    this.pages = pages;
  }

  private nextLink(i: number): string {
    return `${HOST}/${this.scope}/providers/Microsoft.CostManagement/query?api-version=2023-03-01&$skiptoken=${i}`;
  }

  /** Matches graph-core GraphClient.postJson(url, body) → Cost Management envelope. */
  postJson = async (url: string, body: unknown): Promise<Record<string, unknown>> => {
    this.calls.push({ url, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown> });

    const sk = new URL(url).searchParams.get("$skiptoken");
    const i = sk ? Number(sk) : 0;
    const page = this.pages[i];
    if (!page) throw new Error(`FakeCost: no page ${i}`);

    const properties: Record<string, unknown> = { columns: this.columns, rows: page.rows };
    if (i + 1 < this.pages.length) properties.nextLink = this.nextLink(i + 1);
    return { properties };
  };
}
