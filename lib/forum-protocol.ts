import { ComputeBudgetInstruction, ComputeBudgetProgram, PublicKey, SystemProgram,
  Transaction, type TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { MEMO_PROGRAM } from "./journal-transaction";

export const FORUM_PREFIX = "folio:forum:v1:";
export const MAX_FORUM_BYTES = 800;
export const MAX_TITLE_LENGTH = 48;
export const FORUM_COMPUTE_UNITS = 1_400_000;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MEMO_KEY = new PublicKey(MEMO_PROGRAM);
const MAX_PRIORITY_FEE = BigInt(50_000);

export type TopicPayload = { kind: "topic"; title: string; body: string; contentHash?: string; format?: "markdown" };
export type ReplyPayload = { kind: "reply"; root: string; body: string; parent?: string };
export type ForumPayload = TopicPayload | ReplyPayload;

export function encodeSignature(bytes: Uint8Array) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let text = "";
  while (value > BigInt(0)) { text = ALPHABET[Number(value % BigInt(58))] + text; value /= BigInt(58); }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + text;
}

function signatureBytes(signature: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new Error("帖子链接不完整，请重新打开。");
  let value = BigInt(0);
  for (const character of signature) value = value * BigInt(58) + BigInt(ALPHABET.indexOf(character));
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  while (signature[zeros] === "1") zeros++;
  const bytes = Buffer.concat([Buffer.alloc(zeros), value === BigInt(0) ? Buffer.alloc(0) : Buffer.from(hex, "hex")]);
  if (bytes.length !== 64 || encodeSignature(bytes) !== signature) throw new Error("帖子链接不完整，请重新打开。");
  return bytes;
}

export function isForumSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { signatureBytes(value); return true; } catch { return false; }
}

export const TOPICS_REFERENCE = PublicKey.findProgramAddressSync([Buffer.from("folio:forum:v1")], MEMO_KEY)[0];

export function threadReference(root: string) {
  const bytes = signatureBytes(root);
  return PublicKey.findProgramAddressSync([
    Buffer.from("folio:thread:v1"), bytes.subarray(0, 32), bytes.subarray(32, 64),
  ], MEMO_KEY)[0];
}

export function forumReference(payload: ForumPayload) {
  return payload.kind === "topic" ? TOPICS_REFERENCE : threadReference(payload.root);
}

export function normalizeForumPayload(payload: ForumPayload): ForumPayload {
  const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return payload.kind === "topic" ? { kind: "topic", title: clean(payload.title), body: clean(payload.body),
    ...(payload.contentHash ? { contentHash: payload.contentHash, format: "markdown" as const } : {}) }
    : { kind: "reply", root: payload.root, body: clean(payload.body), ...(payload.parent ? { parent: payload.parent } : {}) };
}

export function forumMemoSize(payload: ForumPayload) {
  return Buffer.byteLength(FORUM_PREFIX + JSON.stringify(normalizeForumPayload(payload)), "utf8");
}

export function parseForumPayload(value: unknown): ForumPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("内容格式不符合论坛要求。");
  const data = value as Record<string, unknown>;
  if (typeof data.body !== "string" || !data.body.trim() || data.body.length > MAX_FORUM_BYTES) {
    throw new Error("请先写下内容，并将它精简到链上容量以内。");
  }
  let payload: ForumPayload;
  if (data.kind === "topic") {
    if (typeof data.title !== "string" || !data.title.trim() || data.title.length > MAX_TITLE_LENGTH
      || Object.keys(data).some(key => !["kind", "title", "body", "contentHash", "format"].includes(key))) {
      throw new Error(`请填写不超过 ${MAX_TITLE_LENGTH} 字的主题标题。`);
    }
    if ((data.contentHash !== undefined || data.format !== undefined)
      && (typeof data.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(data.contentHash) || data.format !== "markdown")) {
      throw new Error("长文的内容指纹或格式无效。");
    }
    payload = { kind: "topic", title: data.title, body: data.body,
      ...(data.contentHash ? { contentHash: data.contentHash as string, format: "markdown" as const } : {}) };
  } else if (data.kind === "reply") {
    if (!isForumSignature(data.root) || (data.parent !== undefined && !isForumSignature(data.parent))
      || Object.keys(data).some(key => !["kind", "root", "body", "parent"].includes(key))) {
      throw new Error("回复关联的帖子不完整，请重新打开讨论页。");
    }
    payload = { kind: "reply", root: data.root, body: data.body, ...(data.parent ? { parent: data.parent as string } : {}) };
  } else { throw new Error("这条内容不属于论坛主题或回复。"); }
  const normalized = normalizeForumPayload(payload);
  if (normalized.body !== payload.body || (payload.kind === "topic" && normalized.kind === "topic" && normalized.title !== payload.title)) {
    throw new Error("内容包含无效空白或控制字符。");
  }
  if (forumMemoSize(payload) > MAX_FORUM_BYTES) throw new Error("内容超出链上容量，请缩短后再发布。");
  return payload;
}

