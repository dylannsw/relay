// In-memory stand-in for the Rust backend, used only when the UI runs in a
// normal browser (`npm run dev`) so the interface can be worked on without
// signing in to real accounts. The Tauri app never loads this data.

import type { Account, Config, Folder, ListQuery, MessageDetail, OutgoingMessage, TasksConfig } from "./types";
import { formatDate } from "./tasks/tick/date";

const now = Date.now();
const h = 3_600_000;

let config: Config = {
  googleClientId: "",
  googleClientSecret: "",
  microsoftClientId: "",
  syncIntervalSecs: 120,
  messagesPerAccount: 100,
  shortcuts: {},
  tasks: {
    vaultPath: "C:\\Users\\you\\Documents\\Obsidian\\notes",
    bannerImage: "mock-banner.png",
    bannerPosition: 40,
    bannerDots: true,
  },
  displayName: "",
};

// ----- a pretend Obsidian vault for the Tasks pages -----

const tickSettings = JSON.stringify({
  todoNotePath: "00-tasklist.md",
  completedNotePath: "01-completed.md",
  dateFormat: "DD MMM YY",
  uppercaseDate: true,
  defaultSection: "No Category",
  heatmapColor: "#18cd91",
});

let todoNote = `## Relay
- [ ] Tasks page in Relay
  Banner, quick add and the overview card.
- [ ] Hook up Google Calendar
## Errands
- [ ] Renew passport
- [ ] Buy climbing shoes
  Size 42, try them on first.
## No Category
- [ ] Reply to Sam about Saturday
`;

/** About a month of finished tasks, newest day first, like the Completed note. */
function completedNote(): string {
  const days: string[] = [];
  const counts = [1, 4, 2, 0, 3, 5, 1, 2, 0, 0, 3, 1, 4, 2, 0, 1, 2, 3, 0, 1, 1, 0, 2];
  counts.forEach((n, ago) => {
    if (!n) return;
    const d = new Date(now - ago * 24 * h);
    const title = formatDate(d, "DD MMM YY", true);
    const tasks = Array.from({ length: n }, (_, i) => `- [x] Finished thing ${ago}.${i + 1} (${i % 2 ? "Errands" : "Relay"})`);
    days.push([`## ${title}`, ...tasks].join("\n"));
  });
  return days.join("\n\n") + "\n";
}

let doneNote = completedNote();
let todoStamp = 1;
let doneStamp = 1;

/** A made-up landscape (sky, sun, hills), as PNG bytes, standing in for a banner picture. */
async function mockBanner(): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 900;
  const ctx = canvas.getContext("2d")!;
  const sky = ctx.createLinearGradient(0, 0, 0, 900);
  sky.addColorStop(0, "#3b6fb6");
  sky.addColorStop(0.6, "#9cc3e6");
  sky.addColorStop(1, "#e8d9b0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1600, 900);
  ctx.fillStyle = "#fff4c2";
  ctx.beginPath();
  ctx.arc(1180, 260, 90, 0, Math.PI * 2);
  ctx.fill();
  const hill = (y: number, color: string, amp: number, freq: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 900);
    for (let x = 0; x <= 1600; x += 20) ctx.lineTo(x, y + Math.sin(x * freq) * amp + Math.sin(x * freq * 2.7) * amp * 0.4);
    ctx.lineTo(1600, 900);
    ctx.fill();
  };
  hill(560, "#4f7a3a", 50, 0.004);
  hill(650, "#2f5a2a", 60, 0.006);
  hill(760, "#1d3b1c", 40, 0.009);
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
  return blob.arrayBuffer();
}

const accounts: Account[] = [
  acct("a1", "google", "alex.personal@gmail.com", "Personal", "#008dff"),
  acct("a2", "google", "alex@studio-work.com", "Work", "#33c759"),
  acct("a3", "microsoft", "alex@contoso.com", "Work", "#6a42e1"),
  acct("a4", "microsoft", "alex@university.edu", "School", "#df9147"),
];

function acct(id: string, provider: Account["provider"], email: string, label: string, color: string): Account {
  return { id, provider, email, displayName: "Alex Kim", label, color, unreadCount: 0, lastSync: now, lastError: null };
}

