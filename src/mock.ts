// In-memory stand-in for the Rust backend, used only when the UI runs in a
// normal browser (`npm run dev`) so the interface can be worked on without
// signing in to real accounts. The Tauri app never loads this data.

import type {
  Account, Attendee, SenderGroup, CalendarConfig, CalendarEvent, CalendarInfo, Config, EditScope, EventChanges, EventColors, NewEvent, Folder, ListQuery, MessageDetail,
  OutgoingMessage, SeriesInfo, TasksConfig,
} from "./types";
import { formatDate } from "./tasks/tick/date";
import { mockTelegram } from "./telegram/mock";

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
  calendar: { hidden: [], colors: {}, defaultCalendar: "" },
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
  return {
    id, provider, email, displayName: "Alex Kim", label, color, unreadCount: 0, lastSync: now, lastError: null,
    // The personal Gmail already allows Calendar; the work one was added before Calendar existed.
    calendarAccess: id === "a1", calendarSync: id === "a1" ? now - 2 * 60_000 : null, calendarError: null,
  };
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
  // Bulk senders, spread over subdomains and accounts, so the Senders view has something to group.
  ...[
    ["a1", "Your cart is waiting", "ShopMart", "offers@mail.shopmart.com", 3, false],
    ["a1", "Weekend flash sale: 40% off", "ShopMart", "deals@news.shopmart.com", 27, false],
    ["a1", "New arrivals you'll love", "ShopMart", "offers@mail.shopmart.com", 52, true],
    ["a2", "Order shipped", "ShopMart Orders", "orders@shopmart.com", 75, true],
    ["a1", "Last chance: free shipping", "ShopMart", "deals@news.shopmart.com", 99, true],
    ["a1", "Your weekly digest", "Medium Daily Digest", "noreply@medium.com", 6, false],
    ["a1", "Stories picked for you", "Medium Daily Digest", "noreply@medium.com", 30, false],
    ["a1", "Top stories this week", "Medium Daily Digest", "noreply@medium.com", 54, true],
    ["a2", "[studio/app] Pull request merged", "GitHub", "notifications@github.com", 8, true],
    ["a2", "[studio/app] New issue opened", "GitHub", "notifications@github.com", 34, true],
    ["a1", "Welcome to the community", "Kiwi Learning", "hello@kiwi-learn.co.uk", 12, false],
    ["a1", "Your lesson streak is at risk", "Kiwi Learning", "reminders@mail.kiwi-learn.co.uk", 38, false],
  ].map(([account, subject, name, email, hours, read]) =>
    m(account as string, subject as string, name as string, email as string, hours as number, read as boolean, "Sample bulk mail for the Senders view."),
  ),
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

/** Messages a query selects, newest first (the query's limit is left to the caller). */
function matching(q: ListQuery): MessageDetail[] {
  const s = q.search?.toLowerCase();
  const from = q.fromEmails?.map((e) => e.toLowerCase());
  return messages
    .filter((x) => x.folder === (q.folder ?? "inbox"))
    .filter((x) => !q.accountIds || q.accountIds.includes(x.accountId))
    .filter((x) => !from || from.includes(x.from.email.toLowerCase()))
    .filter((x) => !q.unreadOnly || !x.isRead)
    .filter((x) => !q.starredOnly || x.isStarred)
    .filter((x) => !s || `${x.subject} ${x.from.name} ${x.from.email} ${x.snippet}`.toLowerCase().includes(s))
    .sort((a, b) => b.date - a.date);
}

function withCounts(): Account[] {
  return accounts.map((a) => ({
    ...a,
    unreadCount: messages.filter((x) => x.accountId === a.id && x.folder === "inbox" && !x.isRead).length,
  }));
}

