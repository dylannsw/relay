import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  IconAlertTriangle,
  IconBrowser,
  IconCheck,
  IconChevronDown,
  IconFileText,
  IconHelpCircle,
  IconListCheck,
  IconPencil,
  IconPlayerStop,
  IconRobot,
  IconSearch,
  IconStack2,
  IconTerminal2,
  IconTool,
  IconX,
  type Icon,
} from "@tabler/icons-react";
import type { ToolUIPart } from "ai";
import type { BundledLanguage } from "shiki";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { AgentAnswer, AgentItem, AgentQuestion, AgentToolItem } from "@/agent/types";
import { Markdown } from "./markdown";

const TOOL_ICONS: Record<string, Icon> = {
  Bash: IconTerminal2,
  Read: IconFileText,
  Write: IconPencil,
  Edit: IconPencil,
  MultiEdit: IconPencil,
  NotebookEdit: IconPencil,
  Grep: IconSearch,
  Glob: IconSearch,
  WebFetch: IconBrowser,
  WebSearch: IconBrowser,
  Agent: IconRobot,
  Task: IconRobot,
};

function answer(item: AgentToolItem, a: AgentAnswer) {
  if (!item.approval) return;
  api.agent.answer(item.sessionId, item.approval.requestId, a).catch((e) => toast.error(errorText(e)));
}

/** The session's project folder, so paths inside it show relative to it. */
const ProjectPath = createContext<string | undefined>(undefined);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with the project folder taken off its paths, in Windows, forward-slash and Git Bash spellings. */
function useShorten() {
  const root = useContext(ProjectPath);
  return useMemo(() => {
    if (!root) return (t: string) => t;
    const win = root.replace(/[\\/]+$/, "");
    const fwd = win.replace(/\\/g, "/");
    const bash = fwd.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    const alts = [...new Set([win, fwd, bash])].map(escapeRe).join("|");
    const inside = new RegExp(`(?:${alts})[\\\\/]`, "gi");
    const itself = new RegExp(`(?:${alts})(?![\\w-])`, "gi");
    return (t: string) => t.replace(inside, "").replace(itself, ".");
  }, [root]);
}

