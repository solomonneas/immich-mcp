import { describe, it, expect, beforeEach } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";

installFakeSdk();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSystemTools } from "../src/tools/system.js";

const cfg = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  const tool = reg[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler(args, {});
}

describe("system tools", () => {
  let server: McpServer;
  beforeEach(() => {
    resetFakeSdk();
    server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerSystemTools(server, cfg);
  });

  it("immich_ping calls pingServer", async () => {
    mockSdkResponse("pingServer", { res: "pong" });
    const out = await callTool(server, "immich_ping");
    expect(sdkCalls[0]?.fn).toBe("pingServer");
    expect(JSON.stringify(out)).toContain("pong");
  });

  it("immich_get_server_info calls getServerConfig", async () => {
    mockSdkResponse("getServerConfig", { loginPageMessage: "" });
    await callTool(server, "immich_get_server_info");
    expect(sdkCalls.some((c) => c.fn === "getServerConfig")).toBe(true);
  });

  it("immich_get_server_statistics calls getServerStatistics", async () => {
    mockSdkResponse("getServerStatistics", { photos: 0, videos: 0 });
    await callTool(server, "immich_get_server_statistics");
    expect(sdkCalls[0]?.fn).toBe("getServerStatistics");
  });

  it("immich_get_capabilities calls getServerFeatures", async () => {
    mockSdkResponse("getServerFeatures", { search: true });
    await callTool(server, "immich_get_capabilities");
    expect(sdkCalls[0]?.fn).toBe("getServerFeatures");
  });

  it("immich_get_storage calls getStorage", async () => {
    mockSdkResponse("getStorage", { diskAvailable: "100GB" });
    await callTool(server, "immich_get_storage");
    expect(sdkCalls[0]?.fn).toBe("getStorage");
  });
});
