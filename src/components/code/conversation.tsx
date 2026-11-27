import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  IconCheck,
  IconDots,
  IconListCheck,
  IconPencil,
  IconPlayerStopFilled,
  IconShieldCheck,
  IconArchive,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { ComposerField, ComposerOptions, ComposerSubmit, ComposerTray } from "@/components/composer-tray";
import { PageHeader, PageTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CHAT_WIDTHS, useChatWidth } from "@/telegram/chat-width";
import { useChatZoom, useChatZoomKeys } from "@/telegram/zoom";
import { deleteSession, loadItems, setMode, useAgent } from "@/agent/store";
import type { AgentMode, AgentProject, AgentSession } from "@/agent/types";
import { ItemList } from "./items";
import {
  Conversation as AiConversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";

export const MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: "supervised", label: "Supervised", hint: "Asks before commands and file edits" },
  { id: "acceptEdits", label: "Auto-accept edits", hint: "Edits files; asks before commands" },
  { id: "fullAccess", label: "Full access", hint: "Never asks" },
];

export const modeLabel = (s: Pick<AgentSession, "mode" | "plan">) =>
  s.plan ? "Plan" : (MODES.find((m) => m.id === s.mode)?.label ?? s.mode);

/** The mode button and its menu, under the composer. */
function ModeMenu({ session }: { session: AgentSession }) {
  const change = (mode: AgentMode, plan: boolean) => setMode(session.id, mode, plan).catch((e) => toast.error(errorText(e)));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Styled as the chat's Attach button, in its place. */}
        <Button type="button" variant="outline" size="sm" className={cn("text-muted-foreground", session.plan && "text-primary")}>
          {session.plan ? <IconListCheck /> : <IconShieldCheck />}
          {modeLabel(session)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Permissions</DropdownMenuLabel>
        {MODES.map((m) => (
          <DropdownMenuItem key={m.id} onSelect={() => change(m.id, session.plan)} className="items-start">
            <IconCheck className={cn("mt-0.5", m.id !== session.mode && "invisible")} />
            <span>
              {m.label}
              <span className="block text-xs text-muted-foreground">{m.hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => change(session.mode, !session.plan)} className="items-start">
          <IconCheck className={cn("mt-0.5", !session.plan && "invisible")} />
          <span>
            Plan mode
            <span className="block text-xs text-muted-foreground">Claude reads and plans; you approve before it changes anything</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The chat's writing box, for a session: the same tray, field and send button, floating over the
 * conversation's end at the same width. Permissions sit where the chat has Attach and Stickers, and
 * the send button stops Claude while it works.
 */
function Composer({ session, boxRef }: { session: AgentSession; boxRef: React.Ref<HTMLDivElement> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), [session.id]);

  const send = async () => {
    const t = text.trim();
    if (!t || session.running || sending) return;
    setSending(true);
    try {
      await api.agent.send(session.id, t);
      setText("");
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSending(false);
    }
  };
  const stop = () => api.agent.stop(session.id).catch((e) => toast.error(errorText(e)));

  return (
    // As in a chat: 8px wider each side than the messages, and no wider than Settings > Chats allows.
    // Behind its lower half the page shows, so nothing peeks out below it.
    <div ref={boxRef} className="absolute inset-x-0 bottom-0 px-2 pb-3 @3xl/chat:px-[max(92px,calc((100cqw_-_var(--chat-max))/2_-_8px))]">
      <div aria-hidden className="absolute inset-x-0 top-1/2 bottom-0 bg-background" />
      <ComposerTray>
        <ComposerField>
          <InputGroupTextarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={session.waiting ? "Answer Claude above to continue" : session.title ? "Reply to Claude" : "What should Claude do?"}
            aria-label="Message to Claude"
            // The chat box's type and padding.
            className="no-scrollbar max-h-50 min-h-[calc(1.4em+16px)] pt-3 pr-4 pb-1 pl-[18px] text-title leading-[1.4] md:text-title"
          />
          {session.running ? (
            <ComposerSubmit ready label="Stop" icon={<IconPlayerStopFilled />} onClick={stop} />
          ) : (
            <ComposerSubmit ready={!!text.trim()} busy={sending} label="Send" onClick={() => void send()} />
          )}
        </ComposerField>
        <ComposerOptions>
          <ModeMenu session={session} />
        </ComposerOptions>
      </ComposerTray>
    </div>
  );
}

export function Conversation({ session, project }: { session: AgentSession; project: AgentProject | undefined }) {
  const agent = useAgent();
  const items = agent.items[session.id];
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    // Read again from Claude Code's file each time: it may have moved on in the Claude app.
    void loadItems(session.id, !session.live).catch((e) => toast.error(errorText(e)));
  }, [session.id]);

  // The floating composer's height, which the conversation leaves room for at its end.
  const chatWidth = useChatWidth();
  const zoom = useChatZoom();
  useChatZoomKeys();
  const composerBox = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(0);
  useLayoutEffect(() => {
    const el = composerBox.current;
    if (!el) return;
    const measure = () => setComposerH(el.offsetHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const rename = async (title: string) => {
    setRenaming(false);
    if (title.trim() && title.trim() !== session.title) {
      await api.agent.rename(session.id, title).catch((e) => toast.error(errorText(e)));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* The session, then its project in the lighter grey the calendar gives the year. */}
      <PageHeader etched className="gap-2">
        {renaming ? (
          <input
            autoFocus
            defaultValue={session.title}
            onBlur={(e) => void rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename(e.currentTarget.value);
              if (e.key === "Escape") setRenaming(false);
            }}
            aria-label="Session name"
            className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none"
          />
        ) : (
          <PageTitle>
            {session.title || "New session"}{" "}
            <span className="font-normal text-muted-foreground" title={project?.path}>
              – {project?.name ?? "Project removed"}
            </span>
          </PageTitle>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" title="Session">
              <IconDots />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <IconPencil />
              Rename
            </DropdownMenuItem>
            {/* Only from Relay's list: Claude Code's file stays, so the Claude app still has it. */}
            <DropdownMenuItem onSelect={() => deleteSession(session.id).catch((e) => toast.error(errorText(e)))}>
              <IconArchive />
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      {/* Laid out as a chat: as wide as Settings > Chats allows, centred past that. */}
      <div className="@container/chat relative min-h-0 flex-1" style={{ "--chat-max": `${CHAT_WIDTHS[chatWidth].px}px` } as CSSProperties}>
      {/* AI Elements' Conversation: follows new output while you're at the bottom, stays put if
          you've scrolled up to read. Keyed by session so each opens at its end. */}
      <AiConversation key={session.id} initial="instant" className="absolute inset-0">
        <ConversationContent
          scrollClassName="no-scrollbar overscroll-contain"
          // Room at the end for the composer floating over it.
          style={{ paddingBottom: composerH + 20 }}
          className="px-4 pt-5 @3xl/chat:px-[max(100px,calc((100cqw_-_var(--chat-max))/2))]"
        >
          {/* Ctrl+= / Ctrl+- zoom what's said, as in a Telegram chat (the same zoom); the
              column's width and the composer stay as they are. */}
          <div className="flex flex-col gap-3" style={zoom === 1 ? undefined : { zoom }}>
          {!items ? (
            <div className="flex justify-center py-10">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <ConversationEmptyState className="py-16">
              <p className="text-sm text-muted-foreground">
                Claude works in <span className="font-mono text-xs">{project?.path}</span>.
                <br />
                Tell it what to do.
              </p>
            </ConversationEmptyState>
          ) : (
            <ItemList items={items} running={session.running} projectPath={project?.path} />
          )}
          {session.running && !session.waiting && (
            <p className="flex items-center gap-2 text-xs" aria-live="polite">
              <Spinner className="size-3.5 text-muted-foreground" />
              <Shimmer className="text-xs">Working…</Shimmer>
            </p>
          )}
          </div>
        </ConversationContent>
        <ConversationScrollButton style={{ bottom: composerH + 12 }} title="Jump to the latest" />
      </AiConversation>

      <Composer session={session} boxRef={composerBox} />
      </div>
    </div>
  );
}
