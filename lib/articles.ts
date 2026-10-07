import { encodeForumPayload, type TopicPayload } from "./forum-protocol";

export const MAX_ARTICLE_CHARACTERS = 200_000;
export const MAX_ARTICLE_BYTES = 500_000;

export function normalizeArticle(body: string) {
  return body.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

export async function articleHash(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export function checkArticle(body: string) {
  if (!body.trim()) throw new Error("先写下文章正文。");
  if (body.length > MAX_ARTICLE_CHARACTERS || new TextEncoder().encode(body).length > MAX_ARTICLE_BYTES) {
    throw new Error("文章超出当前容量，请精简到 20 万字、500 KB 以内。");
  }
  return body;
}

export async function prepareArticle(title: string, body: string): Promise<{ payload: TopicPayload; body: string }> {
  const normalized = checkArticle(normalizeArticle(body));
  const plain = normalized.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#*_>`~]/g, "").replace(/\s+/g, " ").trim();
  // Multibyte Memo text costs substantially more computation than ASCII.
  // Keep discovery metadata compact; the full article remains in storage.
  const excerpt = Array.from(plain || normalized).slice(0, 48).join("");
  const payload: TopicPayload = { kind: "topic", title: title.trim(), body: excerpt,
    contentHash: await articleHash(normalized), format: "markdown" };
  encodeForumPayload(payload);
  return { payload, body: normalized };
}

export async function saveArticle(signature: string, body: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch("/api/articles", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature, body }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json().catch(() => null);
    if (response.ok) return;
    if (response.status === 409 && result?.code === "awaiting_chain" && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 2_000)); continue;
    }
    throw new Error(typeof result?.error === "string" ? result.error : "文章已签名上链，正文保存暂未完成。请继续完成发布。");
  }
}

export async function loadArticle(signature: string, expectedHash: string) {
  const response = await fetch(`/api/articles/${encodeURIComponent(signature)}`, { signal: AbortSignal.timeout(20_000) });
  const result = await response.json().catch(() => null);
  if (!response.ok || typeof result?.body !== "string") {
    throw new Error(typeof result?.error === "string" ? result.error : "正文暂时无法读取，请稍后重试。");
  }
  checkArticle(result.body);
  if (await articleHash(result.body) !== expectedHash) throw new Error("正文与链上内容指纹不一致，已停止展示。");
  return result.body as string;
}
