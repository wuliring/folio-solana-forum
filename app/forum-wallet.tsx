"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getWallets } from "@wallet-standard/app";
import type { WalletAccount } from "@wallet-standard/base";
import { PublicKey, type Connection } from "@solana/web3.js";
import { Check, Copy, ExternalLink, LoaderCircle, LockKeyhole, LogOut, RefreshCw } from "lucide-react";
import { explorerUrl, friendlyError, isJournalWallet, usableAccount, type JournalWallet } from "../lib/solana";
import { isMetaMaskWallet, loadMetaMaskWallet, watchMetaMaskExtension } from "../lib/metamask";
import { ForumModal } from "./forum-parts";

export function useForumWallet(connection: Connection | null, busy: RefObject<boolean>) {
  const [wallets, setWallets] = useState<JournalWallet[]>([]);
  const [wallet, setWallet] = useState<JournalWallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [metaMask, setMetaMask] = useState<JournalWallet | null>(null);
  const [metaMaskLoading, setMetaMaskLoading] = useState(false);
  const [metaMaskError, setMetaMaskError] = useState("");
  const [extension, setExtension] = useState(false);
  const [error, setError] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const accountRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const connectingRef = useRef(false);
  accountRef.current = account?.address ?? null;

  useEffect(() => {
    mounted.current = true;
    const registry = getWallets();
    const update = () => setWallets(registry.get().filter(isJournalWallet).filter(item => !isMetaMaskWallet(item)));
    update();
    const register = registry.on("register", update);
    const unregister = registry.on("unregister", update);
    const discovery = watchMetaMaskExtension(setExtension);
    return () => { mounted.current = false; register(); unregister(); discovery(); };
  }, []);

  const initializeMetaMask = useCallback(async () => {
    setMetaMaskLoading(true); setMetaMaskError("");
    try { const selected = await loadMetaMaskWallet(); if (mounted.current) setMetaMask(selected); }
    catch { if (mounted.current) setMetaMaskError("MetaMask 连接入口暂时未加载成功，可以重试。"); }
    finally { if (mounted.current) setMetaMaskLoading(false); }
  }, []);

  useEffect(() => {
    if (!open) { setError(""); return; }
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    if (!metaMask && !metaMaskLoading && !metaMaskError) void initializeMetaMask();
  }, [open, metaMask, metaMaskLoading, metaMaskError, initializeMetaMask]);

  useEffect(() => {
    if (!wallet) return;
    return wallet.features["standard:events"].on("change", change => {
      if (!change.accounts) return;
      const next = usableAccount(change.accounts);
      accountRef.current = next?.address ?? null;
      setAccount(next);
      if (!next) setWallet(null);
    });
  }, [wallet]);

  const refreshBalance = useCallback(async () => {
    if (!connection || !account) return;
    const author = account.address;
    setBalanceError(false);
    try {
      const lamports = await connection.getBalance(new PublicKey(author), "confirmed");
      if (mounted.current && accountRef.current === author) setBalance(lamports / 1e9);
    } catch { if (mounted.current && accountRef.current === author) setBalanceError(true); }
  }, [connection, account]);

  useEffect(() => { setBalance(null); setBalanceError(false); void refreshBalance(); }, [refreshBalance]);

  async function connect(selected: JournalWallet) {
    if (connectingRef.current || busy.current) return;
    setError("");
    if (isMetaMaskWallet(selected)) {
      if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        setError("当前使用 Solana 开发网，请用桌面浏览器的 MetaMask 扩展连接。"); return;
      }
      if (!extension) { setError("未检测到 MetaMask 扩展，请在已安装钱包的 Chrome 或 Edge 中打开本站并刷新。"); return; }
    }
    connectingRef.current = true; setConnecting(selected.name);
    try {
      const result = await selected.features["standard:connect"].connect();
      const active = usableAccount(result.accounts);
      if (!active) throw new Error("请在钱包中启用 Solana 开发网账户，再连接。");
      if (!mounted.current) return;
      accountRef.current = active.address;
      setWallet(selected); setAccount(active); setOpen(false);
    } catch (reason) { if (mounted.current) setError(friendlyError(reason)); }
    finally { connectingRef.current = false; if (mounted.current) setConnecting(null); }
  }

  async function disconnect() {
    if (!wallet || busy.current) return;
    try { await wallet.features["standard:disconnect"]?.disconnect(); } catch { /* Local session still ends. */ }
    if (!mounted.current) return;
    accountRef.current = null;
    setWallet(null); setAccount(null); setOpen(false);
  }

  return { wallets, wallet, account, accountRef, open, setOpen, connecting, metaMask, metaMaskLoading,
    metaMaskError, extension, error, balance, balanceError, refreshBalance, initializeMetaMask, connect, disconnect };
}

