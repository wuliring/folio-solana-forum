"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { Check, ExternalLink, Heart, LoaderCircle, Wallet, X } from "lucide-react";
import { explorerUrl, friendlyError, receiptStatus } from "../lib/solana";
import { isForumSignature } from "../lib/forum-protocol";
import { parseSolAmount, solAmount, MAX_TIP_LAMPORTS } from "../lib/tip-protocol";
import { confirmedTip, submitTip, type TipReceipt } from "../lib/tipping";
import type { Topic } from "../lib/forum";
import { deviceGet, deviceSet, ForumModal, shortAddress } from "./forum-parts";
import type { useForumWallet } from "./forum-wallet";

const pendingKey = (author: string) => `folio:devnet:tip:pending:${author}`;
function savedTip(author: string): TipReceipt | null {
  try {
    const value = JSON.parse(deviceGet(pendingKey(author)) ?? "null");
    if (!value || value.author !== author || value.status !== "pending" || !isForumSignature(value.root) || !isForumSignature(value.signature)
      || !Number.isSafeInteger(value.lamports) || value.lamports <= 0 || value.lamports > MAX_TIP_LAMPORTS
      || !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight <= 0
      || typeof value.recipient !== "string" || new PublicKey(value.recipient).toBase58() !== value.recipient) return null;
    return { author, signature: value.signature, root: value.root, recipient: value.recipient, lamports: value.lamports,
      text: `${solAmount(value.lamports)} SOL`, status: "pending", lastValidBlockHeight: value.lastValidBlockHeight };
  } catch { return null; }
}

