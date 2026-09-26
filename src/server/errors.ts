/**
 * Turn any error (including Drizzle's "Failed query" wrapper around a Postgres exception)
 * into the human-readable message. DB triggers raise Dutch messages meant for the user.
 */
export function errorMessage(err: unknown): string {
  let current: unknown = err;
  let message = "Onbekende fout";
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      message = current.message;
      if (!message.startsWith("Failed query")) return message;
      current = (current as Error & { cause?: unknown }).cause;
    } else if (typeof current === "string") {
      return current;
    } else {
      break;
    }
  }
  return message;
}

/** Run `fn`, rethrowing with the unwrapped message so callers see the real reason. */
export async function unwrapDbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const wrapped = new Error(errorMessage(err));
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  }
}