// ----- Senders view: a TypeScript copy of senders.rs, so the browser preview groups the same way -----

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
  "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
]);
const FREE_MAIL_LABELS = new Set(["gmail", "hotmail", "outlook", "live", "yahoo"]);
/** Second-level labels under a country code (shop.co.uk), enough for the sample data. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "edu", "gov"]);

function registrableDomain(email: string): string | null {
  const host = email.split("@")[1]?.trim().toLowerCase();
  if (!host) return null;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const n = labels[labels.length - 1]!.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-n).join(".");
}

function mockSenderGroups(list: MessageDetail[]): SenderGroup[] {
  const own = accounts.map((a) => registrableDomain(a.email));
  const groups = new Map<string, SenderGroup>();
  for (const x of [...list].sort((a, b) => b.date - a.date)) {
    const address = x.from.email.trim().toLowerCase();
    const domain = registrableDomain(address);
    const grouped = !!domain && !FREE_MAIL.has(domain) && !FREE_MAIL_LABELS.has(domain.split(".")[0]!) && !own.includes(domain);
    const key = grouped ? domain : address;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, name: grouped || !x.from.name.trim() ? key : x.from.name.trim(), isDomain: grouped,
        count: 0, unreadCount: 0, latestSubject: x.subject, latestDate: x.date, addresses: [],
      };
      groups.set(key, g);
    }
    g.count++;
    if (!x.isRead) g.unreadCount++;
    if (!g.addresses.includes(address)) g.addresses.push(address);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.latestDate - a.latestDate);
}


// ----- pretend Google calendars -----

/** Mock-only copy of colors.rs, so the browser preview shows the same colors the app works out. */
function mockEventColors(hex: string): EventColors {
  type Rgb = [number, number, number];
  const parse = (s: string): Rgb | null => {
    let t = s.trim().replace(/^#/, "");
    if (t.length === 3) t = [...t].map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}$/i.test(t)) return null;
    const v = parseInt(t, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => x / 255) as Rgb;
  };
  const toHex = (c: Rgb) => "#" + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("");
  const mix = (a: Rgb, b: Rgb, t: number) => a.map((x, i) => x * t + b[i] * (1 - t)) as Rgb;
  const lum = (c: Rgb) => {
    const l = c.map((x) => {
      const v = Math.round(Math.min(1, Math.max(0, x)) * 255) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  };
  const contrast = (a: Rgb, b: Rgb) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const hsl = ([r, g, b]: Rgb): Rgb => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hh / 6, s, l];
  };
  const rgb = (hh: number, s: number, l: number): Rgb => {
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t: number) => {
      t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)];
  };
  const readable = (bg: Rgb, hue: Rgb, min: number): Rgb => {
    const [hh, s0, l] = hsl(hue);
    const s = Math.min(s0, 0.85);
    const dirs = lum(bg) > 0.18 ? [-1, 1] : [1, -1];
    for (const dir of dirs) {
      for (let step = 0; ; step++) {
        const ll = l + dir * step * 0.01;
        if (ll < 0 || ll > 1) break;
        const c = rgb(hh, s, ll);
        if (contrast(c, bg) >= min) return c;
      }
    }
    return contrast([0, 0, 0], bg) >= contrast([1, 1, 1], bg) ? [0, 0, 0] : [1, 1, 1];
  };
  const base = parse(hex) ?? parse("#9e9e9e")!;
  const light = mix(base, [1, 1, 1], 0.22);
  const dark = mix(base, [0.09, 0.09, 0.09], 0.38);
  return {
    base: toHex(base), text: toHex(readable(base, base, 4.5)), muted: toHex(readable(base, base, 3)),
    lightBg: toHex(light), lightText: toHex(readable(light, base, 4.5)), lightMuted: toHex(readable(light, base, 3)),
    darkBg: toHex(dark), darkText: toHex(readable(dark, base, 4.5)), darkMuted: toHex(readable(dark, base, 3)),
  };
}

interface MockCal { id: string; accountId: string; name: string; googleColor: string; accessRole: string; isPrimary: boolean }

const mockCals: MockCal[] = [
  { id: "a1:alex.personal@gmail.com", accountId: "a1", name: "alex.personal@gmail.com", googleColor: "#4986e7", accessRole: "owner", isPrimary: true },
  { id: "a1:family", accountId: "a1", name: "Family", googleColor: "#f691b2", accessRole: "writer", isPrimary: false },
  { id: "a1:gym", accountId: "a1", name: "Climbing & gym", googleColor: "#ff7537", accessRole: "owner", isPrimary: false },
  { id: "a1:en.singapore#holiday", accountId: "a1", name: "Holidays in Singapore", googleColor: "#16a765", accessRole: "reader", isPrimary: false },
  { id: "a1:birthdays", accountId: "a1", name: "Birthdays", googleColor: "#92e1c0", accessRole: "reader", isPrimary: false },
];

