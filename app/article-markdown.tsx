"use client";

import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

function articleUrl(url: string) {
  const safe = defaultUrlTransform(url);
  return /^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(safe) ? safe : "";
}

export default function ArticleMarkdown({ body }: { body: string }) {
  return <div className="article-prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={articleUrl}
    components={{ a: ({ node: _node, href, ...props }) => <a {...props} href={href}
        target={href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" />,
      img: ({ alt, src, title }) => typeof src === "string" && /^https:\/\//i.test(src)
        ? <img src={src} alt={alt ?? ""} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        : typeof src === "string" && src ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "查看图片"}</a> : <span>{alt}</span>,
      table: ({ node: _node, ...props }) => <div className="article-table-wrap"><table {...props} /></div> }}>
    {body}
  </Markdown></div>;
}
