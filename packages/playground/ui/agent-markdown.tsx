import { memo, type ReactNode, useRef, useState } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { Button } from "./components";
import { code } from "./markdown-code";
import "./agent-rich.css";

function CodeBlock({ children }: { children?: ReactNode } | Record<string, unknown>) {
  const element = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState("Copy");
  return (
    <div className="agent-code">
      <Button
        aria-label="Copy code"
        onClick={() =>
          void navigator.clipboard.writeText(element.current?.textContent ?? "").then(
            () => setCopied("Copied"),
            () => setCopied("Copy failed"),
          )
        }
      >
        {copied}
      </Button>
      <pre ref={element}>{children as ReactNode}</pre>
    </div>
  );
}
export default memo(function AgentMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown
      className="agent-markdown"
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      rehypePlugins={[defaultRehypePlugins.sanitize!, defaultRehypePlugins.harden!]}
      skipHtml
      controls={false}
      plugins={{ code }}
      components={{
        pre: CodeBlock,
        strong: "strong",
        em: "em",
        a: ({ href, children }) =>
          /^https?:\/\//iu.test(href ?? "") ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
        img: ({ alt }) => <span className="muted">[Image: {alt || "attachment"}]</span>,
      }}
    >
      {text}
    </Streamdown>
  );
});