function mockCalendars(): CalendarInfo[] {
  const cfg: CalendarConfig = config.calendar;
  const visible = mockCals.filter((c) => accounts.some((a) => a.id === c.accountId && a.calendarAccess));
  const writable = (c: MockCal) => c.accessRole === "owner" || c.accessRole === "writer";
  const def = visible.find((c) => c.id === cfg.defaultCalendar && writable(c)) ?? visible.find((c) => c.isPrimary && writable(c));
  return visible.map((c): CalendarInfo => ({
    ...c,
    accountEmail: accounts.find((a) => a.id === c.accountId)!.email,
    canWrite: writable(c),
    hidden: cfg.hidden.includes(c.id),
    isDefault: def?.id === c.id,
    customColor: cfg.colors[c.id] ?? null,
    colors: mockEventColors(cfg.colors[c.id] ?? c.googleColor),
    lastError: null,
    isFeed: false,
    lastSync: null,
  })).concat(
    mockFeeds.map((f) => ({
      id: f.id, accountId: "", accountEmail: "Subscribed by URL", name: f.name, isPrimary: false, accessRole: "reader",
      canWrite: false, hidden: cfg.hidden.includes(f.id), isDefault: false, googleColor: f.color,
      customColor: cfg.colors[f.id] ?? null, colors: mockEventColors(cfg.colors[f.id] ?? f.color),
      lastError: null, isFeed: true, lastSync: f.lastSync,
    })),
  );
}

// ----- pretend calendars subscribed by URL -----

interface MockFeed { id: string; name: string; color: string; lastSync: number }
const mockFeeds: MockFeed[] = [];
const FEED_COLORS = ["#9a9cff", "#16a765", "#ff7537", "#f691b2", "#4986e7", "#fad165"];

/** A work week of standups and a review, as a work calendar's feed would have. */
function mockFeedEvents(calendarId: string): CalendarEvent[] {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const at = (d: number, h: number, m = 0) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d, h, m).getTime();
  const ev = (title: string, d: number, from: [number, number], to: [number, number], extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: `${calendarId}:${title}:${d}`, calendarId, accountId: "", remoteId: "", recurringEventId: null, icalUid: `${title}@google.com`,
    title, location: "", description: "", start: at(d, ...from), end: at(d, ...to), allDay: false, startDate: null, endDate: null,
    status: "confirmed", myResponse: null, organizer: null, attendees: [], htmlLink: "", meetLink: null, canEdit: false, ...extra,
  });
  const list: CalendarEvent[] = [];
  for (let d = 0; d < 5; d++) {
    list.push(ev("Team standup", d, [9, 30], [9, 45], { recurringEventId: "standup@google.com", meetLink: "https://meet.google.com/abc-defg-hij" }));
  }
  list.push(ev("Quarterly review", 3, [14, 0], [15, 30], { location: "Level 12, Room Orchid", status: "tentative" }));
  return list;
}

