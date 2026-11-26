import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  IconArrowUp,
  IconCheck,
  IconDots,
  IconListCheck,
  IconPencil,
  IconPlayerStopFilled,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { deleteSession, loadItems, setMode, useAgent } from "@/agent/store";
import type { AgentMode, AgentProject, AgentSession } from "@/agent/types";
import { ItemView } from "./items";

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
        <Button variant="ghost" size="xs" className={cn("gap-1 px-2 text-muted-foreground", session.plan && "text-primary")}>
          {session.plan ? <IconListCheck className="size-3.5" /> : <IconShieldCheck className="size-3.5" />}
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

function Composer({ session }: { session: AgentSession }) {
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
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="rounded-2xl border bg-card shadow-xs focus-within:border-field-focus">
        <textarea
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
          className="field-sizing-content max-h-60 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <ModeMenu session={session} />
          <span className="flex-1" />
          {session.running ? (
            <Button size="icon" variant="secondary" className="size-8 rounded-full" onClick={stop} title="Stop">
              <IconPlayerStopFilled className="size-3.5" />
            </Button>
          ) : (
            <Button size="icon" className="size-8 rounded-full" disabled={!text.trim() || sending} onClick={() => void send()} title="Send (Enter)">
              {sending ? <Spinner className="size-4" /> : <IconArrowUp className="size-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Conversation({ session, project }: { session: AgentSession; project: AgentProject | undefined }) {
  const agent = useAgent();
  const items = agent.items[session.id];
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    // Read again from Claude Code's file each time: it may have moved on in the Claude app.
    void loadItems(session.id, !session.live).catch((e) => toast.error(errorText(e)));
    stick.current = true;
  }, [session.id]);

  // Follow new output while you're at the bottom; stay put if you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, session.running]);

  const rename = async (title: string) => {
    setRenaming(false);
    if (title.trim() && title.trim() !== session.title) {
      await api.agent.rename(session.id, title).catch((e) => toast.error(errorText(e)));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 px-4 shadow-[inset_0_-1px_0_var(--border)]">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              defaultValue={session.title}
              onBlur={(e) => void rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename(e.currentTarget.value);
                if (e.key === "Escape") setRenaming(false);
              }}
              className="w-full bg-transparent text-base font-bold outline-none"
            />
          ) : (
            <h2 className="truncate text-base leading-tight font-bold">{session.title || "New session"}</h2>
          )}
          <p className="truncate text-xs text-muted-foreground" title={project?.path}>
            {project?.name ?? "Project removed"}
            {session.model ? ` · ${session.model.replace(/^claude-/, "")}` : ""}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" title="Session">
              <IconDots />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={session.external} onSelect={() => setRenaming(true)}>
              <IconPencil />
              Rename
            </DropdownMenuItem>
            {/* Only from Relay's list: Claude Code's file stays, so the Claude app still has it. One
                not used in Relay yet has nothing to remove. */}
            {!session.external && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => deleteSession(session.id).catch((e) => toast.error(errorText(e)))}
              >
                <IconTrash />
                Remove from Relay
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-5">
          {!items ? (
            <div className="flex justify-center py-10">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Claude works in <span className="font-mono text-xs">{project?.path}</span>.
              <br />
              Tell it what to do.
            </p>
          ) : (
            items.map((it) => <ItemView key={it.id} item={it} running={session.running} />)
          )}
          {session.running && !session.waiting && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
              <Spinner className="size-3.5" />
              Working…
            </p>
          )}
        </div>
      </div>

      {session.fromClaude && !session.live && <FromClaudeNote session={session} />}
      <Composer session={session} />
    </div>
  );
}

/** Above the composer, for a conversation started outside Relay. */
function FromClaudeNote({ session }: { session: AgentSession }) {
  const app = session.origin ?? "Claude app";
  const recent = Date.now() - session.updatedAt < 2 * 60_000;
  return (
    <p className={cn("mx-auto w-full max-w-3xl px-5 pb-2 text-xs", recent ? "text-star" : "text-muted-foreground")}>
      {recent
        ? `This was active in the ${app} in the last 2 minutes. If it's still open there, finish it there first: using it in both at once mixes them up.`
        : session.external
          ? `Started in the ${app}. Sending a message continues it here.`
          : `Started in the ${app}. Anything said in it there shows here as it happens.`}
    </p>
  );
}
