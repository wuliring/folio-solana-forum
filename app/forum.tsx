"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { Check, ExternalLink, Feather, HelpCircle, Link as LinkIcon, LoaderCircle,
  LockKeyhole, MessageCircle, MessagesSquare, Plus, RefreshCw, Search,
  ShieldCheck, UserRound, Wallet as WalletIcon, Heart, Bold, Heading2, List, Code, Eye, Image as ImageIcon, X } from "lucide-react";
import { createConnection, explorerUrl, friendlyError, receiptStatus } from "../lib/solana";
import { forumMemoSize, isForumSignature, MAX_FORUM_BYTES, MAX_TITLE_LENGTH, normalizeForumPayload,
  parseForumPayload, type ForumPayload } from "../lib/forum-protocol";
import { readForumEntry, readReplies, readTopics, submitForumEntry, type ForumReceipt, type Reply, type Topic } from "../lib/forum";
import ThemeControl from "./theme-control";
import { deviceGet, deviceSet, ForumDate, ForumModal, shortAddress } from "./forum-parts";
import { ForumWalletPanel, useForumWallet } from "./forum-wallet";
import { loadArticle, MAX_ARTICLE_BYTES, MAX_ARTICLE_CHARACTERS, normalizeArticle, prepareArticle, saveArticle } from "../lib/articles";
import ArticleMarkdown from "./article-markdown";
import ArticleTipping from "./article-tipping";

type View = { kind: "community" } | { kind: "mine" } | { kind: "author"; address: string } | { kind: "topic"; signature: string };
type Notice = { text: string; kind: "error" | "success" | "info" } | null;
type Phase = "idle" | "preparing" | "signing" | "confirming" | "saving";
type TopicDraft = { title: string; body: string };
type ReplyDraft = { root: string; body: string; parent?: string };
const TOPIC_DRAFT_KEY = "folio:devnet:forum:topic-draft";
const replyDraftKey = (root: string) => `folio:devnet:forum:reply-draft:${root}`;
const pendingKey = (author: string) => `folio:devnet:forum:pending:${author}`;

function viewFromUrl(): View {
  const url = new URL(window.location.href);
  if (url.searchParams.has("topic")) return { kind: "topic", signature: url.searchParams.get("topic") ?? "" };
  if (url.searchParams.has("author")) return { kind: "author", address: url.searchParams.get("author") ?? "" };
  return { kind: url.searchParams.get("view") === "mine" ? "mine" : "community" };
}

function viewUrl(view: View) {
  if (view.kind === "topic") return `/?topic=${encodeURIComponent(view.signature)}`;
  if (view.kind === "author") return `/?author=${encodeURIComponent(view.address)}`;
  return view.kind === "mine" ? "/?view=mine" : "/";
}

function readTopicDraft(): TopicDraft {
  try {
    const value = JSON.parse(deviceGet(TOPIC_DRAFT_KEY) ?? "null");
    if (value && typeof value.title === "string" && typeof value.body === "string") {
      return { title: value.title.slice(0, MAX_TITLE_LENGTH), body: value.body.slice(0, MAX_ARTICLE_CHARACTERS) };
    }
  } catch { /* A damaged local draft does not affect chain data. */ }
  return { title: "", body: "" };
}

function readReplyDraft(root: string): ReplyDraft {
  try {
    const value = JSON.parse(deviceGet(replyDraftKey(root)) ?? "null");
    if (value && typeof value.body === "string") return { root, body: value.body.slice(0, 2_000), ...(isForumSignature(value.parent) ? { parent: value.parent } : {}) };
  } catch { /* The editor can start a new local draft. */ }
  return { root, body: "" };
}

function readPending(author: string): ForumReceipt | null {
  try {
    const value = JSON.parse(deviceGet(pendingKey(author)) ?? "null");
    if (!value || value.author !== author || !isForumSignature(value.signature) || !["pending", "confirmed"].includes(value.status)
      || !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight <= 0) return null;
    const payload = parseForumPayload(value.payload);
    if (value.text !== payload.body) return null;
    const articleBody = typeof value.articleBody === "string" && value.articleBody.length <= MAX_ARTICLE_CHARACTERS ? value.articleBody : undefined;
    if (payload.kind === "topic" && payload.contentHash && !articleBody) return null;
    if (value.status === "confirmed" && (payload.kind !== "topic" || !payload.contentHash || value.articleStored)) return null;
    return { signature: value.signature, author, payload, text: payload.body, status: value.status,
      lastValidBlockHeight: value.lastValidBlockHeight, ...(articleBody ? { articleBody, articleStored: false } : {}) };
  } catch { return null; }
}

function Avatar({ address }: { address: string }) {
  return <span className="forum-avatar" aria-hidden="true">{address.slice(0, 2)}</span>;
}

function ChainLink({ signature }: { signature: string }) {
  return <a className="forum-chain-link" href={explorerUrl(signature)} target="_blank" rel="noopener noreferrer"><ShieldCheck size={13} />链上凭证<ExternalLink size={11} /></a>;
}