const mockEvents: CalendarEvent[] = (() => {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const at = (d: number, hh: number, mm = 0) => day.getTime() + d * 24 * h + (hh * 60 + mm) * 60_000;
  const ev = (calendarId: string, title: string, d: number, from: number, to: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: `${calendarId}:${title}`, calendarId, accountId: "a1", remoteId: title, recurringEventId: null, icalUid: `${title}@google.com`,
    title, location: "", description: "", start: at(d, from), end: at(d, to), allDay: false, startDate: null, endDate: null,
    status: "confirmed", myResponse: null, organizer: null, attendees: [], htmlLink: "", meetLink: null, canEdit: true, ...extra,
  });
  const iso = (d: number) => {
    const x = new Date(day);
    x.setDate(x.getDate() + d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  };
  const allDay = (calendarId: string, title: string, d: number, days = 1, extra: Partial<CalendarEvent> = {}) =>
    ev(calendarId, title, d, 0, 0, {
      allDay: true, startDate: iso(d), endDate: iso(d + days), start: at(d, 0), end: at(d + days, 0), ...extra,
    });
  const me = "a1:alex.personal@gmail.com";
  const guests = (organizer: string, you: CalendarEvent["myResponse"]) => [
    { email: organizer, name: "Sam Lee", response: "accepted" as const, optional: false, organizer: true, isYou: false },
    { email: "alex.personal@gmail.com", name: "", response: you ?? "accepted", optional: false, organizer: false, isYou: true },
    { email: "priya@example.com", name: "Priya N.", response: "tentative" as const, optional: false, organizer: false, isYou: false },
    { email: "jordan@example.com", name: "Jordan Blake", response: "declined" as const, optional: true, organizer: false, isYou: false },
  ];
  const list: CalendarEvent[] = [
    ev(me, "Dentist", 0, 10, 11, { location: "Raffles Medical, Holland Village", description: "Bring the insurance card.<br>Check-up and clean." }),
    ev(me, "Coffee with Priya", 0, 10, 11, { location: "Common Man, Robertson Quay" }),
    ev(me, "Design review", 0, 10.5, 12, { meetLink: "https://meet.google.com/abc-defg-hij" }),
    ev("a1:family", "Dinner with Sam", 0, 19, 21, {
      myResponse: "needsAction", canEdit: false, location: "Burnt Ends",
      organizer: { name: "Sam Lee", email: "sam.lee@gmail.com" }, attendees: guests("sam.lee@gmail.com", "needsAction"),
    }),
    ev("a1:gym", "Bouldering", 1, 18, 20, { location: "Boulder Planet, Sembawang" }),
    ev(me, "Standup", 1, 9, 9.25),
    ev(me, "Lunch with team", 1, 12, 13),
    ev(me, "Flight SQ 322 → London", 2, 23, 30, { location: "Changi Airport T3" }),
    ev("a1:family", "Mum's birthday lunch", 3, 12, 14, {
      myResponse: "accepted", canEdit: false, organizer: { name: "Sam Lee", email: "sam.lee@gmail.com" },
      attendees: guests("sam.lee@gmail.com", "accepted"),
    }),
    ev(me, "Planning", 4, 14, 15.5, {
      myResponse: "tentative", canEdit: false, organizer: { name: "Sam Lee", email: "sam.lee@gmail.com" },
      attendees: guests("sam.lee@gmail.com", "tentative"),
    }),
    ev(me, "Skipped: Book club", 2, 19, 20.5, {
      myResponse: "declined", canEdit: false, organizer: { name: "Sam Lee", email: "sam.lee@gmail.com" },
      attendees: guests("sam.lee@gmail.com", "declined"),
    }),
    ev("a1:gym", "Run", -1, 7, 8),
    ev(me, "Call the bank", -1, 15, 15.5),
    allDay("a1:en.singapore#holiday", "Deepavali", 1),
    allDay(me, "London trip", 3, 4, { location: "London" }),
    allDay("a1:birthdays", "Priya's birthday", 5),
  ];
  // A weekly class, to show a recurring event.
  for (let w = -2; w <= 6; w++) {
    list.push(ev("a1:gym", "Yoga", w * 7 + 2, 7.5, 8.5, { id: `yoga-${w}`, recurringEventId: "yoga", location: "Yoga Movement" }));
  }
  return list;
})();

const isoDay = (t: number) => {
  const x = new Date(t);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

/** Series rules by recurringEventId, as Google would return them. */
const mockSeries: Record<string, SeriesInfo> = (() => {
  const first = mockEvents.find((e) => e.recurringEventId === "yoga")!;
  const code = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(first.start).getDay()];
  return { yoga: { rules: [`RRULE:FREQ=WEEKLY;BYDAY=${code}`], startDate: isoDay(first.start) } };
})();

