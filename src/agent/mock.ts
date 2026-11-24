// Sample Code page data for the browser preview (`npm run dev`), where there's no Claude CLI.
// Replies stream in word by word, and approvals, questions and plans can be answered.

import type { AgentEvent } from "@/api";
import type { AgentAnswer, AgentItem, AgentMode, AgentProject, AgentSession } from "./types";

const now = Date.now();
const min = 60_000;

const projects: AgentProject[] = [
  { id: "p1", name: "relay", path: "C:\\Users\\you\\Projects\\relay", createdAt: now - 30 * 24 * 60 * min },
  { id: "p2", name: "zen-theme", path: "C:\\Users\\you\\Projects\\zen-theme", createdAt: now - 20 * 24 * 60 * min },
];

const session = (id: string, projectId: string, title: string, ago: number, extra: Partial<AgentSession> = {}): AgentSession => ({
  id, projectId, title, mode: "supervised", plan: false, started: true, model: "claude-opus-5-5",
  createdAt: now - ago - 10 * min, updatedAt: now - ago, live: false, running: false, waiting: 0,
  fromClaude: false, external: false, origin: null, ...extra,
});

const sessions: AgentSession[] = [
  session("s1", "p1", "Add an unread count to the Chats tab", 4 * min),
  session("s2", "p1", "Fix calendar sync skipping recurring events", 12 * min, { live: true, waiting: 1 }),
  session("s3", "p2", "Pick an accent colour for the sidebar", 50 * min, { live: true, waiting: 1, mode: "acceptEdits" }),
  session("s4", "p1", "Plan worktree support", 3 * 60 * min, { live: true, waiting: 1, plan: true }),
  session("s5", "p1", "Bookmark video player controls", 26 * 60 * min, { fromClaude: true, external: true, origin: "Claude app", model: null }),
];

let seq = 0;
const item = (sessionId: string, body: Record<string, unknown>, id = `i${++seq}`): AgentItem =>
  ({ id, sessionId, seq: ++seq, createdAt: now - (100 - seq) * 20_000, ...body }) as AgentItem;
const tool = (sessionId: string, name: string, input: Record<string, unknown>, summary: string, output: string | null, approval: Record<string, unknown> | null = null) =>
  item(sessionId, { kind: "tool", name, input, summary, output, isError: false, approval });

