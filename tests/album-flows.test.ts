import { describe, it, expect } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAlbumFlowTools } from "../src/tools/album-flows.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const cfgWrite = { ...cfgRead, allowWrites: true };

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  return reg[name]!.handler(args, {});
}

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function parsePayload(out: unknown): Record<string, unknown> {
  const r = out as ToolResult;
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe("album-flows - immich_search_then_album", () => {
  it("refuses without writes", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAlbumFlowTools(server, cfgRead);
    const out = await callTool(server, "immich_search_then_album", {
      albumName: "Trip",
      smartQuery: "beach",
    }) as ToolResult;
    expect(out.isError).toBe(true);
  });

  it("refuses without smartQuery or metadataFilter", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAlbumFlowTools(server, cfgWrite);
    const out = await callTool(server, "immich_search_then_album", {
      albumName: "Trip",
    }) as ToolResult;
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("smartQuery");
  });

  it("refuses when BOTH smartQuery and metadataFilter are provided", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAlbumFlowTools(server, cfgWrite);
    const out = await callTool(server, "immich_search_then_album", {
      albumName: "Trip",
      smartQuery: "beach",
      metadataFilter: { city: "Paris" },
    }) as ToolResult;
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/exactly one/);
    // Critical: must not silently drop one or the other and proceed
    expect(sdkCalls.some((c) => c.fn === "searchAssets" || c.fn === "searchSmart" || c.fn === "createAlbum")).toBe(false);
  });

  it("with smartQuery: calls searchSmart then createAlbum with matched asset ids", async () => {
    resetFakeSdk();
    mockSdkResponse("searchSmart", {
      assets: { items: [{ id: "a1" }, { id: "a2" }] },
    });
    mockSdkResponse("createAlbum", { id: "album-1", albumName: "Beach 2026" });
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAlbumFlowTools(server, cfgWrite);
    const out = await callTool(server, "immich_search_then_album", {
      albumName: "Beach 2026",
      smartQuery: "beach",
    });
    const fns = sdkCalls.map((c) => c.fn);
    expect(fns).toContain("searchSmart");
    expect(fns).toContain("createAlbum");
    const createCall = sdkCalls.find((c) => c.fn === "createAlbum");
    expect(createCall).toBeDefined();
    const argStr = JSON.stringify(createCall!.args);
    expect(argStr).toContain("a1");
    expect(argStr).toContain("a2");
    expect(argStr).toContain("Beach 2026");
    const body = parsePayload(out);
    expect(body.created).toBe(true);
    expect(body.albumId).toBe("album-1");
    expect(body.assetCount).toBe(2);
  });

  it("with metadataFilter: calls searchAssets then createAlbum", async () => {
    resetFakeSdk();
    mockSdkResponse("searchAssets", {
      assets: { items: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
    });
    mockSdkResponse("createAlbum", { id: "album-2", albumName: "Paris" });
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAlbumFlowTools(server, cfgWrite);
    const out = await callTool(server, "immich_search_then_album", {
      albumName: "Paris",
      metadataFilter: { city: "Paris" },
    });
    const fns = sdkCalls.map((c) => c.fn);
    expect(fns).toContain("searchAssets");
    expect(fns).toContain("createAlbum");
    const searchCall = sdkCalls.find((c) => c.fn === "searchAssets");
    expect(JSON.stringify(searchCall!.args)).toContain("Paris");
    const body = parsePayload(out);
    expect(body.created).toBe(true);
    expect(body.albumId).toBe("album-2");
    expect(body.assetCount).toBe(3);
  });

  it("when search returns zero matches, does NOT call createAlbum and returns created:false", async () => {
    resetFakeSdk();
    mockSdkResponse("searchSmart", { assets: { items: [] } });
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerAlbumFlowTools(server, cfgWrite);
    const out = await callTool(server, "immich_search_then_album", {
      albumName: "Empty",
      smartQuery: "nothing matches this",
    });
    const fns = sdkCalls.map((c) => c.fn);
    expect(fns).toContain("searchSmart");
    expect(fns).not.toContain("createAlbum");
    const body = parsePayload(out);
    expect(body.created).toBe(false);
    expect(body.reason).toBeTruthy();
  });
});
