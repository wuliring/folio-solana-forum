import { ComputeBudgetProgram, Message, PublicKey, SendTransactionError, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import type { WalletAccount } from "@wallet-standard/base";
import { CHAIN, MEMO_PROGRAM, type JournalWallet, type Receipt } from "./solana";
import { readForumEntry } from "./forum";
import { encodeSignature } from "./forum-protocol";
import { inspectTipTransaction, solAmount, tipMemo, tipTransfer, type TipPayload } from "./tip-protocol";

export type TipReceipt = Receipt & TipPayload;

export async function confirmedTip(connection: Connection, receipt: TipReceipt) {
  const result = await connection.getTransaction(receipt.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!result) return false;
  if (!result.meta || result.meta.err || !(result.transaction.message instanceof Message)) throw new Error("这笔打赏的链上记录无效。");
  const transaction = Transaction.populate(result.transaction.message, result.transaction.signatures);
  const checked = inspectTipTransaction(transaction);
  if (!transaction.signature || encodeSignature(transaction.signature) !== receipt.signature || !transaction.verifySignatures()
    || checked.author !== receipt.author || checked.payload.root !== receipt.root || checked.payload.recipient !== receipt.recipient
    || checked.payload.lamports !== receipt.lamports) throw new Error("支付凭证与链上金额、收款人或文章不一致。");
  return true;
}

export async function submitTip(connection: Connection, wallet: JournalWallet, account: WalletAccount, payload: TipPayload,
  onSigning: () => void, stillActive: () => boolean, onBroadcast: (receipt: TipReceipt) => void, onFee: (lamports: number) => void) {
  const topic = await readForumEntry(connection, payload.root);
  if (!topic || topic.payload.kind !== "topic" || topic.author !== payload.recipient) throw new Error("原帖作者暂时无法核对，请重新读取文章后再打赏。");
  const author = new PublicKey(account.address);
  if (account.address === payload.recipient) throw new Error("这是你自己的文章，可以分享给读者来支持你。");
  const memo = tipMemo(payload);
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: author, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
    new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [{ pubkey: author, isSigner: true, isWritable: false }], data: memo }),
    tipTransfer(author, payload),
  );
  inspectTipTransaction(transaction);
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  if (fee.value === null) throw new Error("交易已过期，请重新发起打赏。");
  onFee(fee.value);
  const balance = await connection.getBalance(author, "confirmed");
  if (balance < payload.lamports + fee.value) throw new Error("开发网 SOL 不足以支付打赏和交易费，请先在钱包面板领取。");
  if (!stillActive()) throw new Error("钱包账户已切换，打赏未发送。");
  if (!wallet.features["solana:signTransaction"].supportedTransactionVersions.includes("legacy")) throw new Error("这个钱包暂不支持当前打赏交易。");
  onSigning();
  const output = (await wallet.features["solana:signTransaction"].signTransaction({ account, chain: CHAIN,
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }) }))[0];
  if (!output) throw new Error("钱包没有返回签名，打赏未发送。");
  if (!stillActive()) throw new Error("钱包账户已切换，打赏未发送。");
  if (output.signedTransaction.length > 1232) throw new Error("钱包返回的交易过大，打赏已停止。");
  const signed = Transaction.from(output.signedTransaction);
  if (!signed.feePayer?.equals(author) || signed.recentBlockhash !== transaction.recentBlockhash) throw new Error("付款钱包或交易有效期发生变化，打赏已停止。");
  const checked = inspectTipTransaction(signed);
  if (!checked.memo.data.equals(memo)) throw new Error("钱包返回的打赏对象或金额发生变化，支付已停止。");
  if (!signed.signature || !signed.verifySignatures()) throw new Error("钱包未返回有效签名，打赏已停止。");
  if (balance < payload.lamports + fee.value + Number(checked.priorityFeeLamports)) throw new Error("余额不足以支付钱包设置的交易费。");
  const receipt: TipReceipt = { ...payload, author: account.address, signature: encodeSignature(signed.signature),
    text: `${solAmount(payload.lamports)} SOL`, lastValidBlockHeight: latest.lastValidBlockHeight, status: "pending" };
  onBroadcast(receipt);
  try {
    await connection.sendRawTransaction(output.signedTransaction, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    return receipt;
  } catch (error) {
    if (error instanceof SendTransactionError && !/already.?processed|already been processed/i.test(error.message)) {
      onBroadcast({ ...receipt, status: "failed" }); throw error;
    }
    return receipt;
  }
}
