// The sidebar in Code mode: projects with their sessions, in place of Relay's pages and accounts.
// The Code page beside it shows the conversation picked here.

import { useMemo, useState } from "react";
import { IconArchive, IconFolder, IconFolderOpen, IconPencil, IconPlus, IconSquareRoundedPlus, IconTrash } from "@tabler/icons-react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { errorText } from "@/api";
import { deleteSession, newSession, renameSession, selectSession, useAgent } from "@/agent/store";
import type { AgentProject, AgentSession } from "@/agent/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { RowChevron } from "@/components/sidebar-row";
import { ease } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** What's waiting for you to confirm deleting: one session, or every session in a project. */
type Deleting = { sessions: AgentSession[]; project?: AgentProject } | null;

/** A session's state at a glance: waiting for you, working, or nothing. */
function SessionDot({ s }: { s: AgentSession }) {
  if (s.waiting > 0) return <span role="img" aria-label="Waiting for you" className="size-2 shrink-0 rounded-full bg-star" title="Waiting for you" />;
  if (s.running) return <Spinner aria-label="Working" className="size-3 shrink-0 text-muted-foreground" />;
  return null;
}

/** Archives sessions: gone from Relay, kept in Claude Code's files for the Claude app. */
async function archive(sessions: AgentSession[]) {
  try {
    for (const s of sessions) await deleteSession(s.id);
    toast(sessions.length === 1 ? "Session archived" : `${sessions.length} sessions archived`, {
      description: "Still in the Claude app.",
    });
  } catch (e) {
    toast.error(errorText(e));
  }
}

