"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function ForumModal({ open, onClose, title, children, locked = false, wide = false }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; locked?: boolean; wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <dialog ref={dialog} className={`modal${wide ? " forum-modal-wide" : ""}`} aria-labelledby={heading}
    onClose={onClose} onCancel={event => { if (locked) event.preventDefault(); }}
    onClick={event => { if (!locked && event.target === event.currentTarget) onClose(); }}>
    <div className="modal-head"><h2 id={heading}>{title}</h2>
      <button type="button" className="icon-button" disabled={locked} onClick={onClose} aria-label="关闭"><X size={20} /></button>
    </div>{children}
  </dialog>;
}

export function deviceGet(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function deviceSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    return true;
  } catch { return false; }
}

export const shortAddress = (address: string) => `${address.slice(0, 5)}…${address.slice(-5)}`;

export function ForumDate({ timestamp }: { timestamp: number | null }) {
  if (!timestamp) return <span>时间暂缺</span>;
  const date = new Date(timestamp * 1_000);
  return <time dateTime={date.toISOString()}>{new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date)}</time>;
}