/** `mcp__server__do_thing` → "Do thing"; built-in tools keep their names. */
const toolName = (name: string) => {
  if (!name.startsWith("mcp__")) return name;
  const last = name.split("__").pop() ?? name;
  const words = last.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Tool calls that show on their own, never folded into a group: they ask you something. */
const standsAlone = (it: AgentToolItem) =>
  it.name === "AskUserQuestion" || it.name === "ExitPlanMode" || it.approval?.state === "pending";

type Entry = { kind: "item"; item: AgentItem } | { kind: "group"; id: string; tools: AgentToolItem[] };

/** Runs of two or more tool calls in a row become one group, as in the Claude app. */
function entries(items: AgentItem[]): Entry[] {
  const out: Entry[] = [];
  let run: AgentToolItem[] = [];
  const flush = () => {
    if (run.length === 1) out.push({ kind: "item", item: run[0] });
    else if (run.length > 1) out.push({ kind: "group", id: run[0].id, tools: run });
    run = [];
  };
  for (const it of items) {
    if (it.kind === "tool" && !standsAlone(it)) run.push(it);
    // Empty text between tool calls shows nothing, so it doesn't break a run.
    else if (it.kind === "text" && !it.text.trim()) continue;
    else {
      flush();
      out.push({ kind: "item", item: it });
    }
  }
  flush();
  return out;
}

/** The conversation's entries, with runs of tool calls folded into groups. */
export function ItemList({ items, running, projectPath }: { items: AgentItem[]; running: boolean; projectPath?: string }) {
  const list = useMemo(() => entries(items), [items]);
  return (
    <ProjectPath.Provider value={projectPath}>
      {list.map((e, i) =>
        e.kind === "group" ? (
          // Only the last group can still be working.
          <ToolGroup key={e.id} tools={e.tools} running={running && i === list.length - 1} />
        ) : (
          <ItemView key={e.item.id} item={e.item} running={running} />
        ),
      )}
    </ProjectPath.Provider>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Edited 3 files, ran 5 commands": what a run of tool calls did, by kind. */
function groupSummary(tools: AgentToolItem[]) {
  const files = (names: string[]) =>
    new Set(tools.filter((t) => names.includes(t.name)).map((t) => String(t.input?.file_path ?? t.input?.notebook_path ?? t.id))).size;
  const count = (names: string[]) => tools.filter((t) => names.includes(t.name)).length;
  const known = ["Edit", "MultiEdit", "Write", "NotebookEdit", "Read", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Agent", "Task"];
  const parts = [
    [files(["Edit", "MultiEdit", "Write", "NotebookEdit"]), "edited a file", "edited {} files"],
    [files(["Read"]), "read a file", "read {} files"],
    [count(["Bash"]), "ran a command", "ran {} commands"],
    [count(["Grep", "Glob"]), "searched once", "searched {} times"],
    [count(["WebFetch", "WebSearch"]), "looked something up online", "looked up {} things online"],
    [count(["Agent", "Task"]), "ran an agent", "ran {} agents"],
    [tools.filter((t) => !known.includes(t.name)).length, "used a tool", "used {} tools"],
  ] as const;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => (n === 1 ? one : many.replace("{}", String(n))))
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A run of tool calls as one collapsed row; open it to see each call. */
function ToolGroup({ tools, running }: { tools: AgentToolItem[]; running: boolean }) {
  const shorten = useShorten();
  const working = running && tools.some((t) => t.output === null && t.approval?.state !== "denied");
  const failed = tools.filter((t) => t.isError).length;
  const last = tools[tools.length - 1];
  return (
    <Collapsible className="group/tools">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left text-sm text-muted-foreground hover:text-foreground">
        {working ? <Spinner className="size-4 shrink-0" /> : <IconStack2 className="size-4 shrink-0" />}
        <span className="shrink-0">{groupSummary(tools)}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">· {plural(failed, "failed", "failed")}</span>}
        {/* While it works, what it's doing now. */}
        {working && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs opacity-70">
            {toolName(last.name)} {shorten(last.summary)}
          </span>
        )}
        <IconChevronDown className="ml-auto size-3.5 shrink-0 opacity-60 transition-transform group-data-[state=open]/tools:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 space-y-1.5">
        {tools.map((t) => (
          <ToolCard key={t.id} item={t} running={running} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One entry of the conversation. `running`: the session's turn is still going. */
export function ItemView({ item, running }: { item: AgentItem; running: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        // As wide as a Telegram bubble may be, with room above and below so it stands apart from Claude's replies.
        <Message from="user" className="my-4 max-w-[min(78%,40rem)] first:mt-0">
          <MessageContent className="bubble-in whitespace-pre-wrap">{item.text}</MessageContent>
        </Message>
      );
    case "text":
      return item.text ? (
        <Message from="assistant" className="max-w-full">
          <MessageContent className="w-full">
            <Markdown text={item.text} streaming={item.streaming} />
          </MessageContent>
        </Message>
      ) : null;
    case "tool":
      if (item.name === "AskUserQuestion") return <QuestionCard item={item} />;
      if (item.name === "ExitPlanMode") return <PlanCard item={item} />;
      return <ToolCard item={item} running={running} />;
    case "turnEnd":
      if (item.outcome === "completed") return null;
      return (
        <p className={cn("flex items-start gap-1.5 text-xs", item.outcome === "error" ? "text-destructive" : "text-muted-foreground")}>
          {item.outcome === "error" ? <IconAlertTriangle className="mt-px size-3.5 shrink-0" /> : <IconPlayerStop className="mt-px size-3.5 shrink-0" />}
          <span className="whitespace-pre-wrap">{item.outcome === "stopped" ? "Stopped" : item.detail || "Something went wrong."}</span>
        </p>
      );
    case "notice":
      return (
        <p className={cn("rounded-lg px-3 py-2 text-xs whitespace-pre-wrap", item.error ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
          {item.text}
        </p>
      );
  }
}

/** A request waiting on you, as AI Elements' Confirmation, in the colour that marks things to answer. */
function Ask({ icon: I, title, children, actions }: { icon: Icon; title: string; children: ReactNode; actions: ReactNode }) {
  return (
    <Confirmation
      approval={{ id: "pending" }}
      state="approval-requested"
      className="gap-2.5 rounded-xl border-star/40 bg-star/5 p-3"
    >
      <ConfirmationTitle className="flex items-center gap-1.5 text-xs font-semibold text-star">
        <I className="size-3.5" />
        {title}
      </ConfirmationTitle>
      <ConfirmationRequest>{children}</ConfirmationRequest>
      <ConfirmationActions className="w-full justify-start">{actions}</ConfirmationActions>
    </Confirmation>
  );
}

/** Allow / Deny, with a note for Claude when you deny. */
function useApproval(item: AgentToolItem, allowLabel = "Allow", denyLabel = "Deny", notePlaceholder: string) {
  const [note, setNote] = useState("");
  const deny = () => answer(item, { allow: false, message: note.trim() || undefined });
  return (
    <>
      <ConfirmationAction size="xs" className="" onClick={() => answer(item, { allow: true })}>
        <IconCheck />
        {allowLabel}
      </ConfirmationAction>
      <ConfirmationAction size="xs" className="" variant="tinted" onClick={deny}>
        <IconX />
        {denyLabel}
      </ConfirmationAction>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && note.trim() && deny()}
        placeholder={notePlaceholder}
        className="h-7.5 min-w-0 flex-1 text-xs"
      />
    </>
  );
}

/** What happened to a request once answered. */
function Outcome({ item }: { item: AgentToolItem }) {
  const a = item.approval;
  if (!a || a.state === "pending") return null;
  const text =
    a.state === "allowed" ? null
    : a.state === "cancelled" ? "Expired before an answer"
    : a.requestId ? `You denied this${a.message ? `: ${a.message}` : ""}`
    : a.message || "Not allowed in this mode";
  if (!text) return null;
  return <p className="mt-1 text-xs text-muted-foreground">{text}</p>;
}

/** Our tool call in the AI SDK's terms, for AI Elements' Tool. */
function toolState(item: AgentToolItem, running: boolean): ToolUIPart["state"] {
  const a = item.approval;
  if (a?.state === "pending") return "approval-requested";
  if (a && a.state !== "allowed") return "output-denied";
  if (item.isError) return "output-error";
  if (item.output === null && running) return "input-available";
  return "output-available";
}

function ToolCard({ item, running }: { item: AgentToolItem; running: boolean }) {
  const pending = item.approval?.state === "pending";
  const state = toolState(item, running);
  const I = TOOL_ICONS[item.name] ?? IconTool;
  const shorten = useShorten();
  const working = state === "input-available";
  const approvalButtons = useApproval(item, undefined, undefined, "Optional: why not, or what to do instead");

  const tool = (
    <Tool defaultOpen={pending} className={cn("mb-0 rounded-lg bg-card", item.isError && "border-destructive/40")}>
      <ToolHeader
        type={`tool-${item.name}`}
        title={toolName(item.name)}
        state={state}
        summary={shorten(item.summary)}
        // Only the states worth a word; a spinner says it's running, and done needs no badge.
        hideBadge={state !== "output-error"}
        icon={
          working ? (
            <Spinner className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <I className={cn("size-4 shrink-0 text-muted-foreground", item.isError && "text-destructive")} />
          )
        }
      />
      <ToolContent className="border-t">
        <ToolDetails item={item} />
      </ToolContent>
    </Tool>
  );

  if (pending) {
    return (
      <Ask icon={IconAlertTriangle} title={`Claude wants to use ${item.name}`} actions={approvalButtons}>
        {tool}
      </Ask>
    );
  }
  return (
    <div>
      {tool}
      <Outcome item={item} />
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2));

const EXT_LANG: Record<string, BundledLanguage> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", json: "json", css: "css", html: "html", md: "md",
  rs: "rust", py: "python", toml: "toml", yaml: "yaml", yml: "yaml", sh: "bash", ps1: "powershell", swift: "swift",
};
const langOf = (path: unknown): BundledLanguage | "text" =>
  (typeof path === "string" && EXT_LANG[path.split(".").pop()?.toLowerCase() ?? ""]) || "text";

const asDiff = (before: string, after: string) =>
  [...before.split("\n").map((l) => `- ${l}`), ...after.split("\n").map((l) => `+ ${l}`)].join("\n");

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 px-2.5 pt-2">
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h4>
      {children}
    </div>
  );
}

function ToolDetails({ item }: { item: AgentToolItem }) {
  const input = item.input ?? {};
  let body: ReactNode;
  if (item.name === "Edit" && typeof input.old_string === "string") {
    body = (
      <Section label="Change">
        <CodeBlock code={asDiff(input.old_string, str(input.new_string))} language="diff" />
      </Section>
    );
  } else if (item.name === "Write" && typeof input.content === "string") {
    body = (
      <Section label="Content">
        <CodeBlock code={input.content} language={langOf(input.file_path)} />
      </Section>
    );
  } else if (item.name === "Bash") {
    body = (
      <Section label="Command">
        <CodeBlock code={str(input.command)} language="bash" />
      </Section>
    );
  } else if (Object.keys(input).length) {
    body = <ToolInput input={input} className="px-2.5 pt-2 pb-0" />;
  }
  return (
    <div className="pb-2.5">
      {body}
      {item.output !== null && item.output !== "" && (
        <ToolOutput
          output={item.isError ? undefined : item.output}
          errorText={item.isError ? item.output : undefined}
          language="text"
          className="px-2.5 pt-2 pb-0"
        />
      )}
    </div>
  );
}

/** Claude asking you something (AskUserQuestion): pick an option per question, or type your own. */
function QuestionCard({ item }: { item: AgentToolItem }) {
  const questions = ((item.input?.questions as AgentQuestion[] | undefined) ?? []).filter((q) => q?.question);
  const pending = item.approval?.state === "pending";
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  if (!pending) {
    const answers = item.approval?.answers;
    return (
      <div className="rounded-lg border bg-card px-3 py-2 text-sm">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <IconHelpCircle className="size-3.5" />
          Claude asked
        </p>
        {questions.map((q) => (
          <p key={q.question} className="mt-1">
            {q.question} <span className="font-semibold">{answers?.[q.question] ?? "(no answer)"}</span>
          </p>
        ))}
        <Outcome item={item} />
      </div>
    );
  }

  const answerFor = (q: AgentQuestion) => other[q.question]?.trim() || (picked[q.question] ?? []).join(", ");
  const complete = questions.every((q) => answerFor(q));
  const toggle = (q: AgentQuestion, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  const submit = () =>
    answer(item, { allow: true, answers: Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])) });

  return (
    <Ask
      icon={IconHelpCircle}
      title="Claude has a question"
      actions={
        <>
          <ConfirmationAction size="xs" className="" disabled={!complete} onClick={submit}>
            <IconCheck />
            Answer
          </ConfirmationAction>
          <ConfirmationAction
            size="xs"
            className=""
            variant="tinted"
            onClick={() => answer(item, { allow: false, message: "The user skipped the question." })}
          >
            Skip
          </ConfirmationAction>
        </>
      }
    >
      <div className="space-y-3 text-foreground">
        {questions.map((q) => (
          <div key={q.question}>
            <p className="mb-1.5 text-sm font-medium">{q.question}</p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => {
                const on = (picked[q.question] ?? []).includes(o.label) && !other[q.question]?.trim();
                return (
                  <button
                    key={o.label}
                    type="button"
                    title={o.description}
                    onClick={() => toggle(q, o.label)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors",
                      on ? "border-primary bg-primary/10" : "bg-card hover:bg-muted",
                    )}
                  >
                    <span className="font-medium">{o.label}</span>
                    {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                  </button>
                );
              })}
            </div>
            <Input
              value={other[q.question] ?? ""}
              onChange={(e) => setOther((p) => ({ ...p, [q.question]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && complete && submit()}
              placeholder="Or type your own answer"
              className="mt-1.5 h-7.5 text-xs"
            />
          </div>
        ))}
      </div>
    </Ask>
  );
}

/** Claude's plan in plan mode (ExitPlanMode): approve it to let Claude start, or keep planning. */
function PlanCard({ item }: { item: AgentToolItem }) {
  const plan = str(item.input?.plan);
  const pending = item.approval?.state === "pending";
  const approvalButtons = useApproval(item, "Approve plan", "Keep planning", "Optional: what to change in the plan");
  const body = <Markdown text={plan || "_Claude didn't include the plan's text._"} className="rounded-lg border bg-card px-3 py-2.5 text-foreground" />;
  if (!pending) {
    return (
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <IconListCheck className="size-3.5" />
          {item.approval?.state === "allowed" ? "Plan approved" : "Plan"}
        </p>
        {body}
        <Outcome item={item} />
      </div>
    );
  }
  return (
    <Ask icon={IconListCheck} title="Claude's plan is ready" actions={approvalButtons}>
      {body}
    </Ask>
  );
}