const delay =<T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const find = (id: unknown) => messages.find((x) => x.id === id);
  switch (cmd) {
    case "get_config":
      return delay(config) as Promise<T>;
    case "save_config":
      config = { ...(args.config as Config), tasks: config.tasks, displayName: config.displayName, calendar: config.calendar };
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
      const list = matching(args.query as ListQuery).map(
        ({ bodyHtml: _b, bodyText: _t, attachments: _a, ...summary }) => summary,
      );
      return delay(list, 60) as Promise<T>;
    }
    case "list_sender_groups":
      return delay(mockSenderGroups(matching(args.query as ListQuery)), 60) as Promise<T>;
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
      return delay(args.id as string) as Promise<T>;
    case "send_message": {
      const out = args.message as OutgoingMessage;
      console.info("[mock] would send", out);
      return delay(undefined, 400) as Promise<T>;
    }
    case "download_attachment":
      return delay("C:\\Users\\you\\Downloads\\invoice-1042.pdf") as Promise<T>;
    case "sync_now":
      return delay(accounts.map((a) => ({ accountId: a.id, newMessages: 0, error: null })), 600) as Promise<T>;
    case "list_calendars":
      return delay(mockCalendars()) as Promise<T>;
    case "list_calendar_events": {
      const shown = new Set(mockCalendars().filter((c) => !c.hidden).map((c) => c.id));
      const list = mockEvents.filter((e) => shown.has(e.calendarId) && e.end > (args.from as number) && e.start < (args.to as number));
      return delay(list, 60) as Promise<T>;
    }
    case "save_calendar_config":
      config = { ...config, calendar: args.calendar as CalendarConfig };
      return delay(mockCalendars(), 40) as Promise<T>;
    case "search_places": {
      const q = (args.query as string).toLowerCase();
      const places = [
        { name: "Lighthouse Climbing", detail: "44 Pasir Panjang Road, Singapore", lat: 1.2748, lon: 103.7944 },
        { name: "Boulder Planet", detail: "Sembawang Road, Singapore", lat: 1.4491, lon: 103.8185 },
        { name: "Tiong Bahru Bakery", detail: "56 Eng Hoon Street, Singapore", lat: 1.2847, lon: 103.8317 },
        { name: "Burnt Ends", detail: "7 Dempsey Road, Singapore", lat: 1.3051, lon: 103.8128 },
        { name: "Raffles Medical", detail: "Holland Village, Singapore", lat: 1.3112, lon: 103.7958 },
      ];
      const hits = q.length < 3 ? [] : places.filter((p) => `${p.name} ${p.detail}`.toLowerCase().includes(q));
      return delay(hits.map((p) => ({ ...p, label: `${p.name}, ${p.detail}` })), 150) as Promise<T>;
    }
    case "sync_calendars":
      mockFeeds.forEach((f) => (f.lastSync = Date.now()));
      return delay(undefined, 700) as Promise<T>;
    case "add_calendar_feed": {
      const raw = (args.url as string).trim().replace(/^webcals?:\/\//i, "https://");
      await delay(undefined, 800);
      if (raw.startsWith("http://")) return Promise.reject("Use the https:// address, so the calendar's private address isn't sent unencrypted.");
      if (!/^https:\/\/\S+$/.test(raw)) return Promise.reject("That isn't a web address. Paste the full address, starting with https://.");
      if (!/\.ics(\?|$)/.test(raw)) {
        return Promise.reject("That address didn't return a calendar. Copy the \"Secret address in iCal format\" from Google Calendar's settings.");
      }
      const id = `feed:${Date.now()}`;
      const name = (args.name as string).trim() || "me@work.com";
      mockFeeds.push({ id, name, color: FEED_COLORS[mockFeeds.length % FEED_COLORS.length]!, lastSync: Date.now() });
      mockEvents.push(...mockFeedEvents(id));
      return delay(mockCalendars(), 0) as Promise<T>;
    }
    case "update_calendar_feed": {
      const f = mockFeeds.find((x) => x.id === args.id)!;
      if (args.url) await delay(undefined, 800);
      if ((args.name as string).trim()) f.name = (args.name as string).trim();
      return delay(mockCalendars(), 40) as Promise<T>;
    }
    case "remove_calendar_feed": {
      const id = args.id as string;
      mockFeeds.splice(mockFeeds.findIndex((x) => x.id === id), 1);
      for (let i = mockEvents.length - 1; i >= 0; i--) if (mockEvents[i]!.calendarId === id) mockEvents.splice(i, 1);
      const colors = { ...config.calendar.colors };
      delete colors[id];
      config = { ...config, calendar: { ...config.calendar, hidden: config.calendar.hidden.filter((x) => x !== id), colors } };
      return delay(mockCalendars(), 40) as Promise<T>;
    }
    case "grant_calendar_access": {
      const a = accounts.find((x) => x.id === args.id)!;
      await delay(undefined, 900);
      a.calendarAccess = true;
      a.calendarSync = Date.now();
      if (!mockCals.some((c) => c.accountId === a.id)) {
        mockCals.push(
          { id: `${a.id}:${a.email}`, accountId: a.id, name: a.email, googleColor: "#9a9cff", accessRole: "owner", isPrimary: true },
          { id: `${a.id}:team`, accountId: a.id, name: "Studio team", googleColor: "#fad165", accessRole: "reader", isPrimary: false },
        );
      }
      return delay(a) as Promise<T>;
    }
    case "create_calendar_event": {
      const input = args.event as NewEvent;
      const t = input.times;
      const start = t.allDay ? new Date(`${t.startDate}T00:00`).getTime() : t.start;
      const end = t.allDay ? new Date(`${t.endDate}T00:00`).getTime() : t.end;
      console.info("[mock] create event, notify guests:", args.notify, input);
      const newId = `new-${Date.now()}`;
      if (input.recurrence) mockSeries[newId] = { rules: [input.recurrence], startDate: isoDay(start) };
      mockEvents.push({
        id: `${input.calendarId}:${newId}`, calendarId: input.calendarId, accountId: input.calendarId.split(":")[0]!,
        remoteId: newId, recurringEventId: input.recurrence ? newId : null, icalUid: "", title: input.title.trim() || "(No title)",
        location: input.location, description: "", start, end, allDay: t.allDay, startDate: t.startDate, endDate: t.endDate,
        status: "confirmed", myResponse: null, organizer: null, htmlLink: "", meetLink: null, canEdit: true,
        attendees: input.attendees.map((email) => ({ email, name: "", response: "needsAction", optional: false, organizer: false, isYou: false })),
      });
      return delay(undefined, 500) as Promise<T>;
    }
    case "update_calendar_event": {
      const e = mockEvents.find((x) => x.id === args.id);
      if (!e) return Promise.reject("That item no longer exists.");
      const c = args.changes as EventChanges;
      const series = (args.scope as EditScope) === "all" && e.recurringEventId
        ? mockEvents.filter((x) => x.recurringEventId === e.recurringEventId)
        : [e];
      console.info("[mock] update event", args.scope, "notify guests:", args.notify, c);
      if (c.times && series.length > 1 && new Date(c.times.start).toDateString() !== new Date(e.start).toDateString()) {
        return Promise.reject("Relay can't move every event in a series to another day yet. Move just this one here, or change the series in Google Calendar.");
      }
      if (c.repeat !== undefined) {
        const sid = e.recurringEventId;
        if (sid && c.repeat === "") {
          // The series becomes this one event.
          for (let i = mockEvents.length - 1; i >= 0; i--) {
            if (mockEvents[i] !== e && mockEvents[i]!.recurringEventId === sid) mockEvents.splice(i, 1);
          }
          e.recurringEventId = null;
          delete mockSeries[sid];
        } else if (sid) {
          mockSeries[sid] = { ...mockSeries[sid]!, rules: [c.repeat] };
        } else if (c.repeat) {
          e.recurringEventId = e.remoteId;
          mockSeries[e.remoteId] = { rules: [c.repeat], startDate: isoDay(e.start) };
        }
      }
      const ds = c.times ? c.times.start - e.start : 0;
      const de = c.times ? c.times.end - e.end : 0;
      for (const x of series) {
        if (c.title !== undefined) x.title = c.title.trim() || "(No title)";
        if (c.location !== undefined) x.location = c.location;
        if (c.calendarId) x.calendarId = c.calendarId;
        if (c.attendees) {
          const keep = x.attendees.filter((a) => a.isYou || a.organizer || c.attendees!.includes(a.email));
          for (const email of c.attendees) {
            if (!keep.some((a) => a.email === email)) keep.push({ email, name: "", response: "needsAction", optional: false, organizer: false, isYou: false });
          }
          x.attendees = keep;
        }
        if (c.times && x === e) {
          Object.assign(x, c.times);
          if (c.times.allDay) {
            x.start = new Date(`${c.times.startDate}T00:00`).getTime();
            x.end = new Date(`${c.times.endDate}T00:00`).getTime();
          }
        } else if (c.times) {
          x.start += ds;
          x.end += de;
        }
      }
      return delay(undefined, 500) as Promise<T>;
    }
    case "delete_calendar_event": {
      const e = mockEvents.find((x) => x.id === args.id);
      console.info("[mock] delete event", args.scope, "notify guests:", args.notify);
      for (let i = mockEvents.length - 1; i >= 0; i--) {
        const x = mockEvents[i]!;
        if (x === e || ((args.scope as EditScope) === "all" && e?.recurringEventId && x.recurringEventId === e.recurringEventId)) mockEvents.splice(i, 1);
      }
      return delay(undefined, 400) as Promise<T>;
    }
    case "calendar_event_series": {
      const e = mockEvents.find((x) => x.id === args.id);
      return delay(e?.recurringEventId ? (mockSeries[e.recurringEventId] ?? null) : null, 300) as Promise<T>;
    }
    case "rsvp_calendar_event": {
      const e = mockEvents.find((x) => x.id === args.id);
      if (!e?.attendees.some((a) => a.isYou)) return Promise.reject("You're not on this event's guest list, so there's nothing to reply to.");
      e.myResponse = args.response as CalendarEvent["myResponse"];
      e.attendees = e.attendees.map((a) => (a.isYou ? { ...a, response: args.response as Attendee["response"] } : a));
      return delay(undefined, 400) as Promise<T>;
    }
    case "cancel_sign_in":
      return delay(undefined) as Promise<T>;
    default:
      if (cmd.startsWith("telegram_")) return mockTelegram<T>(cmd, args);
      return Promise.reject(`mock: unknown command ${cmd}`);
  }
}
