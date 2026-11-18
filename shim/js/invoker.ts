let current: string | null = null;

export function invokingResource(): string | null {
  return current;
}

/** Only the synchronous part of a handler sees the invoker: the host gives no per-continuation context to an async function. */
export function runAs<T>(invoker: string | null, fn: () => T): T {
  const previous = current;
  current = invoker;
  try {
    return fn();
  } finally {
    current = previous;
  }
}
