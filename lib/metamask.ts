"use client";

import { Buffer } from "buffer";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { CHAIN, isJournalWallet, type JournalWallet } from "./solana";

const DEVNET_SCOPE = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
let walletPromise: Promise<JournalWallet> | null = null;

export function isMetaMaskWallet(wallet: Wallet) {
  return wallet.name.toLowerCase().includes("metamask");
}

// Provider discovery is only an availability hint. Authorization and Solana
// signatures are always handled by the official MetaMask client below.
export function watchMetaMaskExtension(onAvailable: (available: boolean) => void) {
  let detected = false;
  const announce = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const info: unknown = event.detail?.info;
    if (info && typeof info === "object" && "rdns" in info && typeof info.rdns === "string"
      && /^io\.metamask(?:\.|$)/.test(info.rdns)) {
      detected = true;
      onAvailable(true);
    }
  };
  const request = () => {
    const ethereum: unknown = (window as Window & { ethereum?: unknown }).ethereum;
    if (ethereum && typeof ethereum === "object" && "isMetaMask" in ethereum && ethereum.isMetaMask === true) {
      detected = true;
    }
    onAvailable(detected);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  };
  window.addEventListener("eip6963:announceProvider", announce);
  window.addEventListener("focus", request);
  window.addEventListener("ethereum#initialized", request);
  request();
  return () => {
    window.removeEventListener("eip6963:announceProvider", announce);
    window.removeEventListener("focus", request);
    window.removeEventListener("ethereum#initialized", request);
  };
}

export function loadMetaMaskWallet() {
  if (typeof window === "undefined") return Promise.reject(new Error("请在浏览器中连接 MetaMask。"));
  if (!walletPromise) {
    walletPromise = import("@metamask/connect-solana").then(async ({ createSolanaClient }) => {
      const client = await createSolanaClient({
        dapp: { name: "刻 · Solana 链上手记", url: window.location.origin,
          iconUrl: new URL("/favicon.svg", window.location.origin).toString() },
        api: { supportedNetworks: { devnet: "https://api.devnet.solana.com" } },
        analytics: { enabled: false },
      });
      const nativeWallet = client.getWallet();
      if (!isJournalWallet(nativeWallet)) throw new Error("MetaMask 的 Solana 连接暂不可用，请更新钱包扩展。");
      let authorized = new Set<string>();
      const toDevnetAccount = (account: WalletAccount): WalletAccount => ({
        address: account.address, publicKey: account.publicKey, label: account.label, icon: account.icon,
        chains: [CHAIN], features: ["solana:signTransaction"],
      });
      const approved = (accounts: readonly WalletAccount[]) => accounts.filter(account => authorized.has(account.address)).map(toDevnetAccount);
      const adapter: JournalWallet = {
        version: nativeWallet.version, name: "MetaMask", icon: nativeWallet.icon, chains: [CHAIN],
        get accounts() { return approved(nativeWallet.accounts); },
        features: {
          "standard:connect": {
            version: "1.0.0",
            async connect(input) {
              if (!input?.silent) {
                await client.core.connect([DEVNET_SCOPE], [], { solana_accountChanged_notifications: true });
              }
              const session = await client.core.provider.getSession();
              const accountIds = session?.sessionScopes[DEVNET_SCOPE]?.accounts ?? [];
              authorized = new Set(accountIds.map(id => id.slice(`${DEVNET_SCOPE}:`.length)));
              if (!authorized.size) {
                if (input?.silent) return { accounts: [] };
                throw new Error("请在 MetaMask 中授权 Solana 开发网账户。");
              }
              const result = await nativeWallet.features["standard:connect"].connect(input);
              const accounts = approved(result.accounts);
              if (!accounts.length && !input?.silent) throw new Error("当前 MetaMask 账户未授权开发网，请重新选择账户连接。");
              return { accounts };
            },
          },
          "standard:disconnect": nativeWallet.features["standard:disconnect"],
          "standard:events": {
            version: "1.0.0",
            on(event, listener) {
              return nativeWallet.features["standard:events"].on(event, change => listener({
                ...(change.accounts ? { accounts: approved(change.accounts) } : {}),
                ...(change.chains ? { chains: [CHAIN] } : {}),
              }));
            },
          },
          "solana:signTransaction": {
            version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
            async signTransaction(...inputs) {
              const session = await client.core.provider.getSession();
              const accounts = session?.sessionScopes[DEVNET_SCOPE]?.accounts ?? [];
              const outputs: { signedTransaction: Uint8Array }[] = [];
              for (const input of inputs) {
                if (input.chain !== CHAIN || !accounts.includes(`${DEVNET_SCOPE}:${input.account.address}`)) {
                  throw new Error("MetaMask 的开发网授权已改变，请重新连接钱包。");
                }
                // The native adapter's signTransaction can use its restored
                // scope. Explicitly request the Devnet scope for this app.
                const result = await client.core.invokeMethod({
                  scope: DEVNET_SCOPE,
                  request: { method: "signTransaction", params: {
                    account: { address: input.account.address }, scope: DEVNET_SCOPE,
                    transaction: Buffer.from(input.transaction).toString("base64"),
                  } },
                });
                if (!result || typeof result !== "object" || Array.isArray(result)
                  || !("signedTransaction" in result) || typeof result.signedTransaction !== "string") {
                  throw new Error("MetaMask 未返回交易签名，请重试。");
                }
                outputs.push({ signedTransaction: Uint8Array.from(Buffer.from(result.signedTransaction, "base64")) });
              }
              return outputs;
            },
          },
        },
      };
      return adapter;
    }).catch(error => { walletPromise = null; throw error; });
  }
  return walletPromise;
}
