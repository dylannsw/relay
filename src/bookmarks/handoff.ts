import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, isTauri } from "@/api";

export function useBookmarkHandoffs() {
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let draining = false;
    let signalled = false;

    async function drain() {
      if (!active) return;
      signalled = true;
      if (draining) return;
      draining = true;
      try {
        do {
          signalled = false;
          const batch = await api.takeBookmarkHandoffs();
          if (!active) return;
          if (batch.some((item) => item.kind === "invalid")) {
            toast.error("That bookmark link is invalid.");
          }
          const received = batch.flatMap((item) => item.kind === "open" ? [item.url] : []);
          if (received.length) setUrls((current) => Array.from(new Set([...current, ...received])).slice(0, 16));
        } while (signalled && active);
      } catch {
        if (active) toast.error("Relay couldn’t read the bookmark link.");
      } finally {
        draining = false;
      }
    }

    // Subscribe first so launches between startup and the initial drain aren't lost.
    const listening = api.onBookmarkHandoffQueued(() => void drain());
    void listening.then(() => drain(), () => drain());
    return () => {
      active = false;
      void listening.then((unlisten) => unlisten(), () => {});
    };
  }, []);

  return { url: urls[0], close: () => setUrls((current) => current.slice(1)) };
}
