import { describe, it, expect } from "vitest";
import { installFakeSdk, resetFakeSdk, sdkCalls, mockSdkResponse } from "./_fake-sdk.js";
installFakeSdk();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJobTools } from "../src/tools/jobs.js";

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

describe("jobs", () => {
  describe("immich_list_jobs", () => {
    it("calls getQueuesLegacy and returns its response", async () => {
      resetFakeSdk();
      mockSdkResponse("getQueuesLegacy", { thumbnailGeneration: { jobCounts: {} } });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerJobTools(server, cfgRead);
      const out = await callTool(server, "immich_list_jobs", {}) as ToolResult;
      expect(out.isError).toBeFalsy();
      expect(sdkCalls.some((c) => c.fn === "getQueuesLegacy")).toBe(true);
      const body = parsePayload(out);
      expect(body.thumbnailGeneration).toBeDefined();
    });
  });

  describe("immich_run_job", () => {
    it("refuses without writes", async () => {
      resetFakeSdk();
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerJobTools(server, cfgRead);
      const out = await callTool(server, "immich_run_job", {
        id: "thumbnailGeneration",
        command: "start",
      }) as ToolResult;
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/Writes disabled/);
      expect(sdkCalls.some((c) => c.fn === "runQueueCommandLegacy")).toBe(false);
    });

    it("calls runQueueCommandLegacy with the right shape", async () => {
      resetFakeSdk();
      mockSdkResponse("runQueueCommandLegacy", { name: "thumbnailGeneration", isActive: true });
      const server = new McpServer({ name: "immich-mcp", version: "0.0.0-test" });
      registerJobTools(server, cfgWrite);
      const out = await callTool(server, "immich_run_job", {
        id: "thumbnailGeneration",
        command: "start",
        force: true,
      }) as ToolResult;
      expect(out.isError).toBeFalsy();
      const call = sdkCalls.find((c) => c.fn === "runQueueCommandLegacy");
      expect(call).toBeDefined();
      const arg = call!.args[0] as { name: string; queueCommandDto: { command: string; force: boolean } };
      expect(arg.name).toBe("thumbnailGeneration");
      expect(arg.queueCommandDto.command).toBe("start");
      expect(arg.queueCommandDto.force).toBe(true);
    });
  });
});
