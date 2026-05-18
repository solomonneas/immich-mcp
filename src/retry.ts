const BACKOFF_MS = [1000, 2000, 4000];

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as unknown as { status?: number }).status;
  if (status === undefined) return false;
  return status === 429 || (status >= 500 && status < 600);
}

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 500);
}

export async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < BACKOFF_MS.length + 1; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= BACKOFF_MS.length || !isRetryable(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[immich-mcp] retry ${attempt + 1}/${BACKOFF_MS.length} for ${label}: ${msg}`,
      );
      const wait = jitter(BACKOFF_MS[attempt]!);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastErr;
}
