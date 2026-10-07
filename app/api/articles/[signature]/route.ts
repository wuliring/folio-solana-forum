import { isForumSignature } from "../../../../lib/forum-protocol";
import { articlesDatabase } from "../../../../lib/forum-server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ signature: string }> }) {
  const { signature } = await context.params;
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!isForumSignature(signature)) return Response.json({ error: "文章链接无效。" }, { status: 400, headers });
  try {
    const article = await articlesDatabase().prepare("SELECT signature, body, content_hash AS contentHash FROM forum_articles WHERE signature = ?")
      .bind(signature).first<{ signature: string; body: string; contentHash: string }>();
    if (!article) return Response.json({ error: "正文尚未存入，作者可通过保存的发布凭证继续完成发布。" }, { status: 404, headers });
    return Response.json(article, { headers });
  } catch {
    console.error(JSON.stringify({ event: "forum_article_read_unavailable" }));
    return Response.json({ error: "正文暂时无法读取，请稍后重试。" }, { status: 503, headers });
  }
}
