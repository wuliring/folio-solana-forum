// Retry only the identical request. Even a sendTransaction retry carries the
// same signed bytes and signature, never a newly signed payment or post.
export async function devnetRpcFetch(url: RequestInfo | URL, init?: RequestInit) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    if (![429, 502, 503, 504].includes(response.status) || attempt === 2) return response;
    const header = response.headers.get("Retry-After");
    const seconds = header === null ? NaN : Number(header);
    const delay = header === null ? 1_500 * (attempt + 1) : Number.isFinite(seconds)
      ? Math.max(0, seconds * 1_000) : Math.max(0, Date.parse(header) - Date.now());
    // A long provider cooldown belongs in a later user retry, not this request.
    if (!Number.isFinite(delay) || delay > 4_000) return response;
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, Math.max(delay, 500)));
  }
  throw new Error("开发网节点暂时不可用。");
}
