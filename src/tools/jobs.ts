import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as sdk from "@immich/sdk";
import type { Config } from "../config.js";
import { withRetry } from "../retry.js";
import {
  asMcpResponse,
  asMcpError,
  surfaceError,
  requireWrites,
} from "./_util.js";

const JOB_IDS = [
  "thumbnailGeneration",
  "metadataExtraction",
  "videoConversion",
  "faceDetection",
  "facialRecognition",
  "smartSearch",
  "duplicateDetection",
  "backgroundTask",
  "storageTemplateMigration",
  "migration",
  "search",
  "sidecar",
  "library",
  "notifications",
  "backupDatabase",
  "ocr",
  "workflow",
  "editor",
] as const;

export function registerJobTools(server: McpServer, config: Config): void {
  server.tool(
    "immich_list_jobs",
    "Return queue status for all Immich background jobs (thumbnails, ML, metadata, sidecar, etc.).",
    {},
    async () => {
      try {
        const sdkAny = sdk as unknown as { getQueuesLegacy?: () => Promise<unknown> };
        if (typeof sdkAny.getQueuesLegacy !== "function") {
          return asMcpError("Immich SDK does not export getQueuesLegacy on this version.");
        }
        const res = await withRetry("getQueuesLegacy", () => sdkAny.getQueuesLegacy!());
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );

  server.tool(
    "immich_run_job",
    "Send a command to one of Immich's background jobs. Writes-gated.",
    {
      id: z.enum(JOB_IDS),
      command: z.enum(["start", "pause", "resume", "empty", "clear-failed"]),
      force: z.boolean().optional(),
    },
    async (args) => {
      try {
        requireWrites(config);
        const sdkAny = sdk as unknown as {
          runQueueCommandLegacy?: (a: {
            name: string;
            queueCommandDto: { command: string; force: boolean };
          }) => Promise<unknown>;
        };
        if (typeof sdkAny.runQueueCommandLegacy !== "function") {
          return asMcpError("Immich SDK does not export runQueueCommandLegacy on this version.");
        }
        const res = await withRetry("runQueueCommandLegacy", () =>
          sdkAny.runQueueCommandLegacy!({
            name: args.id,
            queueCommandDto: { command: args.command, force: args.force ?? false },
          }),
        );
        return asMcpResponse(res);
      } catch (e) {
        return asMcpError(surfaceError(e));
      }
    },
  );
}
