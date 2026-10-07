import { ComputeBudgetProgram, Connection, PublicKey, SendTransactionError, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import type { StandardConnectFeature, StandardDisconnectFeature, StandardEventsFeature } from "@wallet-standard/features";
import { inspectJournalTransaction, MAX_LENGTH, MEMO_PREFIX, MEMO_PROGRAM, NOTE_COMPUTE_UNITS } from "./journal-transaction";

export { MAX_LENGTH, MEMO_PREFIX, MEMO_PROGRAM } from "./journal-transaction";

export const CHAIN = "solana:devnet";
export const PAGE_SIZE = 60;
export type JournalWallet = Wallet & {
  features: Wallet["features"] & StandardConnectFeature & StandardEventsFeature & SolanaSignTransactionFeature & Partial<StandardDisconnectFeature>;
};
export type Note = {
  signature: string; author: string; text: string;
  blockTime: number | null; slot: number; finalized: boolean;
};
export type Receipt = {
  signature: string; author: string; text: string;
  lastValidBlockHeight: number; status: "pending" | "confirmed" | "failed";
};

export function isJournalWallet(wallet: Wallet): wallet is JournalWallet {
  return wallet.chains.includes(CHAIN) && !!wallet.features["standard:connect"] &&
    !!wallet.features["standard:events"] && !!wallet.features["solana:signTransaction"];
}

export function usableAccount(accounts: readonly WalletAccount[]) {
  return accounts.find(account => account.chains.includes(CHAIN) && account.features.includes("solana:signTransaction")) ?? null;
}

export function createConnection() {
  const proxy = new URL("/api/rpc", window.location.origin).toString();
  const publicDevnet = "https://api.devnet.solana.com";
  // This preference belongs to one browser connection, never to server state.
  let directUntil = 0;

  async function request(url: string, init: RequestInit | undefined, timeout: number) {
    const controller = new AbortController();
    const originalSignal = init?.signal;
    const abort = () => controller.abort();
    if (originalSignal?.aborted) controller.abort();
    originalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      return await window.fetch(url, {
        ...init, signal: controller.signal,
        ...(url === publicDevnet ? { credentials: "omit", headers: { "Content-Type": "application/json" } } : {}),
      });
    } finally {
      clearTimeout(timer);
      originalSignal?.removeEventListener("abort", abort);
    }
  }

  return new Connection(proxy, {
    commitment: "confirmed", disableRetryOnRateLimit: true,
    async fetch(_url, init) {
      const routes = Date.now() < directUntil ? [publicDevnet, proxy] : [proxy, publicDevnet];
      for (let index = 0; index < routes.length; index++) {
        const route = routes[index];
        try {
          const response = await request(route, init, route === proxy ? 7_000 : 15_000);
          const json = !!response.headers.get("Content-Type")?.includes("json");
          const transient = [429, 500, 502, 503, 504].includes(response.status)
            || (route === publicDevnet && [401, 403].includes(response.status));
          if (json && (!transient || index === routes.length - 1)) {
            if (route === proxy && response.ok) directUntil = 0;
            return response;
          }
          await response.body?.cancel();
        } catch (error) {
          if (init?.signal?.aborted) throw error;
        }
        if (route === proxy) directUntil = Date.now() + 60_000;
      }
      throw new Error("SOLANA_RPC_NETWORK_UNAVAILABLE: 当前网络暂时无法访问开发网节点，请稍后重试。");
    },
  });
}

export function cleanText(text: string) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function encodeNote(text: string) {
  const cleaned = cleanText(text).trim();
  if (!cleaned) throw new Error("先写下一点想法。");
  if (cleaned.length > MAX_LENGTH) throw new Error("请把这条手记缩短到 120 字以内。");
  const memo = Buffer.from(`${MEMO_PREFIX}${JSON.stringify({ text: cleaned })}`, "utf8");
  if (memo.length > 400) throw new Error("这段文字稍长，请精简后发布。");
  return memo;
}

export async function prepareNote(connection: Connection, author: string, text: string) {
  const owner = new PublicKey(author);
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: owner, blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight }).add(
    // Provide both settings before signing so MetaMask does not have to insert
    // them. Devnet notes use the base fee with no requested priority fee.
    ComputeBudgetProgram.setComputeUnitLimit({ units: NOTE_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
    new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM),
    keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: encodeNote(text),
  }));
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  if (fee.value === null) throw new Error("当前交易已过期，请重新发布。");
  const balance = await connection.getBalance(owner, "confirmed");
  if (balance < fee.value) throw new Error("开发网 SOL 不足。请打开右上角钱包面板领取，再发布手记。");
  return { transaction, latest, fee: fee.value, balance };
}

function signatureText(bytes: Uint8Array) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let result = "";
  while (value > BigInt(0)) {
    result = alphabet[Number(value % BigInt(58))] + result;
    value /= BigInt(58);
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  return "1".repeat(zeroes) + result;
}

