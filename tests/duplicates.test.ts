import { describe, it, expect } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDuplicateTools } from "../src/tools/duplicates.js";

const cfgRead = { baseUrl: "https://x/api", apiKey: "k", allowWrites: false, verifySsl: true };
const cfgWrite = { ...cfgRead, allowWrites: true };
const UUID_A = "00000000-0000-0000-0000-000000000001";
const UUID_B = "00000000-0000-0000-0000-000000000002";

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra?: unknown) => Promise<unknown> }> })._registeredTools;
  return reg[name]!.handler(args, {});
}

describe("duplicates", () => {
  it("immich_list_duplicates calls getAssetDuplicates", async () => {
    resetFakeSdk();
    mockSdkResponse("getAssetDuplicates", []);
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerDuplicateTools(server, cfgRead);
    await callTool(server, "immich_list_duplicates");
    expect(sdkCalls[0]?.fn).toBe("getAssetDuplicates");
  });

  it("immich_resolve_duplicates dry-run by default (no delete)", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerDuplicateTools(server, cfgWrite);
    const out = await callTool(server, "immich_resolve_duplicates", {
      keep: [UUID_A],
      discard: [UUID_B],
    }) as { isError?: boolean; content: { text: string }[] };
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toMatch(/dryRun/);
    expect(sdkCalls.length).toBe(0);
  });

  it("immich_resolve_duplicates delete: true refuses without confirm", async () => {
    resetFakeSdk();
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerDuplicateTools(server, cfgWrite);
    const out = await callTool(server, "immich_resolve_duplicates", {
      keep: [UUID_A],
      discard: [UUID_B],
      delete: true,
    }) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });

  it("immich_resolve_duplicates delete + confirm calls deleteAssets", async () => {
    resetFakeSdk();
    mockSdkResponse("deleteAssets", undefined);
    const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
    registerDuplicateTools(server, cfgWrite);
    const out = await callTool(server, "immich_resolve_duplicates", {
      keep: [UUID_A],
      discard: [UUID_B],
      delete: true,
      confirm: true,
    }) as { isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(sdkCalls[0]?.fn).toBe("deleteAssets");
  });
});
