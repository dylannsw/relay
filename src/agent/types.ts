// The Code page's data, as the backend sends it (src-tauri/src/agent/types.rs).

export interface AgentProject {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

/** Supervised asks before commands and edits; Accept edits only before commands; Full access never asks. */
export type AgentMode = "supervised" | "acceptEdits" | "fullAccess";

export interface AgentSession {
  id: string;
  projectId: string;
  /** "" until the first message. */
  title: string;
  mode: AgentMode;
  /** Plan mode: Claude only reads and plans until you approve its plan. */
  plan: boolean;
  started: boolean;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  /** A Claude process is running for it. */
  live: boolean;
  /** A turn is in progress. */
  running: boolean;
  /** Requests waiting for your answer. */
  waiting: number;
  /** Started outside Relay (the Claude app or the CLI); its history is read from Claude Code's saved file. */
  fromClaude: boolean;
  /** Found in Claude Code's files but not used in Relay yet. Sending a message brings it in. */
  external: boolean;
  /** "Claude app" or "Claude Code", for one started outside Relay. */
  origin: string | null;
}

export type ApprovalState = "pending" | "allowed" | "denied" | "cancelled";

export interface AgentApproval {
  /** "" when Claude denied it by itself (its mode or your rules). */
  requestId: string;
  state: ApprovalState;
  answers: Record<string, string> | null;
  message: string | null;
}

export type TurnOutcome = "completed" | "stopped" | "error";

interface ItemBase {
  id: string;
  sessionId: string;
  seq: number;
  createdAt: number;
}

export type AgentItem = ItemBase &
  (
    | { kind: "user"; text: string }
    | { kind: "text"; text: string; streaming: boolean }
    | {
        kind: "tool";
        name: string;
        input: Record<string, unknown> | null;
        summary: string;
        output: string | null;
        isError: boolean;
        approval: AgentApproval | null;
      }
    | { kind: "turnEnd"; outcome: TurnOutcome; costUsd: number; durationMs: number; detail: string | null }
    | { kind: "notice"; text: string; error: boolean }
  );

export type AgentToolItem = Extract<AgentItem, { kind: "tool" }>;

/** Your answer to an approval, a question or a plan. */
export interface AgentAnswer {
  allow: boolean;
  message?: string;
  /** AskUserQuestion: question text to the chosen label(s), comma-separated for several. */
  answers?: Record<string, string>;
}

export interface AgentCliStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

/** The questions in an AskUserQuestion tool call. */
export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}