export default function Forum() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [view, setView] = useState<View>({ kind: "community" });
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<Notice>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState<TopicDraft>({ title: "", body: "" });
  const [draftSaved, setDraftSaved] = useState(false);
  const [replyDraft, setReplyDraft] = useState<ReplyDraft>({ root: "", body: "" });
  const [replySaved, setReplySaved] = useState(false);
  const [receipt, setReceipt] = useState<ForumReceipt | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicCursor, setTopicCursor] = useState<string | undefined>();
  const [moreTopics, setMoreTopics] = useState(false);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState("");
  const [feedUnavailable, setFeedUnavailable] = useState(0);
  const [search, setSearch] = useState("");
  const [topic, setTopic] = useState<Topic | null>(null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [replyCursor, setReplyCursor] = useState<string | undefined>();
  const [moreReplies, setMoreReplies] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [replyError, setReplyError] = useState("");
  const [replyUnavailable, setReplyUnavailable] = useState(0);
  const [shared, setShared] = useState(false);
  const [articleBody, setArticleBody] = useState("");
  const [articleSignature, setArticleSignature] = useState("");
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState("");
  const [articleRetry, setArticleRetry] = useState(0);
  const [editorMode, setEditorMode] = useState<"write" | "preview">("write");
  const [tipTopic, setTipTopic] = useState<Topic | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const [tipPending, setTipPending] = useState(false);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const receiptRef = useRef<ForumReceipt | null>(null);
  const viewRef = useRef(view);
  const draftRef = useRef(draft);
  const replyDraftRef = useRef(replyDraft);
  const feedRequest = useRef(0);
  const threadRequest = useRef(0);
  const replyEditor = useRef<HTMLTextAreaElement>(null);
  const articleEditor = useRef<HTMLTextAreaElement>(null);
  const w = useForumWallet(connection, busyRef);
  const busy = phase !== "idle";
  const contentPending = receipt?.status === "pending" || !!(receipt?.status === "confirmed" && receipt.payload.kind === "topic" && receipt.payload.contentHash && !receipt.articleStored);
  const pending = contentPending || tipPending;
  const author = view.kind === "author" ? view.address : view.kind === "mine" ? w.account?.address : undefined;
  const listKey = `${view.kind}:${author ?? ""}`;
  const listKeyRef = useRef(listKey);
  listKeyRef.current = listKey;
  viewRef.current = view;
  draftRef.current = draft;
  replyDraftRef.current = replyDraft;
  receiptRef.current = receipt;

  useEffect(() => {
    mounted.current = true;
    setConnection(createConnection());
    setView(viewFromUrl());
    setDraft(readTopicDraft());
    setReady(true);
    const pop = () => { const next = viewFromUrl(); viewRef.current = next; setView(next); setSearch(""); };
    window.addEventListener("popstate", pop);
    return () => { mounted.current = false; feedRequest.current++; threadRequest.current++; window.removeEventListener("popstate", pop); };
  }, []);

  const navigate = useCallback((next: View) => {
    window.history.pushState(null, "", viewUrl(next));
    viewRef.current = next; setView(next); setSearch(""); setShared(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  useEffect(() => {
    if (!ready) return;
    setDraftSaved(false);
    const timer = setTimeout(() => setDraftSaved(deviceSet(TOPIC_DRAFT_KEY, draft.title || draft.body ? JSON.stringify(draft) : null)), 450);
    return () => clearTimeout(timer);
  }, [draft, ready]);

  useEffect(() => {
    if (view.kind !== "topic") return;
    setReplyDraft(readReplyDraft(view.signature)); setReplySaved(false);
  }, [view]);

  useEffect(() => {
    if (!ready || !replyDraft.root) return;
    setReplySaved(false);
    const timer = setTimeout(() => setReplySaved(deviceSet(replyDraftKey(replyDraft.root), replyDraft.body || replyDraft.parent ? JSON.stringify(replyDraft) : null)), 450);
    return () => clearTimeout(timer);
  }, [replyDraft, ready]);

  useEffect(() => {
    if (!busyRef.current) setReceipt(w.account ? readPending(w.account.address) : null);
  }, [w.account?.address]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (!w.account || event.key !== pendingKey(w.account.address) || busyRef.current) return;
      setReceipt(readPending(w.account.address));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [w.account]);

  const loadFeed = useCallback(async (append = false) => {
    if (!connection || view.kind === "topic" || (view.kind === "mine" && !author)) return;
    const request = ++feedRequest.current;
    const key = listKey;
    setFeedLoading(true); setFeedError("");
    try {
      if (author) {
        try { new PublicKey(author); } catch { throw new Error("这个钱包地址不完整，请重新打开作者页面。"); }
      }
      const result = await readTopics(connection, append ? topicCursor : undefined, author);
      if (!mounted.current || request !== feedRequest.current || key !== listKeyRef.current) return;
      setTopics(current => Array.from(new Map((append ? [...current, ...result.entries] : result.entries).map(item => [item.signature, item])).values()));
      setTopicCursor(result.before); setMoreTopics(result.hasMore);
      setFeedUnavailable(current => append ? current + result.unavailable : result.unavailable);
    } catch (error) {
      if (mounted.current && request === feedRequest.current) setFeedError(friendlyError(error));
    } finally { if (mounted.current && request === feedRequest.current) setFeedLoading(false); }
  }, [connection, view.kind, author, listKey, topicCursor]);

  const feedLoader = useRef(loadFeed);
  feedLoader.current = loadFeed;
  useEffect(() => {
    feedRequest.current++;
    setTopics([]); setTopicCursor(undefined); setMoreTopics(false); setFeedUnavailable(0); setFeedError(""); setFeedLoading(false);
    if (connection && ready && view.kind !== "topic") void feedLoader.current(false);
  }, [connection, ready, listKey, view.kind]);

  const loadThread = useCallback(async (append = false) => {
    if (!connection || view.kind !== "topic") return;
    const root = view.signature;
    const request = ++threadRequest.current;
    setThreadLoading(true); setReplyError("");
    if (!append) setThreadError("");
    let rootRead = append;
    const active = () => mounted.current && request === threadRequest.current && viewRef.current.kind === "topic" && viewRef.current.signature === root;
    try {
      if (!append) {
        const entry = await readForumEntry(connection, root);
        if (!active()) return;
        if (!entry || entry.payload.kind !== "topic") {
          setTopic(null); setThreadError("这条主题暂时无法从开发网读取，可能尚未确认、链接有误或历史记录已不可用。"); return;
        }
        setTopic(entry as Topic); rootRead = true;
      }
      const result = await readReplies(connection, root, append ? replyCursor : undefined);
      if (!active()) return;
      setReplies(current => Array.from(new Map((append ? [...current, ...result.entries] : result.entries).map(item => [item.signature, item])).values()).sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature)));
      setReplyCursor(result.before); setMoreReplies(result.hasMore);
      setReplyUnavailable(current => append ? current + result.unavailable : result.unavailable);
    } catch (error) {
      if (active()) { if (rootRead) setReplyError(friendlyError(error)); else setThreadError(friendlyError(error)); }
    } finally { if (active()) setThreadLoading(false); }
  }, [connection, view, replyCursor]);

  const threadLoader = useRef(loadThread);
  threadLoader.current = loadThread;
  useEffect(() => {
    threadRequest.current++;
    setTopic(null); setReplies([]); setReplyCursor(undefined); setMoreReplies(false); setThreadError(""); setReplyError(""); setReplyUnavailable(0); setThreadLoading(false); setShared(false);
    if (connection && ready && view.kind === "topic") void threadLoader.current(false);
  }, [connection, ready, view]);

  useEffect(() => {
    let active = true;
    setArticleBody(""); setArticleSignature(""); setArticleError(""); setArticleLoading(false);
    if (!topic) return;
    if (!topic.payload.contentHash) { setArticleBody(topic.payload.body); setArticleSignature(topic.signature); return; }
    setArticleLoading(true);
    void loadArticle(topic.signature, topic.payload.contentHash).then(body => {
      if (active) { setArticleBody(body); setArticleSignature(topic.signature); }
    }).catch(error => { if (active) setArticleError(friendlyError(error)); })
      .finally(() => { if (active) setArticleLoading(false); });
    return () => { active = false; };
  }, [topic?.signature, topic?.payload.contentHash, articleRetry]);

  function clearPending(item: ForumReceipt) {
    const stored = readPending(item.author);
    if (!stored || stored.signature === item.signature) deviceSet(pendingKey(item.author), null);
  }

  async function complete(item: ForumReceipt) {
    let confirmed = { ...item, status: "confirmed" as const };
    if (item.payload.kind === "topic" && item.payload.contentHash) {
      if (!item.articleBody) throw new Error("链上原帖已确认，但正文草稿缺失，请恢复原稿后完成发布。");
      confirmed = { ...confirmed, articleStored: false };
      deviceSet(pendingKey(item.author), JSON.stringify(confirmed));
      receiptRef.current = confirmed; setReceipt(confirmed); setPhase("saving");
      await saveArticle(item.signature, item.articleBody);
      if (!mounted.current) return;
      confirmed = { ...confirmed, articleStored: true };
    }
    clearPending(item);
    receiptRef.current = confirmed; setReceipt(confirmed);
    setNotice({ text: item.payload.kind === "topic" ? "文章已发布，作者和内容指纹已写入链上。" : "回复已获得链上确认。", kind: "success" });
    if (item.payload.kind === "topic") {
      const matches = item.articleBody ? normalizeArticle(draftRef.current.body) === item.articleBody && draftRef.current.title.trim() === item.payload.title
        : JSON.stringify(normalizeForumPayload({ kind: "topic", ...draftRef.current })) === JSON.stringify(item.payload);
      if (matches) { setDraft({ title: "", body: "" }); deviceSet(TOPIC_DRAFT_KEY, null); }
      setComposeOpen(false); navigate({ kind: "topic", signature: item.signature });
    } else {
      const root = item.payload.root;
      const current = replyDraftRef.current.root === root ? replyDraftRef.current : readReplyDraft(root);
      const payload = normalizeForumPayload({ kind: "reply", ...current });
      if (JSON.stringify(payload) === JSON.stringify(item.payload)) {
        deviceSet(replyDraftKey(root), null);
        if (replyDraftRef.current.root === root) setReplyDraft({ root, body: "" });
      }
      if (viewRef.current.kind === "topic" && viewRef.current.signature === root) void threadLoader.current(false);
    }
    void w.refreshBalance();
  }

  async function confirm(item: ForumReceipt) {
    if (!connection) return;
    if (item.status === "confirmed") { await complete(item); return; }
    setPhase("confirming");
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!mounted.current) return;
      const status = await receiptStatus(connection, item);
      if (!mounted.current) return;
      if (status === "confirmed") { await complete(item); return; }
      if (status === "failed" || status === "expired") {
        clearPending(item);
        const failed = { ...item, status: "failed" as const };
        receiptRef.current = failed; setReceipt(failed);
        throw new Error(status === "expired" ? "这笔交易已过期，草稿仍然保留，可以重新签名发布。" : "这笔交易未成功上链，草稿仍然保留。");
      }
      if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 2_500));
    }
    setNotice({ text: "仍在等待链上确认。凭证已保存，点击“继续确认”即可查询同一笔交易。", kind: "info" });
  }

  async function continueConfirm() {
    const item = receiptRef.current;
    if (!item || item.status === "failed" || !connection || busyRef.current) return;
    busyRef.current = true; setNotice(null);
    try { await confirm(item); }
    catch (error) { if (mounted.current) setNotice({ text: friendlyError(error), kind: "error" }); }
    finally { busyRef.current = false; if (mounted.current) setPhase("idle"); }
  }

  async function publish(payload: ForumPayload, body?: string) {
    if (busyRef.current || !connection || tipPending) return;
    if (!w.wallet || !w.account) { w.setOpen(true); return; }
    const author = w.account.address;
    const existing = readPending(author) ?? (receiptRef.current?.author === author && contentPending ? receiptRef.current : null);
    if (existing) {
      receiptRef.current = existing; setReceipt(existing);
      setNotice({ text: "你还有一笔发布等待确认，请先继续确认已有交易。", kind: "info" }); return;
    }
    busyRef.current = true; setPhase("preparing"); setNotice(null);
    try {
      const item = await submitForumEntry(connection, w.wallet, w.account, payload,
        () => { if (mounted.current) setPhase("signing"); },
        () => mounted.current && w.accountRef.current === author,
        next => {
          if (next.status === "pending") {
            if (!deviceSet(pendingKey(author), JSON.stringify(next))) throw new Error("此浏览器无法保存发布凭证，交易尚未发送。请允许网站存储后重试。");
          } else { clearPending(next); }
          receiptRef.current = next;
          if (mounted.current) { setReceipt(next); if (next.status === "pending") setPhase("confirming"); }
        }, body);
      if (mounted.current) await confirm(item);
    } catch (error) { if (mounted.current) setNotice({ text: friendlyError(error), kind: "error" }); }
    finally { busyRef.current = false; if (mounted.current) setPhase("idle"); }
  }

  async function publishArticle() {
    if (busyRef.current || pending) return;
    if (!w.account) { w.setOpen(true); return; }
    const snapshot = draftRef.current;
    try {
      const prepared = await prepareArticle(snapshot.title, snapshot.body);
      if (mounted.current) await publish(prepared.payload, prepared.body);
    } catch (error) { if (mounted.current) setNotice({ text: friendlyError(error), kind: "error" }); }
  }

  function insertMarkdown(before: string, after = "", fallback = "文字") {
    const editor = articleEditor.current;
    if (!editor || busy || pending) return;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const current = draftRef.current;
    const selected = current.body.slice(start, end) || fallback;
    const body = current.body.slice(0, start) + before + selected + after + current.body.slice(end);
    if (body.length > MAX_ARTICLE_CHARACTERS) return;
    setDraft({ ...current, body });
    requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }

  async function share() {
    if (!topic) return;
    try { await navigator.clipboard.writeText(new URL(viewUrl({ kind: "topic", signature: topic.signature }), window.location.origin).href); setShared(true); }
    catch { setNotice({ text: "复制暂不可用，可以复制浏览器地址栏中的帖子链接。", kind: "info" }); }
  }

  function quote(reply: Reply) {
    if (!topic || busy || pending) return;
    setReplyDraft(current => ({ ...current, root: topic.signature, parent: reply.signature }));
    replyEditor.current?.focus();
  }

  const topicBytes = new TextEncoder().encode(draft.body).length;
  const replyPayload: ForumPayload = { kind: "reply", ...replyDraft };
  const replyBytes = forumMemoSize(replyPayload);
  const visibleTopics = topics.filter(item => `${item.payload.title}\n${item.payload.body}\n${item.author}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  const title = view.kind === "mine" ? "我的文章" : view.kind === "author" ? "这个地址的文章" : "文章与讨论";
  const phaseText = phase === "preparing" ? "准备交易…" : phase === "signing" ? "请在钱包中确认…" : phase === "saving" ? "保存文章正文…" : "等待链上确认…";
  const publishText = busy ? phaseText : pending ? "先确认已有交易" : w.account ? "签名发布" : "连接钱包后发布";
  const quoted = replies.find(item => item.signature === replyDraft.parent);
  const articleVerified = !!topic && articleSignature === topic.signature && !!articleBody;
  const receiptLabel = receipt?.status === "pending" ? "已签名，等待链上确认" : receipt?.status === "confirmed"
    ? contentPending ? "链上已确认，正文待保存" : "发布已确认" : "发布未完成，草稿仍保留";

  return <div className="app-shell forum-app">
    <a className="skip-link" href="#forum-main">跳到讨论内容</a>
    <header className="site-header"><div className="header-inner forum-header">
      <a className="brand" href="/" onClick={event => { event.preventDefault(); navigate({ kind: "community" }); }} aria-label="FOLIO 社区首页"><span className="brand-mark" aria-hidden="true">刻</span><span className="brand-word">FOLIO<span>链上论坛</span></span></a>
      <div className="header-actions"><span className="network-tag">SOLANA DEVNET</span><ThemeControl /><button className="button button-outline header-wallet" type="button" disabled={busy} onClick={() => w.setOpen(true)} aria-haspopup="dialog" aria-expanded={w.open}><WalletIcon size={16} />{w.account ? shortAddress(w.account.address) : "连接钱包"}</button></div>
    </div></header>

    <div className="forum-layout">
      <aside className="forum-sidebar"><p className="chapter-kicker">THE COMMON ROOM</p>
        <nav className="forum-nav" aria-label="论坛导航">
          <a href="/" className={view.kind === "community" || view.kind === "topic" ? "active" : ""} aria-current={view.kind === "community" ? "page" : undefined} onClick={event => { event.preventDefault(); navigate({ kind: "community" }); }}><MessagesSquare size={18} /><span>文章与讨论</span><small>01</small></a>
          <a href="/?view=mine" className={view.kind === "mine" ? "active" : ""} aria-current={view.kind === "mine" ? "page" : undefined} onClick={event => { event.preventDefault(); navigate({ kind: "mine" }); }}><UserRound size={18} /><span>我的文章</span><small>02</small></a>
        </nav>
        <button type="button" className="button button-primary forum-new-topic" disabled={busy || pending} onClick={() => setComposeOpen(true)}><Feather size={17} />写一篇文章</button>
        <div className="forum-sidebar-note"><span className="forum-handwritten">ideas meet here.</span><p>一个想法，<br />也可以是一场对话。</p><span className="forum-sidebar-rule" aria-hidden="true" /></div>
        <button type="button" className="text-button forum-help" onClick={() => setHelpOpen(true)}><HelpCircle size={15} />使用说明</button>
      </aside>

      <main id="forum-main" className="forum-main">
        {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}><span>{notice.text}</span><button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={16} /></button></div>}
        {receipt && <div className={`forum-receipt forum-receipt-${receipt.status}`} role="status" aria-live="polite"><div>{contentPending ? <LoaderCircle size={16} className="spin" /> : receipt.status === "confirmed" ? <Check size={16} /> : <MessageCircle size={16} />}<span>{receiptLabel}<small>{receipt.payload.kind === "topic" ? "文章" : "回复"} · {shortAddress(receipt.signature)}</small></span></div><div><a href={explorerUrl(receipt.signature)} target="_blank" rel="noopener noreferrer">交易凭证<ExternalLink size={12} /></a>{contentPending ? <button type="button" className="text-button" disabled={busy || !connection} onClick={() => void continueConfirm()}>{receipt.status === "confirmed" ? "继续完成发布" : "继续确认"}</button> : <>{receipt.status === "confirmed" && <button type="button" className="text-button" onClick={() => navigate({ kind: "topic", signature: receipt.payload.kind === "topic" ? receipt.signature : receipt.payload.root })}>查看讨论</button>}<button type="button" className="icon-button" onClick={() => setReceipt(null)} aria-label="收起交易结果"><X size={16} /></button></>}</div></div>}
        <ArticleTipping connection={connection} controller={w} busyRef={busyRef} busy={busy} contentPending={contentPending}
          topic={tipTopic} open={tipOpen} onClose={() => setTipOpen(false)} onPhase={setPhase} onPending={setTipPending} />

        {!ready ? <div className="forum-loading" role="status"><LoaderCircle className="spin" size={19} />正在打开社区…</div> : view.kind !== "topic" ? <>
          <div className="forum-heading"><div><p className="chapter-kicker">01 / IDEAS WORTH READING</p><h1>{title}<span className="forum-title-mark" aria-hidden="true">*</span></h1><p>{view.kind === "community" ? "认真写一点，深入聊一点。" : view.kind === "mine" ? "由你的钱包签名，留下值得分享的内容。" : shortAddress(view.address)}</p></div><span className="forum-heading-stamp">READ.<br />DISCUSS.<br />SUPPORT.</span></div>
          <div className="forum-toolbar"><label className="forum-search"><Search size={16} /><span className="sr-only">搜索已加载的主题</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索已加载的主题" /></label><button type="button" className="icon-button" disabled={feedLoading || (view.kind === "mine" && !w.account)} onClick={() => void loadFeed(false)} aria-label="刷新主题"><RefreshCw className={feedLoading ? "spin" : ""} size={17} /></button><button type="button" className="button button-primary forum-mobile-compose" disabled={busy || pending} onClick={() => setComposeOpen(true)}><Plus size={16} />发帖</button></div>
          {view.kind === "author" && <div className="forum-author-filter"><code>{view.address}</code><button type="button" className="text-button" onClick={() => navigate({ kind: "community" })}>查看全部文章</button></div>}
          {view.kind === "mine" && !w.account ? <div className="empty-state"><span className="empty-glyph"><WalletIcon size={22} /></span><h3>你的文章，从钱包开始</h3><p>连接钱包，查看自己签名发布的文章。</p><button type="button" className="text-button" onClick={() => w.setOpen(true)}>连接钱包</button></div> : <>
            <div className="forum-list-caption"><span>文章 / 按发布时间</span><span>{topics.length ? `已加载 ${topics.length} 篇` : "公开浏览，无需登录"}</span></div>
            {feedError && <div className="feed-error" role="alert"><p>{feedError}</p><button type="button" className="text-button" disabled={feedLoading} onClick={() => void loadFeed(false)}>重新读取主题</button></div>}
            <div className="forum-topic-list" aria-busy={feedLoading}>
              {visibleTopics.map(item => <article className="forum-topic-row" key={item.signature}><Avatar address={item.author} /><div className="forum-topic-copy"><a className="forum-topic-title" href={viewUrl({ kind: "topic", signature: item.signature })} onClick={event => { event.preventDefault(); navigate({ kind: "topic", signature: item.signature }); }}><h2>{item.payload.title}</h2></a><p>{item.payload.body}</p><div className="forum-topic-meta"><a className="forum-author" href={viewUrl({ kind: "author", address: item.author })} onClick={event => { event.preventDefault(); navigate({ kind: "author", address: item.author }); }} title={item.author}>{shortAddress(item.author)}</a><span aria-hidden="true">·</span><ForumDate timestamp={item.blockTime} /><ChainLink signature={item.signature} /></div></div><a className="forum-discuss-link" href={viewUrl({ kind: "topic", signature: item.signature })} onClick={event => { event.preventDefault(); navigate({ kind: "topic", signature: item.signature }); }} aria-label={`进入“${item.payload.title}”的讨论`}><MessageCircle size={18} /><span>讨论</span></a></article>)}
            </div>
            {feedLoading && <div className="forum-loading" role="status"><LoaderCircle className="spin" size={18} />从链上读取主题…</div>}
            {!feedLoading && !feedError && !visibleTopics.length && <div className="empty-state"><span className="empty-glyph"><MessagesSquare size={22} /></span><h3>{search.trim() ? "已加载的主题中没有匹配内容" : feedUnavailable ? "部分链上记录暂时无法读取" : moreTopics ? "这一页没有匹配的主题" : view.kind === "community" ? "从一个想法，开始第一场讨论" : "这里还没有主题"}</h3><p>{search.trim() ? "试试其他关键词，或继续读取更早的主题。" : feedUnavailable ? "可以刷新重试，或继续读取更早的内容。" : moreTopics ? "继续读取更早的记录，寻找这个地址的主题。" : "发布一个问题、一点见解，邀请大家参与。"}</p>{!search.trim() && !feedUnavailable && !moreTopics && <button type="button" className="text-button" disabled={busy || pending} onClick={() => setComposeOpen(true)}>发起主题</button>}</div>}
            {feedUnavailable > 0 && <p className="history-note">有 {feedUnavailable} 条候选记录暂时不可用或不符合论坛格式，可刷新重新读取。</p>}
            {moreTopics && <button type="button" className="load-more" disabled={feedLoading} onClick={() => void loadFeed(true)}>{feedLoading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={15} />}读取更早的主题</button>}
          </>}
        </> : <>
          <div className="forum-thread-top"><button type="button" className="text-button" onClick={() => navigate({ kind: "community" })}><MessagesSquare size={15} />社区讨论</button><div><button type="button" className="icon-button" disabled={threadLoading} onClick={() => void loadThread(false)} aria-label="刷新当前讨论"><RefreshCw className={threadLoading ? "spin" : ""} size={17} /></button>{topic && <button type="button" className="text-button" onClick={() => void share()}>{shared ? <Check size={15} /> : <LinkIcon size={15} />}{shared ? "链接已复制" : "分享主题"}</button>}</div></div>
          {threadError && <div className="feed-error" role="alert"><p>{threadError}</p><button type="button" className="text-button" disabled={threadLoading} onClick={() => void loadThread(false)}>重新读取原帖</button></div>}
          {topic && <>
            <article className="forum-root-post"><p className="chapter-kicker">ESSAY / 一个值得展开的想法</p><h1>{topic.payload.title}</h1><div className="forum-post-author"><Avatar address={topic.author} /><div><a className="forum-author" href={viewUrl({ kind: "author", address: topic.author })} onClick={event => { event.preventDefault(); navigate({ kind: "author", address: topic.author }); }} title={topic.author}>{shortAddress(topic.author)}</a><span><ForumDate timestamp={topic.blockTime} />{articleVerified ? ` · 约 ${Math.max(1, Math.ceil(articleBody.length / 500))} 分钟阅读` : ""}</span></div><span className="forum-op">作者</span></div>
              {articleVerified ? <ArticleMarkdown body={articleBody} /> : articleError ? <div className="feed-error" role="alert"><p>{articleError}</p><button type="button" className="text-button" disabled={articleLoading} onClick={() => setArticleRetry(value => value + 1)}>重新读取正文</button></div> : <div className="forum-loading" role="status"><LoaderCircle size={18} className="spin" />读取正文与内容凭证…</div>}
              <div className="forum-post-foot"><div><ChainLink signature={topic.signature} />{topic.payload.contentHash && articleVerified && <span className="article-verified"><ShieldCheck size={13} />正文指纹已核对</span>}</div><button type="button" className="text-button" onClick={() => replyEditor.current?.focus()}><MessageCircle size={15} />参与讨论</button></div>
              <div className="article-support"><div><span className="chapter-kicker">GOOD WORDS DESERVE SUPPORT</span><p>这篇文章帮到了你？</p></div><button type="button" className="button button-outline" disabled={busy || pending || !articleVerified || w.account?.address === topic.author} onClick={() => { setTipTopic(topic); setTipOpen(true); }}><Heart size={16} />{w.account?.address === topic.author ? "这是你的文章" : "打赏作者"}</button><small>Devnet SOL · 直接到作者钱包</small></div>
            </article>
            <section className="forum-discussion" aria-labelledby="discussion-heading"><div className="forum-discussion-head"><h2 id="discussion-heading">讨论<span>{replies.length}</span></h2><p>已加载回复 · 按时间排列</p></div>
              {replyError && <div className="feed-error" role="alert"><p>{replyError}</p><button type="button" className="text-button" disabled={threadLoading} onClick={() => void loadThread(false)}>重新读取讨论</button></div>}
              {moreReplies && <button type="button" className="load-more" disabled={threadLoading} onClick={() => void loadThread(true)}><RefreshCw size={15} />读取更早的回复</button>}
              <div className="forum-reply-list" aria-busy={threadLoading}>{replies.map(item => {
                const parent = replies.find(candidate => candidate.signature === item.payload.parent);
                return <article className="forum-reply" key={item.signature} id={`reply-${item.signature}`}><Avatar address={item.author} /><div className="forum-reply-copy"><div className="forum-reply-author"><a className="forum-author" href={viewUrl({ kind: "author", address: item.author })} title={item.author} onClick={event => { event.preventDefault(); navigate({ kind: "author", address: item.author }); }}>{shortAddress(item.author)}</a>{item.author === topic.author && <span className="forum-op">作者</span>}<ForumDate timestamp={item.blockTime} /></div>
                  {item.payload.parent && (parent ? <a className="forum-quoted-reply" href={`#reply-${parent.signature}`}><span>回复 {shortAddress(parent.author)}</span><p>{parent.payload.body}</p></a> : <a className="forum-quoted-reply" href={explorerUrl(item.payload.parent)} target="_blank" rel="noopener noreferrer"><span>引用一条回复 · 查看链上记录<ExternalLink size={11} /></span></a>)}
                  <p className="forum-post-body">{item.payload.body}</p><div className="forum-reply-foot"><ChainLink signature={item.signature} /><button type="button" className="text-button" disabled={busy || pending} onClick={() => quote(item)}><MessageCircle size={14} />回复</button></div>
                </div></article>;
              })}</div>
              {threadLoading && <div className="forum-loading" role="status"><LoaderCircle className="spin" size={18} />从链上读取讨论…</div>}
              {!threadLoading && !replyError && !replies.length && <div className="forum-empty-replies"><MessageCircle size={20} /><p>{replyUnavailable ? "部分回复暂时无法读取，可以刷新重试。" : moreReplies ? "这一页没有可展示的回复，可以继续读取更早的记录。" : "还没有回复，来接住这个想法。"}</p></div>}
              {replyUnavailable > 0 && <p className="history-note">有 {replyUnavailable} 条候选记录暂时不可用或不符合论坛格式，可刷新重新读取。</p>}
            </section>
            <form className="forum-reply-composer" onSubmit={event => { event.preventDefault(); void publish(replyPayload); }}><div className="section-top"><h2><Feather size={16} />写下你的回复</h2><span className="writing-as">{w.account ? shortAddress(w.account.address) : "连接钱包后参与"}</span></div>
              {replyDraft.parent && <div className="forum-quote-target"><span>回复 {quoted ? shortAddress(quoted.author) : shortAddress(replyDraft.parent)}</span><button type="button" className="icon-button" disabled={busy} onClick={() => setReplyDraft(current => ({ root: current.root, body: current.body }))} aria-label="取消引用"><X size={15} /></button>{quoted && <p>{quoted.payload.body}</p>}</div>}
              <label className="sr-only" htmlFor="forum-reply-editor">回复正文</label><textarea id="forum-reply-editor" ref={replyEditor} value={replyDraft.root === topic.signature ? replyDraft.body : ""} maxLength={2_000} disabled={busy || pending} placeholder="补充一点见解，或者提出一个好问题…" onChange={event => setReplyDraft(current => ({ ...current, root: topic.signature, body: event.target.value }))} aria-describedby="forum-reply-size" />
              <div className="draft-meta"><span>{replySaved ? "草稿已保存在此设备" : "本地草稿"}</span><span id="forum-reply-size" className={replyBytes > MAX_FORUM_BYTES ? "limit-reached" : ""}>{replyBytes} / {MAX_FORUM_BYTES} 字节</span></div>
              {replyBytes > MAX_FORUM_BYTES && <p className="field-error" role="alert">回复超出链上容量，请精简正文或取消引用。</p>}
              <div className="forum-composer-footer"><p><LockKeyhole size={13} />公开上链，发布后无法修改。</p><button type="submit" className="button button-primary" disabled={busy || pending || !connection || !replyDraft.body.trim() || replyBytes > MAX_FORUM_BYTES || replyDraft.root !== topic.signature}>{busy ? <LoaderCircle className="spin" size={16} /> : <Feather size={16} />}{busy ? phaseText : pending ? "先确认已有交易" : w.account ? "签名回复" : "连接钱包后回复"}</button></div>
              <details className="forum-publish-details"><summary>交易说明</summary><p>钱包可能显示一笔发给自己的 0 SOL 记录，用于把回复归入讨论。只支付开发网网络费用；正文、作者和讨论关联都会核对。</p></details>
            </form>
          </>}
          {!topic && threadLoading && <div className="forum-loading" role="status"><LoaderCircle className="spin" size={19} />正在读取原帖…</div>}
        </>}
        <footer className="site-footer forum-footer"><span>THOUGHTS BECOME CONVERSATIONS.</span><button type="button" className="text-button" onClick={() => setHelpOpen(true)}>Solana 开发网 · 使用说明</button></footer>
      </main>

      <aside className="forum-context"><div className="forum-context-paper"><span className="chapter-kicker">A PLACE TO THINK</span><h2>好内容，<br />值得慢慢读。</h2><p>让观点有出处，<br />让讨论有回响。</p><span className="forum-context-doodle" aria-hidden="true">✳</span></div><div className="forum-context-note"><h3>给创作一点支持</h3><p>读完一篇好文章，<br />讨论，也可以打赏作者。</p><button type="button" className="text-button" onClick={() => setHelpOpen(true)}>如何参与<HelpCircle size={13} /></button></div><div className="forum-context-network"><span>SOLANA / DEVNET</span><p>当前打赏使用开发网 SOL。<br />记录可能重置，请保留备份。</p></div></aside>
    </div>

    <ForumWalletPanel controller={w} busy={busy} />
    <ForumModal open={composeOpen} onClose={() => setComposeOpen(false)} title="写一篇值得分享的文章" locked={busy} wide>
      <p className="modal-copy">展开你的思考、经验或研究进展。支持 Markdown 排版，发布前可以预览。</p>
      {notice && composeOpen && <div className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}><span>{notice.text}</span><button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="关闭发布提示"><X size={16} /></button></div>}
      {contentPending && <div className="forum-editor-pending"><p>{receiptLabel}</p><button type="button" className="text-button" disabled={busy} onClick={() => void continueConfirm()}>{busy ? phaseText : receipt?.status === "confirmed" ? "继续完成发布" : "继续确认已有交易"}</button></div>}
      <form className="forum-topic-form" onSubmit={event => { event.preventDefault(); void publishArticle(); }}><label className="field-label" htmlFor="forum-topic-title">文章标题</label><input id="forum-topic-title" value={draft.title} maxLength={MAX_TITLE_LENGTH} disabled={busy || pending} placeholder="给这个想法一个清楚的标题" onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} required />
        <div className="article-editor-tools"><div className="article-editor-modes"><button type="button" aria-pressed={editorMode === "write"} onClick={() => setEditorMode("write")}><Feather size={14} />编辑</button><button type="button" aria-pressed={editorMode === "preview"} onClick={() => setEditorMode("preview")}><Eye size={14} />预览</button></div>{editorMode === "write" && <div className="article-format-tools"><button type="button" className="icon-button" disabled={busy || pending} onClick={() => insertMarkdown("## ", "", "小标题")} aria-label="插入小标题" title="小标题"><Heading2 size={17} /></button><button type="button" className="icon-button" disabled={busy || pending} onClick={() => insertMarkdown("**", "**")} aria-label="加粗文字" title="加粗"><Bold size={16} /></button><button type="button" className="icon-button" disabled={busy || pending} onClick={() => insertMarkdown("\n- ", "", "列表内容")} aria-label="插入列表" title="列表"><List size={17} /></button><button type="button" className="icon-button" disabled={busy || pending} onClick={() => insertMarkdown("\n```\n", "\n```\n", "代码")} aria-label="插入代码块" title="代码块"><Code size={17} /></button><button type="button" className="icon-button" disabled={busy || pending} onClick={() => insertMarkdown("[", "]()", "链接文字")} aria-label="插入链接" title="链接"><LinkIcon size={16} /></button><button type="button" className="icon-button" disabled={busy || pending} onClick={() => insertMarkdown("![", "]()", "图片说明")} aria-label="插入图片外链" title="图片外链"><ImageIcon size={16} /></button></div>}</div>
        {editorMode === "write" ? <><label className="sr-only" htmlFor="forum-topic-body">文章正文</label><textarea id="forum-topic-body" ref={articleEditor} value={draft.body} maxLength={MAX_ARTICLE_CHARACTERS} disabled={busy || pending} placeholder="从这里开始，慢慢展开你的想法…\n\n可以使用标题、列表、引用、代码块和表格。" onChange={event => setDraft(current => ({ ...current, body: event.target.value }))} aria-describedby="forum-topic-size" /></> : <div className="article-editor-preview">{draft.body.trim() ? <ArticleMarkdown body={draft.body} /> : <p className="forum-capacity-note">写下正文后，在这里预览排版。</p>}</div>}
        <div className="draft-meta"><span>{draftSaved ? "草稿已保存在此设备" : "本地草稿"}</span><span id="forum-topic-size" className={topicBytes > MAX_ARTICLE_BYTES ? "limit-reached" : ""}>{draft.body.length.toLocaleString()} / {MAX_ARTICLE_CHARACTERS.toLocaleString()} 字 · {(topicBytes / 1_000).toFixed(1)} / {MAX_ARTICLE_BYTES / 1_000} KB</span></div>
        <details className="article-markdown-help"><summary>Markdown 格式说明</summary><div><p><code>## 小标题</code> · <code>**加粗**</code> · <code>*斜体*</code> · <code>~~删除线~~</code></p><p><code>- 列表项</code> · <code>1. 有序列表</code> · <code>&gt; 引用</code> · <code>- [ ] 待办</code></p><p><code>[链接文字](地址)</code> · <code>![图片说明](HTTPS 图片地址)</code></p><p>代码块使用三枚反引号包围，支持表格与脚注。编辑后切换“预览”查看排版；图片使用外链，正文不会保存图片文件。</p></div></details>
        {topicBytes > MAX_ARTICLE_BYTES && <p className="field-error" role="alert">正文超出当前容量，请精简后发布。</p>}
        <div className="forum-composer-footer"><p><LockKeyhole size={13} />发布后形成固定版本。</p><button type="submit" className="button button-primary" disabled={busy || pending || !connection || !draft.title.trim() || !draft.body.trim() || topicBytes > MAX_ARTICLE_BYTES}>{busy ? <LoaderCircle className="spin" size={16} /> : <Feather size={16} />}{publishText}</button></div>
        <details className="forum-publish-details"><summary>正文与链上凭证</summary><p>正文保存在网站数据库，作者签名、标题、摘要和内容指纹写入 Solana 开发网。阅读时会核对内容指纹。钱包可能显示一笔发给自己的 0 SOL 记录，用于社区发现，只支付网络费用。</p></details>
      </form>
    </ForumModal>

    <ForumModal open={helpOpen} onClose={() => setHelpOpen(false)} title="让想法变成讨论">
      <ol className="help-steps"><li><span>01</span><div><h3>慢慢读，认真聊</h3><p>文章公开浏览，无需登录。阅读完整文章，在文末参与讨论，也可以分享文章链接。</p></div></li><li><span>02</span><div><h3>用自己的钱包创作</h3><p>连接 MetaMask 桌面扩展或兼容开发网的 Solana 钱包。支持 Markdown 长文、排版预览和本地草稿。领取开发网 SOL 后签名发布。</p><a href="https://faucet.solana.com/" target="_blank" rel="noopener noreferrer">官方开发网水龙头<ExternalLink size={13} /></a></div></li><li><span>03</span><div><h3>讨论，也支持创作者</h3><p>回复直接写入链上。点击“打赏作者”，选择开发网 SOL 金额，在钱包中确认。打赏直接到作者钱包，平台不抽成。</p></div></li></ol>
      <div className="help-facts"><p>文章正文存入网站数据库，作者签名、标题、摘要及 SHA-256 内容指纹写入链上。阅读时会核对指纹。正文上限为 20 万字、500 KB；回复上限为 800 字节，包含讨论关联。已发布内容为固定版本。</p><p>发文和回复会附带发给自己的一笔 0 SOL 记录，用于社区发现和讨论关联。打赏则是真实的开发网 SOL 转账，会显示收款作者、金额和网络，网络费另计；开发网 SOL 不具有实际货币价值。</p><p>发布或支付的凭证会在发送前保存。等待或断网后，继续确认同一笔交易；长文链上确认后还会保存正文，存储失败可继续完成发布，不必再次签名。</p><p>开发网可能重置，节点可能无法提供旧历史，请保留重要内容的原稿。</p></div>
      <button type="button" className="button button-primary full-width" onClick={() => { setHelpOpen(false); navigate({ kind: "community" }); }}>进入社区</button>
    </ForumModal>
  </div>;
}
