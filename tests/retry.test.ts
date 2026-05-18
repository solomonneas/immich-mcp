import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../src/retry.js";

function makeStatusError(status: number, message = "boom"): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

describe("withRetry", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    errSpy.mockRestore();
  });

  it("returns the value when fn succeeds on the first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const p = withRetry("label", fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds on retry", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeStatusError(429, "too many"))
      .mockResolvedValueOnce("ok");
    const p = withRetry("label", fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and succeeds on retry", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeStatusError(503, "service down"))
      .mockResolvedValueOnce("ok");
    const p = withRetry("label", fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 401, throws immediately", async () => {
    const err = makeStatusError(401, "unauth");
    const fn = vi.fn().mockRejectedValue(err);
    const p = withRetry("label", fn);
    const settled = expect(p).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 404, throws immediately", async () => {
    const err = makeStatusError(404, "missing");
    const fn = vi.fn().mockRejectedValue(err);
    const p = withRetry("label", fn);
    const settled = expect(p).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("after 4 failed attempts (1 + 3 retries) throws the last error", async () => {
    const errs = [
      makeStatusError(503, "first"),
      makeStatusError(503, "second"),
      makeStatusError(503, "third"),
      makeStatusError(503, "fourth"),
    ];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(errs[0])
      .mockRejectedValueOnce(errs[1])
      .mockRejectedValueOnce(errs[2])
      .mockRejectedValueOnce(errs[3]);
    const p = withRetry("label", fn);
    // attach catch handler now so the rejection is observed before timers run
    const settled = expect(p).rejects.toBe(errs[3]);
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does not retry on non-HTTP errors", async () => {
    const err = new Error("totally generic");
    const fn = vi.fn().mockRejectedValue(err);
    const p = withRetry("label", fn);
    const settled = expect(p).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
