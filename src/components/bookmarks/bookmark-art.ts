import { useEffect, useState } from "react";
import { api } from "@/api";
import type { BookmarkMedia } from "@/bookmarks/types";

export function useBookmarkStill(media: BookmarkMedia | undefined, enabled: boolean) {
  const path = enabled ? media?.mediaPath : null;
  const key = path ? `${path}:${media?.revision ?? ""}` : "";
  const [sample, setSample] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let active = true;
    let url: string | undefined;
    void api.sampleBookmarkImage(path).then((blob) => {
      if (!active) return;
      url = URL.createObjectURL(blob);
      setSample({ key, url });
    }, () => {});
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, key]);
  return sample?.key === key ? sample.url : undefined;
}

export function useBookmarkSwatches(still: string | undefined) {
  const [sample, setSample] = useState<{ url: string; colors: string[] } | null>(null);
  useEffect(() => {
    if (!still) return;
    const image = new Image();
    image.onload = () => {
      const size = 36;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, size, size);
      const pixels = context.getImageData(0, 0, size, size).data;
      const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3]! < 200) continue;
        const r = pixels[index]!, g = pixels[index + 1]!, b = pixels[index + 2]!;
        const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
        const bin = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
        bin.count++; bin.r += r; bin.g += g; bin.b += b;
        buckets.set(key, bin);
      }
      const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0").toUpperCase();
      const colors = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 6)
        .map(({ count, r, g, b }) => `#${hex(r / count)}${hex(g / count)}${hex(b / count)}`);
      setSample({ url: still, colors });
    };
    image.src = still;
    return () => { image.onload = null; };
  }, [still]);
  return sample?.url === still ? sample?.colors ?? [] : [];
}
