"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { applyTheme, parseThemePreference, THEME_STORAGE_KEY, type ThemePreference } from "../lib/theme";

const choices = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] as const;

export default function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>("dark");
  const current = useRef<ThemePreference>("dark");
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let stored: unknown = document.documentElement.dataset.themePreference;
    if (!stored) { try { stored = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* Use the default dark appearance. */ } }
    current.current = parseThemePreference(stored);
    setPreference(current.current);
    applyTheme(current.current, media.matches);

    const onSystemChange = () => {
      if (current.current === "system") applyTheme("system", media.matches);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      current.current = parseThemePreference(event.newValue);
      setPreference(current.current);
      applyTheme(current.current, media.matches);
    };
    const closeOutside = (event: Event) => {
      if (menu.current?.open && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) {
        event.preventDefault();
        menu.current.open = false;
        trigger.current?.focus();
      }
    };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  function select(value: ThemePreference) {
    current.current = value;
    setPreference(value);
    applyTheme(value, window.matchMedia("(prefers-color-scheme: dark)").matches);
    try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* Selection still applies for this visit. */ }
    if (menu.current) menu.current.open = false;
    trigger.current?.focus();
  }

  const selected = choices.find(choice => choice.value === preference)!;
  const Icon = selected.icon;
  return <details className="theme-control" ref={menu}>
    <summary ref={trigger} className="icon-button theme-trigger" title={`外观：${selected.label}`} aria-label={`外观：${selected.label}`}>
      <Icon size={18} strokeWidth={1.7} />
    </summary>
    <div className="theme-menu" role="group" aria-label="选择页面外观">
      <p>外观</p>
      {choices.map(choice => { const ChoiceIcon = choice.icon; return <button key={choice.value} type="button"
        aria-pressed={preference === choice.value} onClick={() => select(choice.value)}>
        <ChoiceIcon size={16} strokeWidth={1.7} /><span>{choice.label}</span>
        {preference === choice.value && <Check size={15} className="theme-check" />}
      </button>; })}
    </div>
  </details>;
}
