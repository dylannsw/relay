import { useEffect, useState } from "react";
import { IconAlertTriangle, IconRefresh, IconTerminal2 } from "@tabler/icons-react";
import { isTauri } from "@/api";
import { PageHeader, PageTitle } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { recheckCli, refresh, selectSession, startAgent, useAgent } from "@/agent/store";
import { Conversation } from "./conversation";

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
  // The list again each time the page opens: new conversations may have started in the Claude app.
  useEffect(() => {
    startAgent();
    void refresh();
  }, []);

  // Opens the most recent session when none is picked (first visit, or the open one was removed).
  const selected = agent.sessions.find((s) => s.id === agent.selectedId) ?? null;
  useEffect(() => {
    if (!selected && agent.sessions.length) selectSession(agent.sessions[0].id);
  }, [selected, agent.sessions]);

  const project = selected ? agent.projects.find((p) => p.id === selected.projectId) : undefined;

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
          <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground" title={agent.cli.path ?? undefined}>
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
        <section className="min-h-0 min-w-0 flex-1">
          {selected ? (
            <Conversation key={selected.id} session={selected} project={project} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {agent.projects.length ? "Pick a session in the sidebar, or start one with +." : "Add a project in the sidebar to start."}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
