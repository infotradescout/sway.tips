/** Bound operations even when a transport/body reader ignores cancellation. */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () =>
      reject(
        signal.reason ?? new DOMException("Operation canceled", "AbortError"),
      );
    if (signal.aborted) {
      promise.catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}
