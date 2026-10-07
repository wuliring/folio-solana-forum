import { ComputeBudgetInstruction, ComputeBudgetProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_PREFIX = "folio:v1:";
export const MAX_LENGTH = 120;
export const NOTE_COMPUTE_UNITS = 200_000;
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_PRIORITY_FEE_LAMPORTS = BigInt(50_000);

// Shared by the browser and the RPC proxy. A wallet may add or reorder compute
// budget instructions, but it may not add transfers or change the note's author.
export function inspectJournalTransaction(transaction: Transaction) {
  const owner = transaction.feePayer;
  if (!owner || !transaction.recentBlockhash || transaction.instructions.length < 1 || transaction.instructions.length > 3) {
    throw new Error("钱包返回的交易格式不符合链上手记要求，发布已停止。");
  }
  let memo: TransactionInstruction | undefined;
  let computeUnitLimit = NOTE_COMPUTE_UNITS;
  let microLamports = BigInt(0);
  const budgetTypes = new Set<string>();
  const allowedAccounts = new Set([owner.toBase58(), MEMO_PROGRAM]);
  for (const instruction of transaction.instructions) {
    if (instruction.programId.toBase58() === MEMO_PROGRAM) {
      if (memo || instruction.keys.length !== 1 || !instruction.keys[0].isSigner
        || !instruction.keys[0].pubkey.equals(owner) || instruction.data.length > 400) {
        throw new Error("钱包返回的手记内容或作者发生变化，发布已停止。");
      }
      memo = instruction;
      continue;
    }
    if (!instruction.programId.equals(ComputeBudgetProgram.programId) || instruction.keys.length) {
      throw new Error("交易包含链上手记不支持的操作，发布已停止。");
    }
    const type = ComputeBudgetInstruction.decodeInstructionType(instruction);
    if (budgetTypes.has(type)) throw new Error("钱包返回了重复的费用设置，请重新发布。");
    budgetTypes.add(type);
    allowedAccounts.add(ComputeBudgetProgram.programId.toBase58());
    if (type === "SetComputeUnitLimit" && instruction.data.length === 5) {
      computeUnitLimit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(instruction).units;
      if (!computeUnitLimit || computeUnitLimit > MAX_COMPUTE_UNITS) throw new Error("钱包返回的计算额度不符合要求，请重新发布。");
    } else if (type === "SetComputeUnitPrice" && instruction.data.length === 9) {
      microLamports = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(instruction).microLamports);
    } else {
      throw new Error("钱包返回了不支持的费用设置，发布已停止。");
    }
  }
  if (!memo) throw new Error("钱包返回的交易缺少手记正文，发布已停止。");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(memo.data);
  if (!text.startsWith(MEMO_PREFIX)) throw new Error("钱包返回的手记格式发生变化，发布已停止。");
  const note: unknown = JSON.parse(text.slice(MEMO_PREFIX.length));
  if (!note || typeof note !== "object" || Array.isArray(note) || !("text" in note)
    || typeof note.text !== "string" || !note.text.trim() || note.text.length > MAX_LENGTH) {
    throw new Error("钱包返回的手记正文不符合要求，发布已停止。");
  }
  const message = transaction.compileMessage();
  const accounts = message.accountKeys.map(key => key.toBase58());
  if (message.header.numRequiredSignatures !== 1 || message.header.numReadonlySignedAccounts !== 0
    || message.header.numReadonlyUnsignedAccounts !== accounts.length - 1
    || accounts[0] !== owner.toBase58() || accounts.length !== allowedAccounts.size
    || new Set(accounts).size !== accounts.length || accounts.some(address => !allowedAccounts.has(address))) {
    throw new Error("钱包返回的交易账户发生变化，发布已停止。");
  }
  const priorityFeeLamports = (BigInt(computeUnitLimit) * microLamports + BigInt(999_999)) / BigInt(1_000_000);
  if (priorityFeeLamports > MAX_PRIORITY_FEE_LAMPORTS) {
    throw new Error("钱包设置的优先费过高，请调低费用后再发布。");
  }
  return { memo, priorityFeeLamports };
}
