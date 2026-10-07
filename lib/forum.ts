import { ComputeBudgetProgram, Message, PublicKey, SendTransactionError, Transaction,
  TransactionInstruction, type Connection } from "@solana/web3.js";
import type { WalletAccount } from "@wallet-standard/base";
import { CHAIN, MEMO_PROGRAM, PAGE_SIZE, type JournalWallet, type Receipt } from "./solana";
import { encodeForumPayload, encodeSignature, FORUM_COMPUTE_UNITS, FORUM_PREFIX, forumIndexInstruction,
  inspectForumTransaction, isForumSignature, normalizeForumPayload, TOPICS_REFERENCE, threadReference,
  type ForumPayload, type ReplyPayload, type TopicPayload } from "./forum-protocol";

export type ForumEntry = { signature: string; author: string; payload: ForumPayload; slot: number; blockTime: number | null };
export type Topic = ForumEntry & { payload: TopicPayload };
export type Reply = ForumEntry & { payload: ReplyPayload };
export type ForumReceipt = Receipt & { payload: ForumPayload; articleBody?: string; articleStored?: boolean };
export type ForumPage<T extends ForumEntry> = { entries: T[]; before?: string; hasMore: boolean; unavailable: number };

// Confirmed immutable entries are cached only in this browser's connection.
const entryCaches = new WeakMap<Connection, Map<string, ForumEntry>>();

export async function readForumEntry(connection: Connection, signature: string): Promise<ForumEntry | null> {
  if (!isForumSignature(signature)) throw new Error("帖子链接不完整，请重新打开。");
  let cache = entryCaches.get(connection);
  if (!cache) { cache = new Map(); entryCaches.set(connection, cache); }
  const cached = cache.get(signature);
  if (cached) return cached;
  const result = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!result) return null;
  if (!result.meta || result.meta.err || !(result.transaction.message instanceof Message)
    || (result.version !== undefined && result.version !== "legacy")) return null;
  try {
    const transaction = Transaction.populate(result.transaction.message, result.transaction.signatures);
    const checked = inspectForumTransaction(transaction);
    if (!transaction.signature || encodeSignature(transaction.signature) !== signature || !transaction.verifySignatures()) return null;
    const entry = { signature, author: checked.author, payload: checked.payload, slot: result.slot, blockTime: result.blockTime ?? null };
    if (cache.size >= 160) cache.delete(cache.keys().next().value!);
    cache.set(signature, entry);
    return entry;
  } catch { return null; }
}

async function readPage<T extends ForumEntry>(connection: Connection, reference: PublicKey,
  matches: (entry: ForumEntry) => entry is T, before?: string): Promise<ForumPage<T>> {
  const signatures = await connection.getSignaturesForAddress(reference, { limit: PAGE_SIZE, ...(before ? { before } : {}) }, "confirmed");
  // Some providers omit memo summaries. Hydrate those transactions as well.
  const relevant = signatures.filter(item => !item.err && (!item.memo || item.memo.includes(FORUM_PREFIX)));
  const candidates = relevant.slice(0, 12);
  const entries: T[] = [];
  let unavailable = 0;
  for (let offset = 0; offset < candidates.length; offset += 2) {
    const results = await Promise.allSettled(candidates.slice(offset, offset + 2).map(item => readForumEntry(connection, item.signature)));
    for (const result of results) {
      if (result.status === "rejected" || !result.value) { unavailable++; continue; }
      if (matches(result.value)) entries.push(result.value);
    }
    if (offset + 2 < candidates.length) await new Promise(resolve => setTimeout(resolve, 750));
  }
  const capped = relevant.length > candidates.length;
  return { entries, unavailable, before: capped ? candidates.at(-1)?.signature : signatures.at(-1)?.signature,
    hasMore: capped || signatures.length === PAGE_SIZE };
}

export function readTopics(connection: Connection, before?: string, author?: string) {
  return readPage(connection, author ? new PublicKey(author) : TOPICS_REFERENCE,
    (entry): entry is Topic => entry.payload.kind === "topic" && (!author || entry.author === author), before);
}