let messages: MessageDetail[] = [
  m("a4", "Exam schedule posted", "Registrar", "registrar@university.edu", 0.4, false, "Final exam schedules for the fall term are now available in the student portal."),
  m("a3", "Q4 planning doc — comments by Friday", "Dana Ortiz", "dana@contoso.com", 1.2, false, "Hi team, I've shared the Q4 planning doc. Please leave comments by Friday.", true),
  m("a1", "Dinner Saturday?", "Sam", "sam.lee@gmail.com", 2.5, true, "Are we still on for Saturday? I can book the place on 5th."),
  m("a2", "Invoice #1042 from Northwind", "Northwind Billing", "billing@northwind.io", 5, false, "Your invoice for October is attached. Payment is due in 30 days.", false, true),
  m("a4", "Group project: meeting notes", "Priya N.", "priya@university.edu", 9, true, "Notes from today's meeting are below. Next sync is Tuesday."),
  m("a1", "Your package has shipped", "Shop Updates", "updates@shop.example", 20, true, "Good news! Your order is on its way and should arrive Thursday."),
  m("a3", "1:1 moved to 3pm", "Jordan Blake", "jordan@contoso.com", 26, true, "Hey, can we move our 1:1 to 3pm? Something came up."),
  m("a2", "Design review feedback", "Chris", "chris@studio-work.com", 50, true, "Loved the direction. A few notes on spacing and the color system."),
  m("a1", "Weekend photos", "Mom", "mom@example.com", 80, true, "Here are the photos from the weekend! Love you."),
  m("a1", "Flight confirmation: SFO → JFK", "Airline", "trips@airline.example", 120, true, "Your booking is confirmed. Check in opens 24 hours before departure.", false, false, "archive"),
  m("a3", "Lunch order", "Facilities", "facilities@contoso.com", 140, true, "Thanks for ordering lunch for the offsite. Receipt attached.", false, true, "archive"),
  m("a1", "50% off everything this weekend", "Deals Daily", "promo@deals.example", 30, false, "Don't miss out on our biggest sale of the year.", false, false, "trash"),
  m("a4", "Library hold expired", "Library", "library@university.edu", 60, true, "Your hold on 'Design of Everyday Things' has expired.", false, false, "trash"),
  m("a1", "You've won a prize!!!", "Prize Center", "winner@prize.example", 4, false, "Click here to claim your reward before it expires.", false, false, "spam"),
  m("a2", "Urgent: verify your account", "Security Team", "security@verify.example", 15, false, "We noticed unusual activity. Verify your account now.", false, false, "spam"),
];

function m(
  accountId: string, subject: string, name: string, email: string, hoursAgo: number,
  isRead: boolean, text: string, isStarred = false, hasAttachments = false, folder: Folder = "inbox",
): MessageDetail {
  const remoteId = Math.random().toString(36).slice(2, 10);
  const a = accounts.find((x) => x.id === accountId)!;
  return {
    id: `${accountId}:${remoteId}`, accountId, remoteId, threadId: null,
    from: { name, email }, to: [{ name: a.displayName, email: a.email }], cc: [], replyTo: [],
    subject, snippet: text, date: now - hoursAgo * h, isRead, isStarred, hasAttachments,
    messageIdHdr: null, referencesHdr: null, folder,
    bodyHtml: `<div style="font-family:Segoe UI,Arial"><p>${text}</p><p>Thanks,<br>${name}</p>
      <p><img src="https://example.com/tracker.png" width="1" height="1"></p></div>`,
    bodyText: null,
    attachments: hasAttachments ? [{ id: "att1", name: "invoice-1042.pdf", mimeType: "application/pdf", size: 48213 }] : [],
  };
}

function withCounts(): Account[] {
  return accounts.map((a) => ({
    ...a,
    unreadCount: messages.filter((x) => x.accountId === a.id && x.folder === "inbox" && !x.isRead).length,
  }));
}