export function encodeForumPayload(payload: ForumPayload) {
  const normalized = parseForumPayload(normalizeForumPayload(payload));
  return Buffer.from(FORUM_PREFIX + JSON.stringify(normalized), "utf8");
}

export function forumIndexInstruction(author: PublicKey, payload: ForumPayload) {
  // Memo accounts must all sign. A zero-lamport self-transfer instead carries
  // one read-only reference using the Solana Pay indexing convention. It moves
  // no SOL and neither creates nor funds the reference address.
  const instruction = SystemProgram.transfer({ fromPubkey: author, toPubkey: author, lamports: 0 });
  instruction.keys.push({ pubkey: forumReference(payload), isSigner: false, isWritable: false });
  return instruction;
}

// Browser and server share this whitelist. Compute-budget changes are allowed;
// changing content, author, thread, or introducing any real transfer is not.
export function inspectForumTransaction(transaction: Transaction) {
  const author = transaction.feePayer;
  if (!author || !transaction.recentBlockhash || transaction.instructions.length < 2 || transaction.instructions.length > 4) {
    throw new Error("钱包返回的交易不符合论坛要求，发布已停止。");
  }
  let memo: TransactionInstruction | undefined;
  let index: TransactionInstruction | undefined;
  let units = FORUM_COMPUTE_UNITS;
  let price = BigInt(0);
  const budgets = new Set<string>();
  for (const instruction of transaction.instructions) {
    if (instruction.programId.equals(MEMO_KEY)) {
      if (memo || instruction.keys.length !== 1 || !instruction.keys[0].isSigner
        || !instruction.keys[0].pubkey.equals(author) || instruction.data.length > MAX_FORUM_BYTES) {
        throw new Error("钱包返回的内容或作者发生变化，发布已停止。");
      }
      memo = instruction;
    } else if (instruction.programId.equals(SystemProgram.programId)) {
      if (index) throw new Error("交易包含多余的转账操作，发布已停止。");
      index = instruction;
    } else if (instruction.programId.equals(ComputeBudgetProgram.programId) && instruction.keys.length === 0) {
      const type = ComputeBudgetInstruction.decodeInstructionType(instruction);
      if (budgets.has(type)) throw new Error("钱包返回了重复的费用设置。");
      budgets.add(type);
      if (type === "SetComputeUnitLimit" && instruction.data.length === 5) {
        units = ComputeBudgetInstruction.decodeSetComputeUnitLimit(instruction).units;
        if (!units || units > 1_400_000) throw new Error("钱包设置的计算额度无效。");
      } else if (type === "SetComputeUnitPrice" && instruction.data.length === 9) {
        price = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(instruction).microLamports);
      } else { throw new Error("钱包返回了不支持的费用设置。"); }
    } else { throw new Error("交易包含论坛不支持的操作，发布已停止。"); }
  }
  if (!memo || !index) throw new Error("交易缺少论坛正文或讨论关联，发布已停止。");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(memo.data);
  if (!text.startsWith(FORUM_PREFIX)) throw new Error("论坛内容格式发生变化。");
  const payload = parseForumPayload(JSON.parse(text.slice(FORUM_PREFIX.length)));
  const reference = forumReference(payload);
  const expected = forumIndexInstruction(author, payload);
  if (!index.data.equals(expected.data) || index.keys.length !== 3
    || !index.keys[0].pubkey.equals(author) || !index.keys[0].isSigner || !index.keys[0].isWritable
    || !index.keys[1].pubkey.equals(author) || !index.keys[1].isWritable
    || !index.keys[2].pubkey.equals(reference) || index.keys[2].isSigner || index.keys[2].isWritable) {
    throw new Error("钱包返回的讨论关联或零金额记录发生变化，发布已停止。");
  }
  const allowed = new Set([author.toBase58(), MEMO_PROGRAM, SystemProgram.programId.toBase58(), reference.toBase58(),
    ...(budgets.size ? [ComputeBudgetProgram.programId.toBase58()] : [])]);
  const message = transaction.compileMessage();
  const accounts = message.accountKeys.map(key => key.toBase58());
  if (message.header.numRequiredSignatures !== 1 || message.header.numReadonlySignedAccounts !== 0
    || message.header.numReadonlyUnsignedAccounts !== accounts.length - 1 || accounts[0] !== author.toBase58()
    || accounts.length !== allowed.size || new Set(accounts).size !== accounts.length || accounts.some(key => !allowed.has(key))) {
    throw new Error("钱包返回的交易账户发生变化，发布已停止。");
  }
  const priorityFeeLamports = (BigInt(units) * price + BigInt(999_999)) / BigInt(1_000_000);
  if (priorityFeeLamports > MAX_PRIORITY_FEE) throw new Error("钱包设置的优先费过高，请调低后再发布。");
  return { author: author.toBase58(), memo, payload, reference, priorityFeeLamports };
}