export function readReplies(connection: Connection, root: string, before?: string) {
  return readPage(connection, threadReference(root),
    (entry): entry is Reply => entry.payload.kind === "reply" && entry.payload.root === root, before);
}

export async function submitForumEntry(connection: Connection, wallet: JournalWallet, account: WalletAccount,
  payload: ForumPayload, onSigning: () => void, stillActive: () => boolean, onBroadcast: (receipt: ForumReceipt) => void, articleBody?: string) {
  const normalized = normalizeForumPayload(payload);
  const memo = encodeForumPayload(normalized);
  // Replies must point to a confirmed topic. A quoted reply must belong to it.
  if (normalized.kind === "reply") {
    const topic = await readForumEntry(connection, normalized.root);
    if (!topic || topic.payload.kind !== "topic") throw new Error("原帖暂时无法读取，请稍后重新打开讨论页。");
    if (normalized.parent) {
      const parent = await readForumEntry(connection, normalized.parent);
      if (!parent || parent.payload.kind !== "reply" || parent.payload.root !== normalized.root) {
        throw new Error("引用的回复暂不可用，请取消引用或重新读取讨论。");
      }
    }
  }
  const author = new PublicKey(account.address);
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: author, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: FORUM_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
    new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [{ pubkey: author, isSigner: true, isWritable: false }], data: memo }),
    forumIndexInstruction(author, normalized),
  );
  inspectForumTransaction(transaction);
  const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (bytes.length > 1232) throw new Error("内容超出单笔链上容量，请缩短后再发布。");
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  if (fee.value === null) throw new Error("交易已过期，请重新发布。");
  const balance = await connection.getBalance(author, "confirmed");
  if (balance < fee.value) throw new Error("开发网 SOL 不足，请从钱包面板领取后再发布。");
  if (!stillActive()) throw new Error("钱包账户已切换，请重新发布。");
  if (!wallet.features["solana:signTransaction"].supportedTransactionVersions.includes("legacy")) {
    throw new Error("这个钱包暂不支持论坛交易，请换用支持 Solana 的钱包。");
  }
  onSigning();
  const outputs = await wallet.features["solana:signTransaction"].signTransaction({ account, chain: CHAIN, transaction: bytes });
  if (!outputs[0]) throw new Error("钱包没有返回签名，请重试。");
  if (!stillActive()) throw new Error("钱包账户已切换，交易尚未发送。");
  const raw = outputs[0].signedTransaction;
  if (raw.length > 1232) throw new Error("钱包返回的交易超出容量，发布已停止。");
  const signed = Transaction.from(raw);
  if (!signed.feePayer?.equals(author) || signed.recentBlockhash !== transaction.recentBlockhash) {
    throw new Error("钱包返回的作者或交易有效期发生变化，发布已停止。");
  }
  const checked = inspectForumTransaction(signed);
  if (!checked.memo.data.equals(memo)) throw new Error("钱包返回的标题、正文或讨论关联发生变化，发布已停止。");
  if (!signed.signature || !signed.verifySignatures()) throw new Error("钱包未返回有效的作者签名，请重新发布。");
  if (balance < fee.value + Number(checked.priorityFeeLamports)) throw new Error("开发网 SOL 不足以支付钱包设置的交易费。");
  const receipt: ForumReceipt = { signature: encodeSignature(signed.signature), author: account.address,
    text: normalized.body, payload: normalized, lastValidBlockHeight: latest.lastValidBlockHeight, status: "pending",
    ...(articleBody ? { articleBody, articleStored: false } : {}) };
  // Persist before sending; network ambiguity must never trigger a second post.
  onBroadcast(receipt);
  try {
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    if (signature !== receipt.signature) throw new Error("节点返回的交易编号不一致，请通过已保存的凭证继续确认。");
    return receipt;
  } catch (error) {
    if (error instanceof SendTransactionError && !/already.?processed|already been processed/i.test(error.message)) {
      onBroadcast({ ...receipt, status: "failed" });
      throw error;
    }
    return receipt;
  }
}
