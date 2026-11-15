import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Command as CommandPrimitive } from "cmdk";
import { IconSearch } from "@tabler/icons-react";
import { api, errorText } from "@/api";
import { Command, CommandEmpty, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { requestOpenChat, useTelegram } from "@/telegram/store";
import type { TgChat, TgMessage } from "@/telegram/types";
import { ChatAvatar } from "./chat-avatar";

const KIND: Partial<Record<TgChat["kind"], string>> = { group: "Group", bot: "Bot" };

/**
 * A small card under the message for picking where to forward it, as Telegram's Forward does:
 * choosing a chat sends it there straight away. Saved Messages comes first, then your chats by
 * latest activity. Channels are left out (most only let their admins post).
 */
export function ForwardPicker(props: {
  /** The message being forwarded, and its bubble to sit under; null when closed. */
  message: TgMessage | null;
  anchor: HTMLElement | null;
  fromChat: TgChat;
  onClose: () => void;
  /** It landed in `to`: the new messages there, for when that's the open chat. */
  onForwarded: (to: TgChat, messages: TgMessage[]) => void;
}) {
  const tg = useTelegram();
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const targets = useMemo(() => {
    const list = tg.chats.filter((c) => !c.archived && c.kind !== "channel");
    return [...list.filter((c) => c.kind === "saved"), ...list.filter((c) => c.kind !== "saved")];
  }, [tg.chats]);

  const forward = async (to: TgChat) => {
    const m = props.message;
    if (!m || busy) return;
    setBusy(to.id);
    try {
      const sent = await api.telegram.forward(props.fromChat.id, to.id, [m.id]);
      props.onForwarded(to, sent);
      setQuery("");
      props.onClose();
      toast.success(to.kind === "saved" ? "Saved to Saved Messages" : `Forwarded to ${to.name}`, {
        action: to.id === props.fromChat.id ? undefined : { label: "Open", onClick: () => requestOpenChat(to.id) },
      });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const open = !!props.message && !!props.anchor;
  // Lines up with the bubble's outer edge: the right for yours, the left for theirs.
  const align = props.message?.outgoing ? "end" : "start";

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o || busy) return;
        setQuery("");
        props.onClose();
      }}
    >
      {props.anchor && <PopoverAnchor virtualRef={{ current: props.anchor }} />}
      <PopoverContent
        side="bottom"
        align={align}
        sideOffset={6}
        collisionPadding={12}
        aria-label="Forward to"
        // 12px: the 8px search field and rows sit 4px in (12 = 8 + 4), so the corners are concentric.
        className="w-72 gap-0 overflow-hidden rounded-[0.75rem] p-0"
      >
        {/* Every word typed must appear in the name (cmdk's fuzzy match lets "dan" find "Admin"). */}
        <Command className="rounded-none! p-0" filter={(value, search) => (search.toLowerCase().split(/\s+/).every((w) => value.toLowerCase().includes(w)) ? 1 : 0)}>
          {/* Styled like the app's SearchField, but tinted from the text colour so it shows on the
              card in both themes (bg-muted is almost the card's own colour in dark mode). */}
          <div className="p-1 pb-0">
            <label className="flex h-8 w-full items-center gap-2 rounded-lg border border-transparent bg-tint-hover px-2.5 text-sm text-muted-foreground transition-[border-color] focus-within:border-field-focus">
              <IconSearch className="size-4 shrink-0" />
              <CommandPrimitive.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Forward to…"
                autoFocus
                // Escape clears the search first; once it's empty, it closes the card.
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
          </div>
          {/* Field and rows sit 4px in from the card; rows keep a 6px gap so two highlights never
              touch. 224px shows four rows and the top of a fifth, so it's clear the list scrolls. */}
          <CommandList className="max-h-56 p-1 pt-1.5 **:[[cmdk-list-sizer]]:flex **:[[cmdk-list-sizer]]:flex-col **:[[cmdk-list-sizer]]:gap-1.5">
            <CommandEmpty>No chats found.</CommandEmpty>
            {targets.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.name} ${c.id}`}
                disabled={!!busy && busy !== c.id}
                onSelect={() => void forward(c)}
                className="h-11 gap-2.5 rounded-lg px-2 data-selected:bg-tint-hover"
              >
                <ChatAvatar id={c.id} name={c.name} hasPhoto={c.hasPhoto} saved={c.kind === "saved"} size={28} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {(busy === c.id || KIND[c.kind]) && (
                  <CommandShortcut className="tracking-normal">{busy === c.id ? <Spinner /> : KIND[c.kind]}</CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
