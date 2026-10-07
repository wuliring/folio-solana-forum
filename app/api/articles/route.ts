import { articleHash, checkArticle, normalizeArticle } from "../../../lib/articles";
import { isForumSignature } from "../../../lib/forum-protocol";
import { articlesDatabase, confirmedTopic, jsonBody } from "../../../lib/forum-server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "来源不允许。" }, { status: 403, headers });
  let input: { signature: string; body: string };
  try {
    const data = await jsonBody(request, 1_000_000);
    if (!data || typeof data !== "object" || !("signature" in data) || !isForumSignature(data.signature)
      || !("body" in data) || typeof data.body !== "string") throw new Error("文章或链上凭证不完整。");
    input = { signature: data.signature, body: checkArticle(normalizeArticle(data.body)) };
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "文章格式无效。" }, { status: 400, headers }); }
  try {
    // Public storage is authorized by a successful, signed, on-chain topic with
    // this exact digest. Unsigned drafts and unconfirmed transactions cannot write.
    const topic = await confirmedTopic(input.signature);
    if (!topic) return Response.json({ error: "链上原帖尚未可读，请稍后继续完成发布。", code: "awaiting_chain" }, { status: 409, headers });
    const hash = await articleHash(input.body);
    if (topic.payload.contentHash !== hash || topic.payload.format !== "markdown") {
      return Response.json({ error: "正文与作者签名的链上内容指纹不一致。" }, { status: 403, headers });
    }
    const db = articlesDatabase();
    await db.prepare(`INSERT INTO forum_articles (signature, author, title, content_hash, body, format, created_at)
      VALUES (?, ?, ?, ?, ?, 'markdown', ?) ON CONFLICT(signature) DO NOTHING`)
      .bind(input.signature, topic.author, topic.payload.title, hash, input.body, topic.blockTime ?? Math.floor(Date.now() / 1_000)).run();
    return Response.json({ stored: true, signature: input.signature, contentHash: hash }, { headers });
  } catch {
    console.error(JSON.stringify({ event: "forum_article_store_unavailable" }));
    return Response.json({ error: "链上发布凭证已保留，正文存储暂不可用。请点击继续完成发布。" }, { status: 503, headers });
  }
}
