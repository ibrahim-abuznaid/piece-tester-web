/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 * Resolves when all items have been processed. Worker rejections propagate.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function drain(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => drain()));
}
