import { describe, it, expect } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTrashTools } from "../src/tools/trash.js";

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

describe("trash", () => {
  describe("immich_list_trash", () => {
    it("calls searchAssets with isTrashed: true", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", { assets: { items: [] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgRead);
      const out = await callTool(server, "immich_list_trash", { size: 50 }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const call = sdkCalls.find((c) => c.fn === "searchAssets");
      expect(call).toBeDefined();
      const dto = (call!.args[0] as { metadataSearchDto: { isTrashed: boolean; size: number } }).metadataSearchDto;
      expect(dto.isTrashed).toBe(true);
      expect(dto.size).toBe(50);
    });
  });

  describe("immich_restore_by_query", () => {
    it("refuses without writes", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgRead);
      const out = await callTool(server, "immich_restore_by_query", {}) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/Writes disabled/);
    });

    it("returns { restored: 0 } when search returns empty", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", { assets: { items: [] } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", {}) as ToolResult;
      expect(out.isError).toBeFalsy();
      const body = parsePayload(out);
      expect(body.restored).toBe(0);
      expect(sdkCalls.some((c) => c.fn === "updateAssets")).toBe(false);
    });

    it("calls updateAssets with isTrashed: false and the matched ids", async () => {
      resetFakeSdk();
      mockSdkResponse("searchAssets", {
        assets: { items: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] },
      });
      mockSdkResponse("updateAssets", undefined);
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", {}) as ToolResult;
      expect(out.isError).toBeFalsy();
      const upd = sdkCalls.find((c) => c.fn === "updateAssets");
      expect(upd).toBeDefined();
      const dto = (upd!.args[0] as { assetBulkUpdateDto: { ids: string[]; isTrashed: boolean } }).assetBulkUpdateDto;
      expect(dto.ids).toEqual(["a1", "a2", "a3"]);
      expect(dto.isTrashed).toBe(false);
      const body = parsePayload(out);
      expect(body.restored).toBe(3);
    });

    it("refuses when match count exceeds maxRestore", async () => {
      resetFakeSdk();
      const items = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}` }));
      mockSdkResponse("searchAssets", { assets: { items } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_restore_by_query", { maxRestore: 5 }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/exceeds maxRestore/);
      expect(sdkCalls.some((c) => c.fn === "updateAssets")).toBe(false);
    });
  });

  describe("immich_empty_trash", () => {
    it("refuses without writes", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgRead);
      const out = await callTool(server, "immich_empty_trash", { confirm: true }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/Writes disabled/);
    });

    it("refuses without confirm", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_empty_trash", {}) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/confirm: true/);
      expect(sdkCalls.some((c) => c.fn === "emptyTrash")).toBe(false);
    });

    it("with writes + confirm calls emptyTrash", async () => {
      resetFakeSdk();
      mockSdkResponse("emptyTrash", { count: 7 });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerTrashTools(server, cfgWrite);
      const out = await callTool(server, "immich_empty_trash", { confirm: true }) as ToolResult;
      expect(out.isError).toBeFalsy();
      expect(sdkCalls.some((c) => c.fn === "emptyTrash")).toBe(true);
      const body = parsePayload(out);
      expect(body.emptied).toBe(true);
    });
  });
});
