/**
 * Fetch wrapper with automatic timeout via AbortController.
 * Prevents 504 Gateway Timeout by aborting requests that take too long.
 *
 * Usage:
 *   const res = await fetchWithTimeout(`${baseUrl}/alerts`, { timeout: 10000 });
 */

const DEFAULT_TIMEOUT = 15000; // 15 seconds

export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
