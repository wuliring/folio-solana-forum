import { ComputeBudgetInstruction, ComputeBudgetProgram, PublicKey, SystemProgram, Transaction,
  type TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { isForumSignature, threadReference } from "./forum-protocol";
import { MEMO_PROGRAM } from "./journal-transaction";

export const TIP_PREFIX = "folio:tip:v1:";
export const MAX_TIP_LAMPORTS = 10_000_000_000;
export type TipPayload = { root: string; recipient: string; lamports: number };

export function parseSolAmount(value: string) {
  const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) throw new Error("请输入 SOL 金额，最多保留 9 位小数。");
  const lamports = BigInt(match[1]) * BigInt(1_000_000_000) + BigInt((match[2] ?? "").padEnd(9, "0"));
  if (lamports <= BigInt(0) || lamports > BigInt(MAX_TIP_LAMPORTS)) throw new Error("单次开发网打赏需大于 0，最多 10 SOL。");
  return Number(lamports);
}

export function solAmount(lamports: number) {
  const whole = Math.floor(lamports / 1_000_000_000);
  const fraction = String(lamports % 1_000_000_000).padStart(9, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

export function tipReference(root: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("folio:tip:v1"), threadReference(root).toBuffer()], new PublicKey(MEMO_PROGRAM))[0];
}

export function tipMemo(payload: TipPayload) {
  if (!isForumSignature(payload.root) || !Number.isSafeInteger(payload.lamports) || payload.lamports <= 0 || payload.lamports > MAX_TIP_LAMPORTS) {
    throw new Error("打赏金额或原帖凭证无效。");
  }
  if (new PublicKey(payload.recipient).toBase58() !== payload.recipient) throw new Error("收款钱包地址无效。");
  return Buffer.from(TIP_PREFIX + JSON.stringify(payload), "utf8");
}

export function tipTransfer(author: PublicKey, payload: TipPayload) {
  const instruction = SystemProgram.transfer({ fromPubkey: author, toPubkey: new PublicKey(payload.recipient), lamports: payload.lamports });
  instruction.keys.push({ pubkey: tipReference(payload.root), isSigner: false, isWritable: false });
  return instruction;
}

export function inspectTipTransaction(transaction: Transaction) {
  const author = transaction.feePayer;
  if (!author || !transaction.recentBlockhash || transaction.instructions.length < 2 || transaction.instructions.length > 4) throw new Error("打赏交易格式无效。");
  let memo: TransactionInstruction | undefined;
  let transfer: TransactionInstruction | undefined;
  let units = 200_000;
  let price = BigInt(0);
  const budgets = new Set<string>();
  for (const instruction of transaction.instructions) {
    if (instruction.programId.toBase58() === MEMO_PROGRAM) {
      if (memo || instruction.keys.length !== 1 || !instruction.keys[0].pubkey.equals(author)
        || !instruction.keys[0].isSigner || instruction.data.length > 400) throw new Error("打赏凭证或付款人发生变化。");
      memo = instruction;
    } else if (instruction.programId.equals(SystemProgram.programId)) {
      if (transfer) throw new Error("打赏交易包含额外转账。");
      transfer = instruction;
    } else if (instruction.programId.equals(ComputeBudgetProgram.programId) && !instruction.keys.length) {
      const type = ComputeBudgetInstruction.decodeInstructionType(instruction);
      if (budgets.has(type)) throw new Error("打赏交易存在重复费用设置。");
      budgets.add(type);
      if (type === "SetComputeUnitLimit" && instruction.data.length === 5) {
        units = ComputeBudgetInstruction.decodeSetComputeUnitLimit(instruction).units;
        if (!units || units > 1_400_000) throw new Error("计算额度无效。");
      } else if (type === "SetComputeUnitPrice" && instruction.data.length === 9) {
        price = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(instruction).microLamports);
      } else { throw new Error("打赏交易存在不支持的费用设置。"); }
    } else { throw new Error("打赏交易包含不支持的操作。"); }
  }
  if (!memo || !transfer) throw new Error("打赏交易缺少转账或凭证。");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(memo.data);
  if (!text.startsWith(TIP_PREFIX)) throw new Error("打赏凭证格式无效。");
  const value: unknown = JSON.parse(text.slice(TIP_PREFIX.length));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("打赏凭证无效。");
  const data = value as Record<string, unknown>;
  if (!isForumSignature(data.root) || typeof data.recipient !== "string" || typeof data.lamports !== "number"
    || Object.keys(data).some(key => !["root", "recipient", "lamports"].includes(key))) throw new Error("打赏凭证无效。");
  const payload: TipPayload = { root: data.root, recipient: data.recipient, lamports: data.lamports };
  tipMemo(payload);
  const recipient = new PublicKey(payload.recipient);
  if (recipient.equals(author)) throw new Error("请用读者钱包支持其他作者。");
  const expected = tipTransfer(author, payload);
  if (!transfer.data.equals(expected.data) || transfer.keys.length !== 3 || !transfer.keys[0].pubkey.equals(author)
    || !transfer.keys[0].isSigner || !transfer.keys[0].isWritable || !transfer.keys[1].pubkey.equals(recipient)
    || transfer.keys[1].isSigner || !transfer.keys[1].isWritable || !transfer.keys[2].pubkey.equals(tipReference(payload.root))
    || transfer.keys[2].isSigner || transfer.keys[2].isWritable) throw new Error("钱包返回的收款人、金额或文章关联发生变化，打赏已停止。");
  const allowed = new Set([author.toBase58(), recipient.toBase58(), MEMO_PROGRAM, SystemProgram.programId.toBase58(), tipReference(payload.root).toBase58(),
    ...(budgets.size ? [ComputeBudgetProgram.programId.toBase58()] : [])]);
  const message = transaction.compileMessage();
  const accounts = message.accountKeys.map(key => key.toBase58());
  if (message.header.numRequiredSignatures !== 1 || message.header.numReadonlySignedAccounts !== 0
    || message.header.numReadonlyUnsignedAccounts !== accounts.length - 2 || accounts[0] !== author.toBase58()
    || accounts.length !== allowed.size || new Set(accounts).size !== accounts.length || accounts.some(key => !allowed.has(key))) {
    throw new Error("打赏交易的账户权限发生变化，已停止支付。");
  }
  const priorityFeeLamports = (BigInt(units) * price + BigInt(999_999)) / BigInt(1_000_000);
  if (priorityFeeLamports > BigInt(50_000)) throw new Error("钱包设置的优先费过高，请调低后再打赏。");
  return { author: author.toBase58(), payload, memo, priorityFeeLamports };
}