const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const find = (id: unknown) => messages.find((x) => x.id === id);
  switch (cmd) {
    case "get_config":
      return delay(config) as Promise<T>;
    case "save_config":
      config = { ...(args.config as Config), tasks: config.tasks, displayName: config.displayName };
      return delay(config) as Promise<T>;
    case "save_display_name":
      config = { ...config, displayName: (args.name as string).trim().replace(/\s+/g, " ") };
      return delay(config) as Promise<T>;
    case "save_tasks_config":
      config = { ...config, tasks: args.tasks as TasksConfig };
      return delay(config) as Promise<T>;
    case "set_task_banner":
      config = { ...config, tasks: { ...config.tasks, bannerImage: "mock-banner.png", bannerPosition: 50 } };
      return delay(config) as Promise<T>;
    case "read_image":
      return mockBanner() as Promise<T>;
    case "tasks_load":
      return delay({
        vaultPath: config.tasks.vaultPath,
        settings: config.tasks.vaultPath ? tickSettings : null,
        todo: config.tasks.vaultPath ? { path: "00-tasklist.md", content: todoNote, stamp: String(todoStamp) } : null,
        completed: config.tasks.vaultPath ? { path: "01-completed.md", content: doneNote, stamp: String(doneStamp) } : null,
        error: config.tasks.vaultPath ? null : "Choose your Obsidian vault folder to see your tasks.",
      }) as Promise<T>;
    case "tasks_write": {
      const isTodo = args.note === "todo";
      if (args.expected !== String(isTodo ? todoStamp : doneStamp)) return Promise.reject("The note changed while saving. Try again.");
      if (isTodo) {
        todoNote = args.content as string;
        todoStamp++;
      } else {
        doneNote = args.content as string;
        doneStamp++;
      }
      return delay(String(isTodo ? todoStamp : doneStamp), 40) as Promise<T>;
    }
    case "list_accounts":
      return delay(withCounts()) as Promise<T>;
    case "add_account":
      return Promise.reject("Adding real accounts only works in the desktop app (npm run app).");
    case "update_account": {
      const a = accounts.find((x) => x.id === args.id)!;
      a.label = args.label as string;
      a.color = args.color as string;
      return delay(a) as Promise<T>;
    }
    case "remove_account": {
      const i = accounts.findIndex((x) => x.id === args.id);
      if (i >= 0) accounts.splice(i, 1);
      messages = messages.filter((x) => x.accountId !== args.id);
      return delay(undefined) as Promise<T>;
    }
    case "list_messages": {
      const q = args.query as ListQuery;
      const s = q.search?.toLowerCase();
      const list = messages
        .filter((x) => x.folder === (q.folder ?? "inbox"))
        .filter((x) => !q.accountIds || q.accountIds.includes(x.accountId))
        .filter((x) => !q.unreadOnly || !x.isRead)
        .filter((x) => !q.starredOnly || x.isStarred)
        .filter((x) => !s || `${x.subject} ${x.from.name} ${x.from.email} ${x.snippet}`.toLowerCase().includes(s))
        .sort((a, b) => b.date - a.date)
        .map(({ bodyHtml: _b, bodyText: _t, attachments: _a, ...summary }) => summary);
      return delay(list, 60) as Promise<T>;
    }
    case "get_message":
      return delay(find(args.id)) as Promise<T>;
    case "set_read":
      find(args.id)!.isRead = args.read as boolean;
      return delay(undefined) as Promise<T>;
    case "set_starred":
      find(args.id)!.isStarred = args.starred as boolean;
      return delay(undefined) as Promise<T>;
    case "move_message":
      find(args.id)!.folder = args.folder as Folder;
      return delay(undefined) as Promise<T>;
    case "send_message": {
      const out = args.message as OutgoingMessage;
      console.info("[mock] would send", out);
      return delay(undefined, 400) as Promise<T>;
    }
    case "download_attachment":
      return delay("C:\\Users\\you\\Downloads\\invoice-1042.pdf") as Promise<T>;
    case "sync_now":
      return delay(accounts.map((a) => ({ accountId: a.id, newMessages: 0, error: null })), 600) as Promise<T>;
    case "cancel_sign_in":
      return delay(undefined) as Promise<T>;
    default:
      return Promise.reject(`mock: unknown command ${cmd}`);
  }
}
