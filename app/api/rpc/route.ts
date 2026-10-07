import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { inspectJournalTransaction } from "../../../lib/journal-transaction";
import { inspectForumTransaction } from "../../../lib/forum-protocol";
import { inspectTipTransaction } from "../../../lib/tip-protocol";
import { confirmedTopic } from "../../../lib/forum-server";
import { devnetRpcFetch } from "../../../lib/devnet-rpc";

export const dynamic = "force-dynamic";
const METHODS = new Set(["getBalance", "getLatestBlockhash", "getFeeForMessage", "sendTransaction",
  "getSignatureStatuses", "getBlockHeight", "getSignaturesForAddress", "getTransaction"]);
const MAX_BODY = 64 * 1024;

function signedContentTransaction(value: unknown) {
  if (typeof value !== "string" || value.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > 1232 || bytes.toString("base64") !== value) return null;
    const transaction = Transaction.from(bytes);
    let tip: ReturnType<typeof inspectTipTransaction> | undefined;
    try { inspectForumTransaction(transaction); }
    catch {
      try { inspectJournalTransaction(transaction); }
      catch { tip = inspectTipTransaction(transaction); }
    }
    // Anonymous publishing is authorized by the author's wallet signature.
    return transaction.verifySignatures() ? { tip } : null;
  } catch { return null; }
}

function rpcError(id: unknown, message: string, status: number, code = -32000) {
  return Response.json({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null,
    error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function boundedBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new Error("large_body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); throw new Error("large_body"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return rpcError(null, "Origin not allowed", 403);
  let body: unknown;
  try { body = await boundedBody(request); }
  catch { return rpcError(null, "Invalid request body", 400, -32700); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(null, "Invalid request", 400, -32600);
  const input = body as { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };
  if (input.jsonrpc !== "2.0" || typeof input.method !== "string" || !METHODS.has(input.method)) {
    return rpcError(input.id, "Method not available", 400, -32601);
  }
  if (!Array.isArray(input.params) || input.params.length > 2) return rpcError(input.id, "Invalid parameters", 400, -32602);
  const params = [...input.params];
  if (input.method === "getSignaturesForAddress") {
    const options = params[1] && typeof params[1] === "object" ? params[1] as Record<string, unknown> : {};
    params[1] = { commitment: "confirmed", limit: Math.min(Math.max(Number(options.limit) || 60, 1), 60),
      ...(typeof options.before === "string" ? { before: options.before } : {}) };
  }
  if (input.method === "getSignatureStatuses" && (!Array.isArray(params[0]) || params[0].length > 5)) {
    return rpcError(input.id, "Too many signatures", 400, -32602);
  }
  if (input.method === "getTransaction") {
    const options = params[1] && typeof params[1] === "object" ? params[1] as Record<string, unknown> : {};
    params[1] = { encoding: options.encoding === "jsonParsed" ? "jsonParsed" : "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 };
  }
  if (input.method === "sendTransaction") {
    const signed = signedContentTransaction(params[0]);
    if (!signed) {
      return rpcError(input.id, "仅接受钱包签名的论坛内容、文章打赏或链上手记。", 400, -32602);
    }
    if (signed.tip) {
      try {
        const topic = await confirmedTopic(signed.tip.payload.root);
        if (!topic || topic.author !== signed.tip.payload.recipient) return rpcError(input.id, "打赏收款人不是链上原帖作者，支付已停止。", 400, -32602);
      } catch { return rpcError(input.id, "原帖作者暂时无法读取，请稍后重试。", 503); }
    }
    params[1] = { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 };
  }
  try {
    const endpoint = process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
    const upstream = await devnetRpcFetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: input.id ?? null, method: input.method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      console.error(JSON.stringify({ event: "solana_rpc_upstream_failed", method: input.method,
        status: upstream.status, provider: process.env.SOLANA_DEVNET_RPC_URL ? "configured" : "public" }));
      await upstream.body?.cancel();
      return rpcError(input.id, upstream.status === 429 ? "429: 开发网请求较多，请稍后重试。" : "开发网暂不可用。", upstream.status === 429 ? 429 : 502);
    }
    return new Response(upstream.body, { status: 200, headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    console.error(JSON.stringify({ event: "solana_rpc_transport_failed", method: input.method }));
    return rpcError(input.id, "开发网连接超时，请稍后重试。", 504);
  }
}
