export type KuzuRetryOptions = {
  retries: number;
  initialDelayMs: number;
  maxDelayMs: number;
};

export const defaultKuzuRetryOptions: KuzuRetryOptions = {
  retries: 5,
  initialDelayMs: 100,
  maxDelayMs: 2_000,
};

export async function withKuzuRetry<T>(
  operation: () => Promise<T> | T,
  options: KuzuRetryOptions | false | undefined,
): Promise<T> {
  if (!options) {
    return operation();
  }

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isKuzuLockError(error) || attempt >= options.retries) {
        throw error;
      }

      await delay(Math.min(options.initialDelayMs * 2 ** attempt, options.maxDelayMs));
      attempt += 1;
    }
  }
}

export function isKuzuLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not set lock|database.*lock|lock on file|another process/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
