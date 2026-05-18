import { describe, it, expect, beforeEach } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSharedLinkTools } from "../src/tools/shared-links.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const cfgWrite = { ...cfgRead, allowWrites: true };
const UUID_A = "00000000-0000-0000-0000-000000000001";

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  return reg[name]!.handler(args, {});
}

describe("shared link tools - reads", () => {
  let server: McpServer;
  beforeEach(() => {
    resetFakeSdk();
    server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerSharedLinkTools(server, cfgRead);
  });
  it("immich_list_shared_links calls getAllSharedLinks", async () => {
    mockSdkResponse("getAllSharedLinks", []);
    await callTool(server, "immich_list_shared_links");
    expect(sdkCalls[0]?.fn).toBe("getAllSharedLinks");
  });
  it("immich_get_shared_link calls getSharedLinkById", async () => {
    mockSdkResponse("getSharedLinkById", { id: UUID_A });
    await callTool(server, "immich_get_shared_link", { id: UUID_A });
    expect(sdkCalls[0]?.fn).toBe("getSharedLinkById");
  });
});

describe("shared link tools - gates", () => {
  it("immich_create_shared_link refuses without writes", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerSharedLinkTools(server, cfgRead);
    const out = await callTool(server, "immich_create_shared_link", { type: "ALBUM", albumId: UUID_A }) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });
  it("immich_create_shared_link calls createSharedLink with writes", async () => {
    resetFakeSdk();
    mockSdkResponse("createSharedLink", { id: UUID_A });
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerSharedLinkTools(server, cfgWrite);
    await callTool(server, "immich_create_shared_link", { type: "ALBUM", albumId: UUID_A });
    expect(sdkCalls[0]?.fn).toBe("createSharedLink");
  });
  it("immich_update_shared_link calls updateSharedLink", async () => {
    resetFakeSdk();
    mockSdkResponse("updateSharedLink", { id: UUID_A });
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerSharedLinkTools(server, cfgWrite);
    await callTool(server, "immich_update_shared_link", { id: UUID_A, allowDownload: false });
    expect(sdkCalls[0]?.fn).toBe("updateSharedLink");
  });
  it("immich_delete_shared_link refuses without confirm", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerSharedLinkTools(server, cfgWrite);
    const out = await callTool(server, "immich_delete_shared_link", { id: UUID_A }) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });
  it("immich_delete_shared_link with confirm proceeds", async () => {
    resetFakeSdk();
    mockSdkResponse("removeSharedLink", undefined);
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerSharedLinkTools(server, cfgWrite);
    const out = await callTool(server, "immich_delete_shared_link", { id: UUID_A, confirm: true }) as { isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(sdkCalls[0]?.fn).toBe("removeSharedLink");
  });
});
