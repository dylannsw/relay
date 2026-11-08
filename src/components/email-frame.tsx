import { useMemo, useRef, useState } from "react";
import { IconPhotoOff } from "@tabler/icons-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "@/api";
import { escapeHtml } from "@/format";

const REMOTE_RE = /(?:src|background|srcset)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

/** Strips things that could navigate or re-base the frame. Scripts can't run anyway (sandbox + CSP). */
function sanitize(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
}

function linkify(escaped: string): string {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"]+/g, (u) => `<a href="${u}">${u}</a>`);
}

function buildDoc(body: string, allowRemote: boolean): string {
  const remote = allowRemote ? " https: http:" : "";
  const csp = [
    "default-src 'none'",
    `img-src data:${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    "script-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join("; ");
  // Emails are designed for a white page, so the frame stays light in dark mode too.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#1a1a1a}
  body{padding:20px 24px;font:14px/1.55 "Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}
  pre.plain{white-space:pre-wrap;font:inherit;margin:0}
  blockquote{margin:0 0 0 6px;padding-left:10px;border-left:2px solid #ccc;color:#555}
</style></head><body>${body}</body></html>`;
}

interface Props {
  html: string | null;
  text: string;
  onMailto: (address: string) => void;
}

export function EmailFrame({ html, text, onMailto }: Props) {
  const [showImages, setShowImages] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  const content = useMemo(
    () => (html ? sanitize(html) : `<pre class="plain">${linkify(escapeHtml(text))}</pre>`),
    [html, text],
  );
  const hasRemote = useMemo(() => REMOTE_RE.test(content), [content]);
  const srcDoc = useMemo(() => buildDoc(content, showImages), [content, showImages]);

  const onMailtoRef = useRef(onMailto);
  onMailtoRef.current = onMailto;

  // Links open in the default browser (mailto: opens Relay's composer) instead of inside the app.
  const onLoad = () => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", (ev) => {
      const a = (ev.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      ev.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (/^mailto:/i.test(href)) onMailtoRef.current(decodeURIComponent(href.slice(7).split("?")[0]));
      else if (/^https?:/i.test(href)) void api.openExternal(href);
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hasRemote && !showImages && (
        <Alert className="rounded-none border-x-0 border-t-0">
          <IconPhotoOff />
          <AlertTitle>Remote images are hidden</AlertTitle>
          <AlertDescription>Senders can use them to tell when you open a message.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => setShowImages(true)}>
              Show images
            </Button>
          </AlertAction>
        </Alert>
      )}
      <iframe
        ref={ref}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        title="Message body"
        // No allow-scripts: nothing in the email can run. allow-same-origin only lets
        // Relay attach the link handler above.
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        onLoad={onLoad}
      />
    </div>
  );
}
