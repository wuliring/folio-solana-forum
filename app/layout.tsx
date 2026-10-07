import type { Metadata } from "next";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "FOLIO · Solana 链上论坛",
  description: "分享值得阅读的长文，用 Solana 钱包签名、参与讨论与打赏作者。文章正文配有链上内容指纹，当前使用开发网。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <meta id="folio-theme-color" name="theme-color" content="#1b1b1d" suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