export default function ArticleTipping({ connection, controller: w, busyRef, busy, contentPending, topic, open, onClose, onPhase, onPending }: {
  connection: Connection | null; controller: ReturnType<typeof useForumWallet>; busyRef: RefObject<boolean>; busy: boolean;
  contentPending: boolean; topic: Topic | null; open: boolean; onClose: () => void;
  onPhase: (phase: "idle" | "preparing" | "signing" | "confirming") => void; onPending: (pending: boolean) => void;
}) {
  const [amount, setAmount] = useState("0.01");
  const [fee, setFee] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<TipReceipt | null>(null);
  const [error, setError] = useState("");
  const [stage, setStage] = useState("idle");
  const mounted = useRef(true);
  const receiptRef = useRef(receipt);
  receiptRef.current = receipt;
  let lamports = 0;
  let amountError = "";
  try { lamports = parseSolAmount(amount); } catch (reason) { amountError = reason instanceof Error ? reason.message : "金额无效。"; }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!busyRef.current) setReceipt(w.account ? savedTip(w.account.address) : null);
  }, [w.account?.address, busyRef]);
  useEffect(() => { onPending(receipt?.status === "pending"); }, [receipt, onPending]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (w.account && event.key === pendingKey(w.account.address) && !busyRef.current) setReceipt(savedTip(w.account.address));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [w.account, busyRef]);
  useEffect(() => { if (open) { setError(""); setFee(null); } }, [open, topic?.signature]);

  function clear(item: TipReceipt) {
    const current = savedTip(item.author);
    if (!current || current.signature === item.signature) deviceSet(pendingKey(item.author), null);
  }

  async function confirm(item: TipReceipt) {
    if (!connection) return;
    onPhase("confirming"); setStage("confirming");
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!mounted.current) return;
      const status = await receiptStatus(connection, item);
      if (status === "confirmed" && await confirmedTip(connection, item)) {
        if (!mounted.current) return;
        clear(item); setReceipt({ ...item, status: "confirmed" }); setError(""); onClose(); void w.refreshBalance(); return;
      }
      if (status === "failed" || status === "expired") {
        clear(item); setReceipt({ ...item, status: "failed" });
        throw new Error(status === "expired" ? "打赏交易已过期，未完成支付，可以重新发起。" : "打赏未成功上链，请查看凭证后再重试。");
      }
      if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 2_500));
    }
    setError("支付仍在等待确认，凭证已保存。请继续确认同一笔交易，不要重复打赏。");
  }

  async function resume() {
    const item = receiptRef.current;
    if (!item || item.status !== "pending" || busyRef.current || !connection) return;
    busyRef.current = true; setError("");
    try { await confirm(item); }
    catch (reason) { if (mounted.current) setError(friendlyError(reason)); }
    finally { busyRef.current = false; if (mounted.current) { setStage("idle"); onPhase("idle"); } }
  }

  async function pay() {
    if (!topic || !connection || busyRef.current || contentPending) return;
    if (!w.wallet || !w.account) { w.setOpen(true); return; }
    const existing = savedTip(w.account.address) ?? (receiptRef.current?.status === "pending" ? receiptRef.current : null);
    if (existing) { setReceipt(existing); setError("已有打赏等待确认，请先继续确认已有支付。"); return; }
    if (amountError) { setError(amountError); return; }
    const account = w.account;
    busyRef.current = true; onPhase("preparing"); setStage("preparing"); setError("");
    try {
      const item = await submitTip(connection, w.wallet, account, { root: topic.signature, recipient: topic.author, lamports },
        () => { if (mounted.current) { setStage("signing"); onPhase("signing"); } },
        () => mounted.current && w.accountRef.current === account.address,
        next => {
          if (next.status === "pending") {
            if (!deviceSet(pendingKey(next.author), JSON.stringify(next))) throw new Error("此浏览器无法保存支付凭证，打赏尚未发送。请允许网站存储后重试。");
          } else { clear(next); }
          receiptRef.current = next;
          if (mounted.current) setReceipt(next);
        }, value => { if (mounted.current) setFee(value); });
      if (mounted.current) await confirm(item);
    } catch (reason) { if (mounted.current) setError(friendlyError(reason)); }
    finally { busyRef.current = false; if (mounted.current) { setStage("idle"); onPhase("idle"); } }
  }

  const waiting = receipt?.status === "pending";
  const status = receipt && <div className={`forum-receipt forum-receipt-${receipt.status} tip-receipt`} role="status" aria-live="polite"><div>{waiting ? <LoaderCircle className="spin" size={16} /> : <Heart size={16} />}<span>{waiting ? "打赏已签名，等待链上确认" : receipt.status === "confirmed" ? "开发网打赏已确认" : "打赏未完成"}<small>{solAmount(receipt.lamports)} Devnet SOL · {shortAddress(receipt.recipient)}</small></span></div><div><a href={explorerUrl(receipt.signature)} target="_blank" rel="noopener noreferrer">支付凭证<ExternalLink size={12} /></a>{waiting ? <button type="button" className="text-button" disabled={busy} onClick={() => void resume()}>继续确认支付</button> : <button type="button" className="icon-button" onClick={() => setReceipt(null)} aria-label="收起打赏结果"><X size={16} /></button>}</div></div>;

  return <>{status}{error && !open && <div className="notice notice-error" role="alert"><span>{error}</span><button type="button" className="icon-button" onClick={() => setError("")} aria-label="关闭支付提示"><X size={16} /></button></div>}
    <ForumModal open={open} onClose={onClose} title="支持这位作者" locked={busy}>
      {topic && <><p className="modal-copy">如果这篇文章对你有帮助，可以留下一份支持。</p><div className="tip-article"><span className="chapter-kicker">FOR THE AUTHOR</span><h3>{topic.payload.title}</h3><code>{topic.author}</code></div>
        <form onSubmit={event => { event.preventDefault(); void pay(); }}><div className="tip-presets">{["0.01", "0.1", "1"].map(value => <button type="button" key={value} aria-pressed={amount === value} disabled={busy || waiting} onClick={() => setAmount(value)}>{value}<span>SOL</span></button>)}</div>
          <label className="field-label" htmlFor="tip-amount">自定义金额 · 开发网 SOL</label><div className="tip-amount"><input id="tip-amount" type="text" inputMode="decimal" autoComplete="off" value={amount} disabled={busy || waiting} onChange={event => { setAmount(event.target.value); setError(""); }} aria-invalid={!!amountError} /><span>SOL</span></div>
          {amountError && <p className="field-error">{amountError}</p>}
          <dl className="tip-summary"><div><dt>网络</dt><dd>Solana Devnet</dd></div><div><dt>作者收到</dt><dd>{lamports ? solAmount(lamports) : "—"} SOL</dd></div><div><dt>网络费用</dt><dd>{fee === null ? "签名前读取，钱包确认" : `${solAmount(fee)} SOL 起`}</dd></div><div><dt>平台抽成</dt><dd>0</dd></div></dl>
          <p className="tip-network-note">当前支付的是开发网 SOL，不具有实际货币价值。打赏直接转入上面的作者地址，网络费另计。</p>
          {error && <div className="wallet-error" role="alert">{error}</div>}
          {waiting ? <button type="button" className="button button-primary full-width" disabled={busy} onClick={() => void resume()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}继续确认已有支付</button> : <button type="submit" className="button button-primary full-width" disabled={busy || contentPending || !!amountError || !connection || w.account?.address === topic.author}>{busy ? <LoaderCircle className="spin" size={16} /> : w.account ? <Heart size={16} /> : <Wallet size={16} />}{busy ? stage === "signing" ? "请在钱包中确认…" : stage === "confirming" ? "等待支付确认…" : "准备打赏…" : w.account?.address === topic.author ? "这是你自己的文章" : w.account ? `打赏 ${lamports ? solAmount(lamports) : ""} Devnet SOL` : "连接钱包后打赏"}</button>}
        </form></>}
    </ForumModal>
  </>;
}
