import { describe, it, expect, beforeEach } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";

installFakeSdk();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAssetTools } from "../src/tools/assets.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const cfgWrite = { ...cfgRead, allowWrites: true };

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  const tool = reg[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler(args, {});
}

describe("asset tools - reads", () => {
  let server: McpServer;
  beforeEach(() => {
    resetFakeSdk();
    server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAssetTools(server, cfgRead);
  });

  it("immich_list_assets calls searchAssets", async () => {
    mockSdkResponse("searchAssets", { assets: { items: [] } });
    await callTool(server, "immich_list_assets", { isFavorite: true });
    const call = sdkCalls.find((c) => c.fn === "searchAssets");
    expect(call).toBeTruthy();
  });

  it("immich_get_asset calls getAssetInfo", async () => {
    mockSdkResponse("getAssetInfo", { id: "abc" });
    await callTool(server, "immich_get_asset", { id: "00000000-0000-0000-0000-000000000001" });
    expect(sdkCalls[0]?.fn).toBe("getAssetInfo");
  });

  it("immich_get_asset_exif returns exifInfo subset", async () => {
    mockSdkResponse("getAssetInfo", { id: "abc", exifInfo: { make: "Sony" } });
    const out = await callTool(server, "immich_get_asset_exif", { id: "00000000-0000-0000-0000-000000000001" }) as { content: { text: string }[] };
    expect(out.content[0]!.text).toContain("Sony");
  });

  it("immich_download_asset_original returns SDK-computed URL", async () => {
    mockSdkResponse("getAssetOriginalPath", "/api/asset/00000000-0000-0000-0000-000000000001/original");
    const out = await callTool(server, "immich_download_asset_original", { id: "00000000-0000-0000-0000-000000000001" }) as { content: { text: string }[] };
    expect(out.content[0]!.text).toContain("/original");
  });

  it("immich_get_asset_statistics calls getAssetStatistics", async () => {
    mockSdkResponse("getAssetStatistics", { videos: 0, images: 0 });
    await callTool(server, "immich_get_asset_statistics");
    expect(sdkCalls[0]?.fn).toBe("getAssetStatistics");
  });
});

describe("asset tools - write gate", () => {
  let server: McpServer;
  beforeEach(() => {
    resetFakeSdk();
    server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAssetTools(server, cfgRead); // writes disabled
  });

  it("immich_update_asset refuses without writes enabled", async () => {
    const out = await callTool(server, "immich_update_asset", {
      id: "00000000-0000-0000-0000-000000000001",
      isFavorite: true,
    }) as { isError?: boolean; content: { text: string }[] };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/Writes disabled/);
  });

  it("immich_delete_asset refuses without writes enabled", async () => {
    const out = await callTool(server, "immich_delete_asset", {
      ids: ["00000000-0000-0000-0000-000000000001"],
    }) as { isError?: boolean; content: { text: string }[] };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/Writes disabled/);
  });
});

describe("asset tools - confirm gate", () => {
  let server: McpServer;
  beforeEach(() => {
    resetFakeSdk();
    server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAssetTools(server, cfgWrite); // writes enabled
  });

  it("immich_bulk_update_assets refuses without confirm", async () => {
    const out = await callTool(server, "immich_bulk_update_assets", {
      ids: ["00000000-0000-0000-0000-000000000001"],
      isFavorite: true,
    }) as { isError?: boolean; content: { text: string }[] };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/confirm: true/);
  });

  it("immich_delete_asset permanent: true refuses without confirm", async () => {
    const out = await callTool(server, "immich_delete_asset", {
      ids: ["00000000-0000-0000-0000-000000000001"],
      permanent: true,
    }) as { isError?: boolean; content: { text: string }[] };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/confirm: true/);
  });

  it("immich_delete_asset trash (default) needs writes, no confirm", async () => {
    mockSdkResponse("deleteAssets", undefined);
    const out = await callTool(server, "immich_delete_asset", {
      ids: ["00000000-0000-0000-0000-000000000001"],
    }) as { isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(sdkCalls[0]?.fn).toBe("deleteAssets");
  });

  it("immich_bulk_update_assets with confirm: true proceeds", async () => {
    mockSdkResponse("updateAssets", undefined);
    const out = await callTool(server, "immich_bulk_update_assets", {
      ids: ["00000000-0000-0000-0000-000000000001"],
      isFavorite: true,
      confirm: true,
    }) as { isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(sdkCalls[0]?.fn).toBe("updateAssets");
  });
});
