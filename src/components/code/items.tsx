import { useState, type ReactNode } from "react";
import {
  IconAlertTriangle,
  IconBrowser,
  IconCheck,
  IconChevronRight,
  IconFileText,
  IconHelpCircle,
  IconListCheck,
  IconPencil,
  IconPlayerStop,
  IconRobot,
  IconSearch,
  IconTerminal2,
  IconTool,
  IconX,
  type Icon,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { Button } from "@/components/ui/button";
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

/** One entry of the conversation. `running`: the session's turn is still going. */
export function ItemView({ item, running }: { item: AgentItem; running: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap">{item.text}</div>
        </div>
      );
    case "text":
      return item.text ? <Markdown text={item.text} /> : null;
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

/** A frame for cards that need an answer. */
function AskFrame({ icon: I, title, children }: { icon: Icon; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-star/40 bg-star/5 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-star">
        <I className="size-3.5" />
        {title}
      </p>
      {children}
    </div>
  );
}

function ApprovalButtons({ item, allowLabel = "Allow", denyLabel = "Deny", notePlaceholder }: {
  item: AgentToolItem;
  allowLabel?: string;
  denyLabel?: string;
  notePlaceholder: string;
}) {
  const [note, setNote] = useState("");
  const deny = () => answer(item, { allow: false, message: note.trim() || undefined });
  return (
    <div className="mt-2.5 flex items-center gap-2">
      <Button size="xs" onClick={() => answer(item, { allow: true })}>
        <IconCheck />
        {allowLabel}
      </Button>
      <Button size="xs" variant="tinted" onClick={deny}>
        <IconX />
        {denyLabel}
      </Button>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && note.trim() && deny()}
        placeholder={notePlaceholder}
        className="h-7.5 min-w-0 flex-1 text-xs"
      />
    </div>
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

function ToolCard({ item, running }: { item: AgentToolItem; running: boolean }) {
  const pending = item.approval?.state === "pending";
  const [open, setOpen] = useState(false);
  const I = TOOL_ICONS[item.name] ?? IconTool;
  const denied = item.approval && item.approval.state !== "pending" && item.approval.state !== "allowed";
  const working = running && item.output === null && !denied && !pending;
  const expanded = open || pending;

  const card = (
    <div className={cn("rounded-lg border bg-card text-sm", item.isError && "border-destructive/40")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <I className={cn("size-4 shrink-0 text-muted-foreground", item.isError && "text-destructive")} />
        <span className="shrink-0 font-medium">{item.name}</span>
        <span className={cn("min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground", denied && "line-through")}>{item.summary}</span>
        {working && <Spinner className="size-3.5 text-muted-foreground" />}
        <IconChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground/60 transition-transform", expanded && "rotate-90")} />
      </button>
      {expanded && <ToolDetails item={item} />}
    </div>
  );

  if (pending) {
    return (
      <AskFrame icon={IconAlertTriangle} title={`Claude wants to use ${item.name}`}>
        {card}
        <ApprovalButtons item={item} notePlaceholder="Optional: why not, or what to do instead" />
      </AskFrame>
    );
  }
  return (
    <div>
      {card}
      <Outcome item={item} />
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2));

function ToolDetails({ item }: { item: AgentToolItem }) {
  const input = item.input ?? {};
  let body: ReactNode;
  if (item.name === "Edit" && typeof input.old_string === "string") {
    body = (
      <>
        <Pre className="bg-destructive/8 text-destructive/90">{str(input.old_string)}</Pre>
        <Pre className="bg-[color-mix(in_srgb,var(--chip-green)_12%,transparent)]">{str(input.new_string)}</Pre>
      </>
    );
  } else if (item.name === "Write" && typeof input.content === "string") {
    body = <Pre>{input.content}</Pre>;
  } else if (item.name === "Bash") {
    body = <Pre>{`$ ${str(input.command)}`}</Pre>;
  } else if (Object.keys(input).length) {
    body = <Pre>{str(input)}</Pre>;
  }
  return (
    <div className="space-y-1.5 border-t px-2.5 py-2">
      {body}
      {item.output !== null && item.output !== "" && (
        <Pre className={cn(item.isError && "text-destructive")}>{item.output}</Pre>
      )}
    </div>
  );
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre className={cn("max-h-72 overflow-auto rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all", className)}>
      {children}
    </pre>
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
    <AskFrame icon={IconHelpCircle} title="Claude has a question">
      <div className="space-y-3">
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
      <div className="mt-3 flex gap-2">
        <Button size="xs" disabled={!complete} onClick={submit}>
          <IconCheck />
          Answer
        </Button>
        <Button size="xs" variant="tinted" onClick={() => answer(item, { allow: false, message: "The user skipped the question." })}>
          Skip
        </Button>
      </div>
    </AskFrame>
  );
}

/** Claude's plan in plan mode (ExitPlanMode): approve it to let Claude start, or keep planning. */
function PlanCard({ item }: { item: AgentToolItem }) {
  const plan = str(item.input?.plan);
  const pending = item.approval?.state === "pending";
  const body = <Markdown text={plan || "_Claude didn't include the plan's text._"} className="rounded-lg border bg-card px-3 py-2.5" />;
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
    <AskFrame icon={IconListCheck} title="Claude's plan is ready">
      {body}
      <ApprovalButtons item={item} allowLabel="Approve plan" denyLabel="Keep planning" notePlaceholder="Optional: what to change in the plan" />
    </AskFrame>
  );
}