const items: Record<string, AgentItem[]> = {
  s1: [
    item("s1", { kind: "user", text: "The Chats tab in the sidebar should show how many unread chats there are, like Tasks does." }),
    item("s1", { kind: "text", streaming: false, text: "I'll look at how the Tasks badge works first, then add the same for Chats." }),
    tool("s1", "Grep", { pattern: "SidebarMenuBadge" }, "SidebarMenuBadge", "src/components/app-sidebar.tsx:327\nsrc/components/ui/sidebar.tsx:612"),
    tool("s1", "Read", { file_path: "src/components/app-sidebar.tsx" }, "src/components/app-sidebar.tsx", "(412 lines)"),
    tool("s1", "Edit", { file_path: "src/components/app-sidebar.tsx", old_string: "<span>All chats</span>", new_string: "<span>All chats</span>\n{allUnread > 0 && <SidebarMenuBadge>{allUnread}</SidebarMenuBadge>}" }, "src/components/app-sidebar.tsx", "Edited", { requestId: "r0", state: "allowed", answers: null, message: null }),
    tool("s1", "Bash", { command: "npm run typecheck" }, "npm run typecheck", "> relay@2.1.0 typecheck\n> tsc --noEmit\n", { requestId: "r00", state: "allowed", answers: null, message: null }),
    item("s1", {
      kind: "text", streaming: false,
      text: "Done. **All chats** now shows a badge with the unread count:\n\n- It uses `unreadChats(tg.chats, null)`, so muted chats don't count, as in Telegram.\n- Folders already had counts, so nothing changed there.\n\n```tsx\n{allUnread > 0 && <SidebarMenuBadge>{allUnread}</SidebarMenuBadge>}\n```\n\nType check passes.",
    }),
    item("s1", { kind: "turnEnd", outcome: "completed", costUsd: 0.42, durationMs: 48_000, detail: null }),
  ],
  s2: [
    item("s2", { kind: "user", text: "Calendar sync skips recurring events that were moved. Can you find out why?" }),
    item("s2", { kind: "text", streaming: false, text: "Let me check how moved occurrences are stored, and run the calendar tests." }),
    tool("s2", "Read", { file_path: "src-tauri/src/calendar.rs" }, "src-tauri/src/calendar.rs", "(689 lines)"),
    tool("s2", "Bash", { command: "cd src-tauri && cargo test calendar", description: "Run the calendar tests" }, "cd src-tauri && cargo test calendar", null,
      { requestId: "r2", state: "pending", answers: null, message: null }),
  ],
  s3: [
    item("s3", { kind: "user", text: "Help me choose an accent colour for the sidebar's active item." }),
    tool("s3", "AskUserQuestion", {
      questions: [{
        question: "Which direction should the accent go?", header: "Accent", multiSelect: false,
        options: [
          { label: "Warm", description: "Amber or coral: friendly, stands out on grey" },
          { label: "Cool", description: "Teal or blue: calm, matches the mail colours" },
          { label: "Neutral", description: "Near-black in light mode, near-white in dark" },
        ],
      }],
    }, "Which direction should the accent go?", null, { requestId: "r3", state: "pending", answers: null, message: null }),
  ],
  s5: [
    item("s5", { kind: "user", text: "The video player in Bookmarks needs a floating control bar." }),
    item("s5", { kind: "text", streaming: false, text: "Added a control bar that fades in on hover, with play, scrub and mute." }),
  ],
  s4: [
    item("s4", { kind: "user", text: "Plan how sessions could each run in their own git worktree." }),
    tool("s4", "Read", { file_path: "docs/plans/claude-in-relay.md" }, "docs/plans/claude-in-relay.md", "(170 lines)"),
    tool("s4", "ExitPlanMode", {
      plan: "## Worktrees per session\n\n1. **New session dialog** gets a *Work on a new branch* switch.\n2. On start, run `git worktree add ../relay-worktrees/<slug> -b claude/<slug>`.\n3. The session's process runs in that folder.\n4. **Changes panel** lists `git status` and diffs for it.\n5. Deleting the session offers to remove the worktree.\n\nRisk: `node_modules` isn't shared, so each worktree needs `npm ci` once.",
    }, "Plan ready for review", null, { requestId: "r4", state: "pending", answers: null, message: null }),
  ],
};

const subs = new Set<(e: AgentEvent) => void>();
const emit = (e: AgentEvent) => subs.forEach((cb) => cb(e));

export function mockAgentEvents(cb: (e: AgentEvent) => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}

const find = (id: unknown) => sessions.find((s) => s.id === id)!;
const patch = (id: string, p: Partial<AgentSession>) => {
  const s = find(id);
  Object.assign(s, p, { updatedAt: Date.now() });
  emit({ type: "session", session: { ...s } });
};
const push = (sessionId: string, body: Record<string, unknown>, id?: string) => {
  const it = item(sessionId, body, id);
  (items[sessionId] ??= []).push(it);
  emit({ type: "item", sessionId, item: { ...it } });
  return it;
};
const replace = (sessionId: string, it: AgentItem) => {
  const list = items[sessionId];
  const i = list.findIndex((x) => x.id === it.id);
  if (i >= 0) list[i] = it;
  emit({ type: "item", sessionId, item: { ...it } });
};

const timers = new Map<string, number>();

/** Streams `text` in as a reply, then ends the turn. */
function reply(sessionId: string, text: string) {
  patch(sessionId, { live: true, running: true });
  const msg = push(sessionId, { kind: "text", text: "", streaming: true });
  const words = text.split(/(?<= )/);
  let n = 0;
  const tick = () => {
    if (n < words.length) {
      const word = words[n++];
      // Kept on the stored copy too, so Stop keeps what has arrived, as the real backend does.
      (msg as { text: string }).text += word;
      emit({ type: "delta", sessionId, itemId: msg.id, text: word });
      timers.set(sessionId, window.setTimeout(tick, 45));
      return;
    }
    replace(sessionId, { ...msg, text, streaming: false } as AgentItem);
    push(sessionId, { kind: "turnEnd", outcome: "completed", costUsd: 0.03, durationMs: words.length * 45, detail: null });
    patch(sessionId, { running: false });
  };
  timers.set(sessionId, window.setTimeout(tick, 600));
}

const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 80));

