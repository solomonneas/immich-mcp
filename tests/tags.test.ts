import { describe, it, expect, beforeEach } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTagTools } from "../src/tools/tags.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const cfgWrite = { ...cfgRead, allowWrites: true };
const UUID_A = "00000000-0000-0000-0000-000000000001";
const UUID_B = "00000000-0000-0000-0000-000000000002";

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  return reg[name]!.handler(args, {});
}

describe("tag tools - reads", () => {
  let server: McpServer;
  beforeEach(() => {
    resetFakeSdk();
    server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerTagTools(server, cfgRead);
  });
  it("immich_list_tags calls getAllTags", async () => {
    mockSdkResponse("getAllTags", []);
    await callTool(server, "immich_list_tags");
    expect(sdkCalls[0]?.fn).toBe("getAllTags");
  });
  it("immich_get_tag calls getTagById", async () => {
    mockSdkResponse("getTagById", { id: UUID_A });
    await callTool(server, "immich_get_tag", { id: UUID_A });
    expect(sdkCalls[0]?.fn).toBe("getTagById");
  });
});

describe("tag tools - gates", () => {
  it("immich_create_tag refuses without writes", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerTagTools(server, cfgRead);
    const out = await callTool(server, "immich_create_tag", { name: "travel" }) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });
  it("immich_delete_tag refuses without confirm", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerTagTools(server, cfgWrite);
    const out = await callTool(server, "immich_delete_tag", { id: UUID_A }) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });
  it("immich_delete_tag with confirm proceeds", async () => {
    resetFakeSdk();
    mockSdkResponse("deleteTag", undefined);
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerTagTools(server, cfgWrite);
    const out = await callTool(server, "immich_delete_tag", { id: UUID_A, confirm: true }) as { isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(sdkCalls[0]?.fn).toBe("deleteTag");
  });
  it("immich_add_tag_to_assets calls tagAssets", async () => {
    resetFakeSdk();
    mockSdkResponse("tagAssets", undefined);
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerTagTools(server, cfgWrite);
    await callTool(server, "immich_add_tag_to_assets", { id: UUID_A, assetIds: [UUID_B] });
    expect(sdkCalls[0]?.fn).toBe("tagAssets");
  });
  it("immich_remove_tag_from_assets calls untagAssets", async () => {
    resetFakeSdk();
    mockSdkResponse("untagAssets", undefined);
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerTagTools(server, cfgWrite);
    await callTool(server, "immich_remove_tag_from_assets", { id: UUID_A, assetIds: [UUID_B] });
    expect(sdkCalls[0]?.fn).toBe("untagAssets");
  });
});
