import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/api";
import { cn } from "@/lib/utils";

/**
 * Claude's replies. Raw HTML in the text is shown as text, never rendered (react-markdown's
 * default), and links open in the browser rather than in Relay's window.
 */
const components: Components = {
  p: ({ node: _, ...p }) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
  a: ({ node: _, href, children }) => (
    <a
      href={href}
      className="text-primary underline underline-offset-2 hover:no-underline"
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:/i.test(href)) void api.openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  ul: ({ node: _, ...p }) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
  ol: ({ node: _, ...p }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
  h1: ({ node: _, ...p }) => <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0" {...p} />,
  h2: ({ node: _, ...p }) => <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0" {...p} />,
  h3: ({ node: _, ...p }) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0" {...p} />,
  h4: ({ node: _, ...p }) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0" {...p} />,
  blockquote: ({ node: _, ...p }) => <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...p} />,
  hr: () => <hr className="my-4 border-border" />,
  table: ({ node: _, ...p }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" {...p} />
    </div>
  ),
  th: ({ node: _, ...p }) => <th className="border-b px-2 py-1 text-left font-semibold" {...p} />,
  td: ({ node: _, ...p }) => <td className="border-b border-border/60 px-2 py-1 align-top" {...p} />,
  pre: ({ node: _, ...p }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-muted/70 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0" {...p} />
  ),
  code: ({ node: _, className, ...p }) => (
    <code className={cn("rounded bg-muted/70 px-1 py-0.5 font-mono text-[0.9em]", className)} {...p} />
  ),
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-sm leading-relaxed break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