export async function mockAgent<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const sid = args.sessionId as string;
  switch (cmd) {
    case "agent_cli_status":
      return delay({ found: true, path: "C:\\Users\\you\\.local\\bin\\claude.exe", version: "2.1.330 (Claude Code)", error: null }) as Promise<T>;
    case "agent_projects":
      return delay([...projects]) as Promise<T>;
    case "agent_add_project": {
      const path = String(args.path);
      const p = { id: `p${projects.length + 1}`, name: path.split(/[\\/]/).pop() || path, path, createdAt: Date.now() };
      projects.push(p);
      return delay(p) as Promise<T>;
    }
    case "agent_remove_project": {
      const i = projects.findIndex((p) => p.id === args.id);
      if (i >= 0) projects.splice(i, 1);
      return delay(undefined) as Promise<T>;
    }
    case "agent_sessions":
      return delay(sessions.map((s) => ({ ...s }))) as Promise<T>;
    case "agent_new_session": {
      const s = session(`s${sessions.length + 1}-${Date.now()}`, args.projectId as string, "", 0, {
        started: false, mode: args.mode as AgentMode, plan: Boolean(args.plan), model: null,
      });
      sessions.unshift(s);
      items[s.id] = [];
      return delay({ ...s }) as Promise<T>;
    }
    case "agent_items":
      return delay((items[sid] ?? []).map((x) => ({ ...x }))) as Promise<T>;
    case "agent_send": {
      const text = String(args.text);
      push(sid, { kind: "user", text });
      const s = find(sid);
      if (s.external) patch(sid, { external: false });
      if (!s.title) patch(sid, { title: text.split("\n")[0].slice(0, 60) });
      reply(sid, "This is the browser preview, so no Claude is running here. In the desktop app (`npm run app`) this message goes to Claude Code on your PC, and its reply streams in **just like this**.");
      return delay(undefined) as Promise<T>;
    }
    case "agent_stop": {
      clearTimeout(timers.get(sid));
      const list = items[sid] ?? [];
      const last = list[list.length - 1];
      if (last?.kind === "text" && last.streaming) replace(sid, { ...last, streaming: false });
      push(sid, { kind: "turnEnd", outcome: "stopped", costUsd: 0.01, durationMs: 900, detail: null });
      patch(sid, { running: false });
      return delay(undefined) as Promise<T>;
    }
    case "agent_answer": {
      const answer = args.answer as AgentAnswer;
      const it = (items[sid] ?? []).find((x) => x.kind === "tool" && x.approval?.requestId === args.requestId);
      if (it && it.kind === "tool" && it.approval) {
        replace(sid, {
          ...it,
          approval: { ...it.approval, state: answer.allow ? "allowed" : "denied", answers: answer.answers ?? null, message: answer.message ?? null },
          output: answer.allow && it.name === "Bash" ? "running 4 tests\ntest result: ok. 4 passed; 0 failed" : it.output,
        });
        const s = find(sid);
        patch(sid, { waiting: Math.max(0, s.waiting - 1), ...(it.name === "ExitPlanMode" && answer.allow ? { plan: false } : {}) });
        const picked = answer.answers ? Object.values(answer.answers).join(", ") : "";
        reply(sid, !answer.allow
          ? `Understood, I won't do that.${answer.message ? ` You said: "${answer.message}".` : ""}`
          : it.name === "AskUserQuestion" ? `Going with **${picked}**. I'll try two shades of it in light and dark mode.`
          : it.name === "ExitPlanMode" ? "Plan approved. Starting with the new session dialog." : "All 4 calendar tests pass, so the bug is outside them. Next I'll add a test for a moved occurrence.");
      }
      return delay(undefined) as Promise<T>;
    }
    case "agent_set_mode": {
      patch(sid, { mode: args.mode as AgentMode, plan: Boolean(args.plan) });
      return delay({ ...find(sid) }) as Promise<T>;
    }
    case "agent_rename_session":
      patch(sid, { title: String(args.title) });
      return delay(undefined) as Promise<T>;
    case "agent_delete_session": {
      const i = sessions.findIndex((s) => s.id === sid);
      if (i >= 0) sessions.splice(i, 1);
      return delay(undefined) as Promise<T>;
    }
    default:
      return Promise.reject(`mock: unknown command ${cmd}`);
  }
}
