import { code } from "@streamdown/code";
import { defaultRehypePlugins, type Components } from "streamdown";
import { api } from "@/api";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

/**
 * Claude's replies, through AI Elements' Response (Streamdown). Raw HTML in the text is shown as
 * text, never rendered (Streamdown's `raw` step is left out), and links open in the browser rather
 * than in Relay's window.
 */
const rehypePlugins = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== "raw")
  .map(([, plugin]) => plugin);

const plugins = { code };

const components: Components = {
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
};

export function Markdown({ text, streaming = false, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <MessageResponse
      // Headings stay close to body size, as they were before: a reply isn't a document.
      className={cn(
        "text-sm leading-relaxed break-words [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:text-sm [&_h4]:font-semibold",
        className,
      )}
      rehypePlugins={rehypePlugins}
      plugins={plugins}
      components={components}
      linkSafety={{ enabled: false }}
      isAnimating={streaming}
    >
      {text}
    </MessageResponse>
  );
}