export function ForumWalletPanel({ controller: w, busy }: { controller: ReturnType<typeof useForumWallet>; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copy() {
    if (!w.account) return;
    try { await navigator.clipboard.writeText(w.account.address); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  }
  useEffect(() => { setCopied(false); setCopyError(false); }, [w.account?.address]);
  const choices = <>
    <div className="wallet-options">
      <button type="button" disabled={!!w.connecting || busy || !w.metaMask} onClick={() => { if (w.metaMask) void w.connect(w.metaMask); }}>
        {w.metaMask ? <img src={w.metaMask.icon} alt="" width="36" height="36" /> : <span className="metamask-placeholder" aria-hidden="true">M</span>}
        <span className="wallet-option-label">MetaMask<small>Solana 开发网 · 桌面浏览器扩展</small></span>
        {w.metaMaskLoading || w.connecting === w.metaMask?.name ? <LoaderCircle className="spin" size={18} /> : <span className="wallet-available">{w.extension ? "连接" : "需安装扩展"}</span>}
      </button>
      {w.wallets.map((item, index) => <button type="button" key={`${item.name}-${index}`} disabled={!!w.connecting || busy} onClick={() => void w.connect(item)}>
        <img src={item.icon} alt="" width="36" height="36" /><span className="wallet-option-label">{item.name}<small>Solana Devnet</small></span>
        {w.connecting === item.name ? <LoaderCircle className="spin" size={18} /> : <span className="wallet-available">已检测到</span>}
      </button>)}
    </div>
    {w.metaMaskError && <div className="wallet-error" role="alert"><p>{w.metaMaskError}</p><button type="button" className="text-button" onClick={() => void w.initializeMetaMask()} disabled={w.metaMaskLoading}>重新加载 MetaMask</button></div>}
    {w.error && <div className="wallet-error" role="alert">{w.error}</div>}
    <div className="metamask-guide"><p>MetaMask 开发网需使用桌面浏览器扩展。</p><a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">安装 MetaMask<ExternalLink size={13} /></a></div>
    {!w.wallets.length && !w.extension && <p className="modal-footnote">请在装有钱包扩展的浏览器中打开本站。也支持兼容开发网的 Phantom、Solflare 等钱包。</p>}
  </>;
  return <ForumModal open={w.open} onClose={() => w.setOpen(false)} title={w.account ? "我的钱包" : "连接钱包"}>
    {w.account ? <>
      <div className="wallet-account"><div className="account-title">{w.wallet?.icon && <img src={w.wallet.icon} alt="" width="30" height="30" />}<strong>{w.wallet?.name}</strong><span className="connection-status"><Check size={12} />已连接</span></div><p>主题和回复都由这个地址签名。</p></div>
      <div className="wallet-address"><span className="field-label">签名地址</span><div className="address-row"><code>{w.account.address}</code><button type="button" className="icon-button" onClick={() => void copy()} aria-label={copied ? "地址已复制" : "复制钱包地址"}>{copied ? <Check size={17} /> : <Copy size={17} />}</button></div>
        {copyError && <p className="field-error">复制暂不可用，可以手动选择上面的地址。</p>}
      </div>
      <div className="balance-row"><div><span className="field-label">开发网余额</span><strong>{w.balanceError ? "暂时无法读取" : w.balance === null ? "读取中…" : `${w.balance.toLocaleString("en-US", { maximumFractionDigits: 5 })} SOL`}</strong></div><button type="button" className="icon-button" onClick={() => void w.refreshBalance()} aria-label="重新读取余额"><RefreshCw size={17} /></button></div>
      <div className="wallet-actions"><a href={explorerUrl(w.account.address, "address")} target="_blank" rel="noopener noreferrer">查看地址<ExternalLink size={13} /></a><button type="button" disabled={busy} onClick={() => void w.disconnect()}><LogOut size={14} />断开连接</button></div>
    </> : <><p className="modal-copy">浏览不需要钱包。发布主题、参与回复时，由你在钱包中确认签名。</p>{choices}</>}
    <div className="wallet-network"><div><span className="field-label">当前网络</span><strong>Solana Devnet</strong></div><p>领取开发网 SOL，用于支付交易费。开发网记录可能重置。</p><a href="https://faucet.solana.com/" target="_blank" rel="noopener noreferrer">领取开发网 SOL<ExternalLink size={14} /></a></div>
    {w.account && <details className="wallet-switch"><summary>更换钱包</summary><div>{choices}</div></details>}
    <p className="modal-footnote"><LockKeyhole size={13} />连接授权和交易签名都由钱包处理。</p>
  </ForumModal>;
}
