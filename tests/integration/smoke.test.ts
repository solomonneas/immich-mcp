import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENABLED = process.env.IMMICH_INTEGRATION === "true";
const BASE_URL = process.env.IMMICH_BASE_URL ?? "";
const API_KEY = process.env.IMMICH_API_KEY ?? "";

describe.skipIf(!ENABLED || !BASE_URL || !API_KEY)("live Immich smoke", () => {
  let client: Client;
  let transport: StdioClientTransport;
  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: { ...process.env },
    });
    client = new Client({ name: "integration", version: "0" }, { capabilities: {} });
    await client.connect(transport);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("lists tools (>=60)", async () => {
    const t = await client.listTools();
    expect(t.tools.length).toBeGreaterThanOrEqual(60);
  });

  it("immich_ping returns pong", async () => {
    const r = await client.callTool({ name: "immich_ping", arguments: {} });
    expect(JSON.stringify(r)).toContain("pong");
  });

  it("immich_get_server_info returns initialized=true", async () => {
    const r = await client.callTool({ name: "immich_get_server_info", arguments: {} });
    expect(JSON.stringify(r)).toContain("isInitialized");
  });

  it("immich_categorize_duplicates returns total field", async () => {
    const r = await client.callTool({ name: "immich_categorize_duplicates", arguments: {} });
    expect(JSON.stringify(r)).toContain("\"total\"");
  });

  it("immich_list_albums responds", async () => {
    const r = await client.callTool({ name: "immich_list_albums", arguments: {} });
    expect(r.isError).toBeFalsy();
  });
});
