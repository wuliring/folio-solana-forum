import { env } from "cloudflare:workers";
import { Connection } from "@solana/web3.js";
import { readForumEntry, type Topic } from "./forum";
import { devnetRpcFetch } from "./devnet-rpc";

export function articlesDatabase() {
  if (!env.DB) throw new Error("文章存储暂时不可用，请稍后重试。");
  return env.DB;
}

export async function confirmedTopic(signature: string): Promise<Topic | null> {
  const connection = new Connection(process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com", {
    commitment: "confirmed", disableRetryOnRateLimit: true,
    fetch: devnetRpcFetch,
  });
  const entry = await readForumEntry(connection, signature);
  return entry?.payload.kind === "topic" ? entry as Topic : null;
}

export async function jsonBody(request: Request, maximum: number): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > maximum) throw new Error("请求内容过大。");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("缺少请求内容。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("请求内容过大。"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
