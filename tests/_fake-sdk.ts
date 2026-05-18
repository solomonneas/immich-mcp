import { vi } from "vitest";

export interface SdkCall {
  fn: string;
  args: unknown[];
}

export const sdkCalls: SdkCall[] = [];
export const sdkResponses = new Map<string, unknown>();
export const sdkErrors = new Map<string, unknown>();

export function resetFakeSdk(): void {
  sdkCalls.length = 0;
  sdkResponses.clear();
  sdkErrors.clear();
}

export function mockSdkResponse(fn: string, value: unknown): void {
  sdkResponses.set(fn, value);
}

export function mockSdkError(fn: string, error: unknown): void {
  sdkErrors.set(fn, error);
}

function makeFakeFn(fn: string) {
  return (...args: unknown[]) => {
    sdkCalls.push({ fn, args });
    if (sdkErrors.has(fn)) {
      const e = sdkErrors.get(fn);
      throw e instanceof Error ? e : new Error(String(e));
    }
    return Promise.resolve(sdkResponses.get(fn));
  };
}

export function installFakeSdk(): void {
  vi.mock("@immich/sdk", () => {
    const fns = [
      "pingServer", "getServerVersion", "getServerConfig", "getServerFeatures",
      "getServerStatistics", "getStorage",
      "searchAssets", "getAssetInfo", "getAssetStatistics", "getAssetOriginalPath",
      "getAssetThumbnailPath", "uploadAsset", "updateAsset", "updateAssets", "deleteAssets",
      "searchSmart", "searchRandom",
      "getAllAlbums", "getAlbumInfo", "createAlbum", "updateAlbumInfo", "deleteAlbum",
      "addAssetsToAlbum", "removeAssetFromAlbum", "getAlbumStatistics",
      "getAllPeople", "getPerson", "updatePerson", "mergePerson", "getPersonStatistics",
      "getAllTags", "getTagById", "createTag", "updateTag", "deleteTag", "tagAssets", "untagAssets",
      "getAllSharedLinks", "getSharedLinkById", "createSharedLink", "updateSharedLink", "removeSharedLink",
      "getActivities", "createActivity", "deleteActivity", "getActivityStatistics",
      "searchMemories", "getMemory",
      "getAssetDuplicates",
      "searchStacks", "getStack", "createStack", "updateStack", "deleteStack",
      "emptyTrash", "restoreTrash", "getQueuesLegacy", "runQueueCommandLegacy",
      "init",
    ];
    const out: Record<string, unknown> = {};
    for (const fn of fns) out[fn] = makeFakeFn(fn);
    return out;
  });
}