/** A session under its project, inside a <FoldRow>. Right-click to rename, archive or delete it; renaming edits it in place. */
function SessionItem({ s, selected, onDelete }: { s: AgentSession; selected: boolean; onDelete: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const finish = (title: string) => {
    setRenaming(false);
    renameSession(s.id, title).catch((e) => toast.error(errorText(e)));
  };

  return (
    <>
      {renaming ? (
        // Same box as the row, so the name stays where it was while you edit it.
        <SidebarMenuSubButton asChild isActive={selected}>
          <div>
            <input
              autoFocus
              defaultValue={s.title}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => finish(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(false);
              }}
              aria-label="Session name"
              className="min-w-0 flex-1 bg-transparent outline-none"
            />
          </div>
        </SidebarMenuSubButton>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <SidebarMenuSubButton asChild isActive={selected}>
              <button type="button" className="w-full" onClick={() => selectSession(s.id)}>
                <span className={cn("min-w-0 flex-1 truncate", !s.title && "text-muted-foreground")}>{s.title || "New session"}</span>
                <SessionDot s={s} />
              </button>
            </SidebarMenuSubButton>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuItem onSelect={() => setRenaming(true)}>
              <IconPencil />
              Rename
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void archive([s])}>
              <IconArchive />
              Archive
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              <IconTrash />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
    </>
  );
}

/**
 * The project's folder, closed or open: the two cross-fade, the leaving one shrinking a little and
 * blurring as the arriving one settles in, so it reads as the folder opening rather than a swap.
 */
function FolderIcon({ open }: { open: boolean }) {
  const gone = "scale-75 opacity-0 blur-[1.5px]";
  return (
    <span
      aria-hidden
      className="grid size-4.5 shrink-0 place-items-center *:col-start-1 *:row-start-1 *:transition-[opacity,scale,filter] *:duration-200 *:ease-(--ease-out-soft) motion-reduce:*:transition-none"
    >
      <IconFolder className={cn(open && gone)} />
      <IconFolderOpen className={cn(!open && gone)} />
    </span>
  );
}

/**
 * A row under a project that folds away on its own: its height closes (260ms; opens in 220ms) while
 * its content dissolves faster, fading, blurring and drifting up, as the sidebar's other folds do.
 */
function FoldRow({ children }: { children: React.ReactNode }) {
  const gone = { height: 0, opacity: 0, filter: "blur(4px)", y: -6 };
  return (
    <motion.li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className="group/menu-sub-item relative overflow-hidden"
      initial={gone}
      animate={{ height: "auto", opacity: 1, filter: "blur(0px)", y: 0, transition: { duration: 0.22, ease } }}
      exit={{
        ...gone,
        transition: { height: { duration: 0.26, ease }, default: { duration: 0.12, ease } },
      }}
    >
      {/* The 4px above each row, inside it, so it folds away with the row. */}
      <div className="pt-1">{children}</div>
    </motion.li>
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

/**
 * A project, folding open to its sessions like All Chats. Hovering it swaps the chevron for a plus
 * that starts a session there; right-click for the same and to archive or delete all its sessions.
 */
function ProjectItem({ project, sessions, all, selectedId, onDelete }: {
  project: AgentProject;
  sessions: AgentSession[];
  all: AgentSession[];
  selectedId: string | null;
  onDelete: (d: Deleting) => void;
}) {
  const [open, setOpen] = useState(true);
  // Folded, the session you're on stays under its project (as in the Claude app) and the rest fold
  // away around it. One list throughout, so that row never moves or redraws: only the others go.
  const shown = open ? sessions : sessions.filter((s) => s.id === selectedId);
  const startHere = () => {
    setOpen(true);
    void start(project.id, all);
  };

  return (
    <SidebarMenuItem>
      {/* The row and its plus, apart from the sessions below, so hovering a session leaves the chevron be. */}
      <div className="group/project relative">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            {/* Normal right padding: the plus sits over the chevron rather than beside it. */}
            <SidebarMenuButton title={project.path} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="pr-2!">
              <FolderIcon open={open} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <RowChevron open={open} className="group-has-[:focus-visible]/project:opacity-0 group-hover/project:opacity-0" />
            </SidebarMenuButton>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={startHere}>
              <IconSquareRoundedPlus />
              New Session
            </ContextMenuItem>
            {sessions.length > 0 && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void archive(sessions)}>
                  <IconArchive />
                  Archive All Sessions
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" onSelect={() => onDelete({ sessions, project })}>
                  <IconTrash />
                  Delete All Sessions
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
        <SidebarMenuAction
          onClick={startHere}
          title={`New session in ${project.name}`}
          aria-label={`New session in ${project.name}`}
          // Centred on the chevron it replaces (8px padding + half its 16px), at the same size.
          className="top-1/2! right-1.5 -translate-y-1/2 opacity-0 group-has-[:focus-visible]/project:opacity-100 group-hover/project:opacity-100 [&>svg]:size-4"
        >
          {/* A little heavier than the row's icons (2), so the small plus holds its own on hover. */}
          <IconPlus stroke={2.5} />
        </SidebarMenuAction>
      </div>
      {/* No gap or top padding of its own: each row carries its 4px, so a folding row takes it along. */}
      <SidebarMenuSub className="gap-0 pt-0 pl-3">
        <AnimatePresence initial={false}>
          {open && sessions.length === 0 ? (
            <FoldRow key="start">
              <SidebarMenuSubButton asChild>
                <button type="button" className="w-full text-muted-foreground" onClick={startHere}>
                  <span>Start a Session</span>
                </button>
              </SidebarMenuSubButton>
            </FoldRow>
          ) : (
            shown.map((s) => (
              <FoldRow key={s.id}>
                <SessionItem s={s} selected={s.id === selectedId} onDelete={() => onDelete({ sessions: [s] })} />
              </FoldRow>
            ))
          )}
        </AnimatePresence>
      </SidebarMenuSub>
    </SidebarMenuItem>
  );
}

/** Projects and their sessions, most recent first. */
export function CodeSidebarItems() {
  const agent = useAgent();
  const [deleting, setDeleting] = useState<Deleting>(null);
  const [busy, setBusy] = useState(false);
  const byProject = useMemo(() => {
    const m = new Map<string, AgentSession[]>();
    for (const s of agent.sessions) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [agent.sessions]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      for (const s of deleting.sessions) await deleteSession(s.id, true);
      setDeleting(null);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const one = deleting?.sessions.length === 1 && !deleting.project;

  return (
    <SidebarGroup className="px-1.5">
      <SidebarGroupLabel>Projects</SidebarGroupLabel>
      <SidebarGroupContent>
        {agent.loaded && agent.projects.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">Projects show here once you start a session in them in the Claude app.</p>
        )}
        <SidebarMenu>
          {agent.projects.map((p) => (
            <ProjectItem
              key={p.id}
              project={p}
              sessions={byProject.get(p.id) ?? []}
              all={agent.sessions}
              selectedId={agent.selectedId}
              onDelete={setDeleting}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && !busy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {one ? "Delete session?" : `Delete ${deleting?.sessions.length} sessions?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {one
                ? `"${deleting?.sessions[0]?.title || "New session"}" and its history are deleted for good, from the Claude app too. Archive it instead to keep it there.`
                : `Every session in ${deleting?.project?.name} and their history are deleted for good, from the Claude app too. Archive them instead to keep them there.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarGroup>
  );
}