export async function submitNote(connection: Connection, wallet: JournalWallet, account: WalletAccount,
  text: string, onSigning: () => void, stillActive: () => boolean, onBroadcast: (receipt: Receipt) => void) {
  const { transaction, latest, fee, balance } = await prepareNote(connection, account.address, text);
  const expectedMemo = inspectJournalTransaction(transaction).memo;
  if (!stillActive()) throw new Error("钱包账户已切换，请重新发布。");
  if (!wallet.features["solana:signTransaction"].supportedTransactionVersions.includes("legacy")) {
    throw new Error("这个钱包暂不支持此类交易，请换用支持 Solana 的钱包。");
  }
  onSigning();
  const outputs = await wallet.features["solana:signTransaction"].signTransaction({
    account, chain: CHAIN,
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
  });
  const output = outputs[0];
  if (!output) throw new Error("钱包没有返回签名，请重试。");
  if (!stillActive()) throw new Error("钱包账户已切换，交易尚未发送。");
  const signed = Transaction.from(output.signedTransaction);
  if (!signed.feePayer?.equals(transaction.feePayer!) || signed.recentBlockhash !== transaction.recentBlockhash) {
    throw new Error("钱包返回的作者或交易有效期发生变化，发布已停止。");
  }
  const checked = inspectJournalTransaction(signed);
  if (!checked.memo.data.equals(expectedMemo.data)) {
    throw new Error("钱包返回的手记正文发生变化，发布已停止。");
  }
  if (!signed.signature || !signed.verifySignatures()) {
    throw new Error("钱包未返回有效的作者签名，请重新发布。");
  }
  if (balance < fee + Number(checked.priorityFeeLamports)) {
    throw new Error("开发网 SOL 不足以支付钱包设置的交易费。请在钱包面板领取后重试。");
  }
  // Save the known signature before broadcasting, so an interrupted HTTP response
  // cannot cause the same draft to be sent as a second transaction.
  const receipt: Receipt = { signature: signatureText(signed.signature), author: account.address, text: cleanText(text).trim(),
    lastValidBlockHeight: latest.lastValidBlockHeight, status: "pending" as const };
  onBroadcast(receipt);
  try {
    const signature = await connection.sendRawTransaction(output.signedTransaction, {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    return { ...receipt, signature };
  } catch (error) {
    if (error instanceof SendTransactionError && /already.?processed|already been processed/i.test(error.message)) {
      return receipt;
    }
    if (error instanceof SendTransactionError) {
      onBroadcast({ ...receipt, status: "failed" });
      throw error;
    }
    // An unknown delivery outcome is resolved by querying this exact signature.
    return receipt;
  }
}

export async function receiptStatus(connection: Connection, receipt: Receipt) {
  const result = await connection.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true });
  const status = result.value[0];
  if (status?.err) return "failed" as const;
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return "confirmed" as const;
  if (!status && await connection.getBlockHeight("confirmed") > receipt.lastValidBlockHeight) {
    const final = await connection.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true });
    const last = final.value[0];
    if (last?.err) return "failed" as const;
    if (last?.confirmationStatus === "confirmed" || last?.confirmationStatus === "finalized") return "confirmed" as const;
    if (!last) return "expired" as const;
  }
  return "pending" as const;
}

export async function readNotes(connection: Connection, author: string, before?: string) {
  const owner = new PublicKey(author);
  const signatures = await connection.getSignaturesForAddress(owner, { limit: PAGE_SIZE, ...(before ? { before } : {}) }, "confirmed");
  const matches = signatures.filter(item => !item.err && item.memo?.includes(MEMO_PREFIX));
  const candidates = matches.slice(0, 24);
  const notes: Note[] = [];
  let unavailable = 0;
  for (let offset = 0; offset < candidates.length; offset += 3) {
    const batch = candidates.slice(offset, offset + 3);
    const transactions = await Promise.all(batch.map(async item => ({ item,
      transaction: await connection.getParsedTransaction(item.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
    })));
    for (const { item, transaction } of transactions) {
      if (!transaction) { unavailable++; continue; }
      if (transaction.meta?.err || !transaction.transaction.message.accountKeys.some(key => key.signer && key.pubkey.equals(owner))) continue;
      for (const instruction of transaction.transaction.message.instructions) {
        if (!("parsed" in instruction) || instruction.programId.toBase58() !== MEMO_PROGRAM || typeof instruction.parsed !== "string") continue;
        if (!instruction.parsed.startsWith(MEMO_PREFIX)) continue;
        try {
          const data: unknown = JSON.parse(instruction.parsed.slice(MEMO_PREFIX.length));
          if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string" || !data.text.trim() || data.text.length > MAX_LENGTH) continue;
          notes.push({ signature: item.signature, author, text: data.text,
            blockTime: transaction.blockTime ?? item.blockTime, slot: transaction.slot,
            finalized: item.confirmationStatus === "finalized" });
          break;
        } catch { /* Ignore memos outside the application's format. */ }
      }
    }
    if (offset + 3 < candidates.length) await new Promise(resolve => setTimeout(resolve, 850));
  }
  const capped = matches.length > 24;
  return { notes, unavailable,
    before: capped ? candidates.at(-1)?.signature : signatures.at(-1)?.signature,
    hasMore: capped || signatures.length === PAGE_SIZE };
}

export function explorerUrl(value: string, kind: "tx" | "address" = "tx") {
  return `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?cluster=devnet`;
}

export function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === -32002 || /already pending|request.*pending/i.test(message)) return "已有钱包请求等待处理，请先在钱包中完成当前授权。";
  if (/reject|declin|cancel|4001/i.test(message)) return "你取消了钱包操作，草稿仍然保留。";
  if (/429|rate limit|too many/i.test(message)) return "开发网请求较多，请稍等片刻再试。";
  if (/401|403|unauthorized|forbidden/i.test(message)) return "连接暂不可用，请检查钱包授权或稍后重试。";
  if (/insufficient|no record of a prior credit/i.test(message)) return "开发网 SOL 不足，请先领取开发网 SOL。";
  if (/blockhash.*not found|block height exceeded|expired/i.test(message)) return "交易等待过久，已过期；草稿仍然保留。";
  if (/fetch|network|timeout|500|502|503|504/i.test(message)) return "暂时连不上开发网，请稍后重试。";
  if (/[\u4e00-\u9fff]/.test(message)) return message;
  return "这次操作未完成。请检查钱包连接后重试。";
}
