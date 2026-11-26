// The sidebar in Code mode: projects with their sessions, in place of Relay's pages and accounts.
// The Code page beside it shows the conversation picked here.

import { useMemo } from "react";
import { IconDots, IconFolderPlus, IconListCheck, IconPlus, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { addProject, newSession, removeProject, selectSession, useAgent } from "@/agent/store";
import type { AgentProject, AgentSession } from "@/agent/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";

/** A session's state at a glance: waiting for you, working, or nothing. */
function SessionDot({ s }: { s: AgentSession }) {
  if (s.waiting > 0) return <span className="size-2 shrink-0 rounded-full bg-star" title="Waiting for you" />;
  if (s.running) return <Spinner className="size-3 shrink-0 text-muted-foreground" />;
  return null;
}

function SessionItem({ s, selected }: { s: AgentSession; selected: boolean }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" isActive={selected} onClick={() => selectSession(s.id)} className="h-auto py-1.5">
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", !s.title && "text-muted-foreground")}>{s.title || "New session"}</span>
          <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
            {s.plan && <IconListCheck className="size-3!" />}
            {s.waiting > 0 ? "Waiting for you" : s.running ? "Working" : relativeTime(s.updatedAt)}
            {s.fromClaude && !s.running && !s.waiting && <span className="truncate">· {s.origin ?? "Claude app"}</span>}
          </span>
        </span>
        <SessionDot s={s} />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Starts a session in `projectId`, in the mode the last one used. */
async function start(projectId: string, sessions: AgentSession[]) {
  try {
    await newSession(projectId, sessions[0]?.mode ?? "supervised", false);
  } catch (e) {
    toast.error(errorText(e));
  }
}

function ProjectGroup({ project, sessions, all, selectedId }: {
  project: AgentProject;
  sessions: AgentSession[];
  all: AgentSession[];
  selectedId: string | null;
}) {
  return (
    <SidebarGroup className="px-1.5">
      <div className="group/project flex items-center gap-1 pr-1">
        <SidebarGroupLabel className="min-w-0 flex-1" title={project.path}>
          <span className="truncate">{project.name}</span>
        </SidebarGroupLabel>
        <Button variant="ghost" size="icon-2xs" onClick={() => void start(project.id, all)} title={`New session in ${project.name}`}>
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
      <SidebarGroupContent>
        <SidebarMenu>
          {sessions.length === 0 ? (
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" onClick={() => void start(project.id, all)} className="text-muted-foreground">
                <span>Start a session</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : (
            sessions.map((s) => <SessionItem key={s.id} s={s} selected={s.id === selectedId} />)
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Projects and their sessions, most recent first, then Add project. */
export function CodeSidebarItems() {
  const agent = useAgent();
  const byProject = useMemo(() => {
    const m = new Map<string, AgentSession[]>();
    for (const s of agent.sessions) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [agent.sessions]);

  const add = async () => {
    const path = await api.pickFolder("Choose a project folder for Claude");
    if (!path) return;
    try {
      const p = await addProject(path);
      await start(p.id, agent.sessions);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <>
      {agent.loaded && agent.projects.length === 0 && (
        <p className="px-3.5 py-2 text-xs text-muted-foreground">Add a project folder to start. Claude works inside it.</p>
      )}
      {agent.projects.map((p) => (
        <ProjectGroup key={p.id} project={p} sessions={byProject.get(p.id) ?? []} all={agent.sessions} selectedId={agent.selectedId} />
      ))}
      <SidebarGroup className="px-1.5">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => void add()} className="text-muted-foreground">
              <IconFolderPlus />
              <span>Add Project</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
