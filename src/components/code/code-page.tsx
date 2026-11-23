import { useEffect, useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconDots,
  IconFolderPlus,
  IconListCheck,
  IconPlus,
  IconRefresh,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText, isTauri } from "@/api";
import { PageHeader, PageTitle } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { addProject, newSession, recheckCli, removeProject, startAgent, useAgent } from "@/agent/store";
import type { AgentProject, AgentSession } from "@/agent/types";
import { Conversation } from "./conversation";

/** A session's state at a glance: waiting for you, working, or nothing. */
function SessionDot({ s }: { s: AgentSession }) {
  if (s.waiting > 0) return <span className="size-2 shrink-0 rounded-full bg-star" title="Waiting for you" />;
  if (s.running) return <Spinner className="size-3 shrink-0 text-muted-foreground" />;
  return null;
}

function SessionRow({ s, selected, onOpen }: { s: AgentSession; selected: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-tint-active" : "hover:bg-tint-hover",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", !s.title && "text-muted-foreground")}>{s.title || "New session"}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {s.plan && <IconListCheck className="size-3" />}
          {s.waiting > 0 ? "Waiting for you" : s.running ? "Working" : relativeTime(s.updatedAt)}
        </span>
      </span>
      <SessionDot s={s} />
    </button>
  );
}

function ProjectGroup({ project, sessions, selectedId, onOpen, onNew }: {
  project: AgentProject;
  sessions: AgentSession[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <section className="mb-3">
      <div className="group flex items-center gap-1 px-2.5 pt-1 pb-1">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-muted-foreground" title={project.path}>
          {project.name}
        </h3>
        <Button variant="ghost" size="icon-2xs" onClick={onNew} title={`New session in ${project.name}`}>
          <IconPlus />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-2xs" title="Project">
              <IconDots />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                removeProject(project.id)
                  .then(() => toast("Project removed from Relay", { description: "The folder and its files weren't touched." }))
                  .catch((e) => toast.error(errorText(e)))
              }
            >
              <IconTrash />
              Remove from Relay
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {sessions.length === 0 ? (
        <button type="button" onClick={onNew} className="w-full px-2.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
          Start a session
        </button>
      ) : (
        sessions.map((s) => <SessionRow key={s.id} s={s} selected={s.id === selectedId} onOpen={() => onOpen(s.id)} />)
      )}
    </section>
  );
}

/** Shown when the Claude Code CLI can't be found. */
function Setup({ error }: { error: string | null }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <IconTerminal2 className="mx-auto mb-3 size-8 text-muted-foreground" />
        <h2 className="mb-1 text-base font-semibold">Claude Code isn't set up</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {error ?? "Relay runs the Claude Code installed on this PC, with your own sign-in."} Install it, open a terminal,
          run <code className="rounded bg-muted px-1 font-mono text-xs">claude</code> once to sign in, then check again.
        </p>
        <Button
          variant="outline"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            recheckCli().finally(() => setChecking(false));
          }}
        >
          {checking ? <Spinner /> : <IconRefresh />}
          Check again
        </Button>
      </div>
    </div>
  );
}

export function CodePage() {
  const agent = useAgent();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(startAgent, []);

  const byProject = useMemo(() => {
    const m = new Map<string, AgentSession[]>();
    for (const s of agent.sessions) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [agent.sessions]);

  // Opens the most recent session the first time the page has something to show.
  useEffect(() => {
    if (selectedId === null && agent.sessions.length) setSelectedId(agent.sessions[0].id);
  }, [agent.sessions, selectedId]);

  const selected = agent.sessions.find((s) => s.id === selectedId) ?? null;
  const project = selected ? agent.projects.find((p) => p.id === selected.projectId) : undefined;

  const start = async (projectId: string) => {
    try {
      // A new session starts in the mode the last one used.
      const last = agent.sessions[0];
      const s = await newSession(projectId, last?.mode ?? "supervised", false);
      setSelectedId(s.id);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const add = async () => {
    const path = await api.pickFolder("Choose a project folder for Claude");
    if (!path) return;
    try {
      const p = await addProject(path);
      await start(p.id);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  if (!agent.loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader etched className="gap-2">
        <PageTitle>Code</PageTitle>
        {!isTauri && <Badge variant="outline">Sample data</Badge>}
        {agent.cli?.version && (
          <span className="ml-auto truncate text-xs text-muted-foreground" title={agent.cli.path ?? undefined}>
            Claude Code {agent.cli.version.replace(/\s*\(Claude Code\)/, "")}
          </span>
        )}
      </PageHeader>
      {agent.error && (
        <p className="flex items-center gap-2 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <IconAlertTriangle className="size-4" />
          {agent.error}
        </p>
      )}
      {agent.cli && !agent.cli.found ? (
        <Setup error={agent.cli.error} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-1/5 min-w-56 shrink-0 flex-col border-r">
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
              {agent.projects.length === 0 && (
                <p className="px-2.5 py-2 text-xs text-muted-foreground">
                  Add a project folder to start. Claude works inside it.
                </p>
              )}
              {agent.projects.map((p) => (
                <ProjectGroup
                  key={p.id}
                  project={p}
                  sessions={byProject.get(p.id) ?? []}
                  selectedId={selectedId}
                  onOpen={setSelectedId}
                  onNew={() => void start(p.id)}
                />
              ))}
            </div>
            <div className="border-t p-2">
              <Button variant="ghost" size="xs" className="w-full justify-start" onClick={() => void add()}>
                <IconFolderPlus />
                Add project
              </Button>
            </div>
          </aside>
          <section className="min-w-0 flex-1">
            {selected ? (
              <Conversation key={selected.id} session={selected} project={project} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {agent.projects.length ? "Pick a session, or start one with +." : "Add a project to start."}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
