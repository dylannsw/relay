import { useEffect, useRef, useState } from "react";
import { IconColorPicker } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ----- colour maths (h 0–360, s/v/l 0–1, r/g/b 0–255) -----

type Hsv = { h: number; s: number; v: number };

function hexToRgb(hex: string): [number, number, number] | null {
  let t = hex.trim().replace(/^#/, "");
  if (t.length === 3) t = [...t].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(t)) return null;
  const n = parseInt(t, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgbToHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1)];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const { h, s: sv, v } = rgbToHsv(r, g, b);
  const l = v * (1 - sv / 2);
  const s = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const v = l + s * Math.min(l, 1 - l);
  return hsvToRgb({ h, s: v ? 2 * (1 - l / v) : 0, v });
}

const hexToHsv = (hex: string): Hsv => {
  const rgb = hexToRgb(hex) ?? [158, 158, 158];
  return rgbToHsv(...rgb);
};

type Format = "hex" | "rgb" | "hsl";

/** The colour as the three (or one) editable fields of a format. */
function fieldsOf(hex: string, format: Format): string[] {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  if (format === "hex") return [hex.replace(/^#/, "").toUpperCase()];
  if (format === "rgb") return rgb.map((x) => String(Math.round(x)));
  const [h, s, l] = rgbToHsl(...rgb);
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)].map(String);
}

/** Fields back to a colour, or null while they don't make one. */
function fromFields(values: string[], format: Format): string | null {
  if (format === "hex") {
    const rgb = hexToRgb(values[0] ?? "");
    return rgb ? rgbToHex(...rgb) : null;
  }
  const n = values.map((v) => Number(v));
  if (n.length !== 3 || n.some((x) => !Number.isFinite(x) || x < 0)) return null;
  if (format === "rgb") return n.every((x) => x <= 255) ? rgbToHex(n[0]!, n[1]!, n[2]!) : null;
  if (n[0]! > 360 || n[1]! > 100 || n[2]! > 100) return null;
  return rgbToHex(...hslToRgb(n[0]!, n[1]! / 100, n[2]! / 100));
}

interface EyeDropperResult {
  sRGBHex: string;
}
const eyeDropper = (): (new () => { open: () => Promise<EyeDropperResult> }) | undefined =>
  (window as unknown as { EyeDropper?: new () => { open: () => Promise<EyeDropperResult> } }).EyeDropper;

// ----- the picker -----

/**
 * A colour swatch (a dot inside a ring) that opens a picker: a saturation/brightness square,
 * a hue slider, an eyedropper, HEX/RGB/HSL fields, and optional preset swatches. `onChange`
 * fires as the colour changes (also while dragging), so callers that save should debounce.
 */
export function ColorPicker({ value, onChange, label, presets, className }: {
  value: string;
  onChange: (hex: string) => void;
  label: string;
  presets?: string[];
  className?: string;
}) {
  // Hue and saturation are kept apart from the hex, so they don't jump when the colour turns grey or black.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [format, setFormat] = useState<Format>("hex");
  const [fields, setFields] = useState(() => fieldsOf(value, "hex"));
  const current = useRef(value);

  // A new value from outside (a reset, another device) moves the picker to it.
  useEffect(() => {
    if (value.toLowerCase() === current.current.toLowerCase()) return;
    current.current = value;
    setHsv(hexToHsv(value));
    setFields(fieldsOf(value, format));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (next: Hsv, keepFields = false) => {
    setHsv(next);
    const hex = rgbToHex(...hsvToRgb(next));
    current.current = hex;
    if (!keepFields) setFields(fieldsOf(hex, format));
    onChange(hex);
  };

  const setHex = (hex: string, keepFields = false) => {
    const rgb = hexToRgb(hex);
    if (rgb) emit(rgbToHsv(...rgb), keepFields);
  };

  const hex = rgbToHex(...hsvToRgb(hsv));
  const Dropper = eyeDropper();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full border bg-background p-[3px] transition-[border-color,box-shadow] duration-150 outline-none hover:border-foreground/25 focus-visible:ring-1 focus-visible:ring-ring aria-expanded:border-foreground/25",
            className,
          )}
        >
          <span className="size-full rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]" style={{ backgroundColor: value }} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col gap-3 p-3" align="start">
        <SaturationArea hsv={hsv} onChange={(s, v) => emit({ ...hsv, s, v })} />
        <HueSlider hue={hsv.h} onChange={(h) => emit({ ...hsv, h })} />
        <div className="flex items-center gap-2">
          {Dropper && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() =>
                    void new Dropper()
                      .open()
                      .then((r) => setHex(r.sRGBHex))
                      .catch(() => {})
                  }
                >
                  <IconColorPicker />
                  <span className="sr-only">Pick a colour from the screen</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pick from the screen</TooltipContent>
            </Tooltip>
          )}
          <Select
            value={format}
            onValueChange={(f) => {
              setFormat(f as Format);
              setFields(fieldsOf(hex, f as Format));
            }}
          >
            <SelectTrigger size="sm" className="w-[4.5rem] shrink-0" aria-label="Colour format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hex">HEX</SelectItem>
              <SelectItem value="rgb">RGB</SelectItem>
              <SelectItem value="hsl">HSL</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex min-w-0 flex-1 gap-1">
            {fields.map((v, i) => (
              <Input
                key={`${format}-${i}`}
                aria-label={format === "hex" ? "Hex" : format.toUpperCase()[i]}
                value={v}
                inputMode={format === "hex" ? "text" : "numeric"}
                onChange={(e) => {
                  const next = fields.map((x, j) => (j === i ? e.target.value : x));
                  setFields(next);
                  const c = fromFields(next, format);
                  if (c) setHex(c, true);
                }}
                onBlur={() => setFields(fieldsOf(hex, format))}
                className="h-7 min-w-0 px-1.5 text-center text-xs tabular-nums"
              />
            ))}
          </div>
        </div>
        {presets && presets.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t pt-3">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                aria-label={`Use ${p}`}
                onClick={() => setHex(p)}
                className={cn(
                  "size-5 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  p.toLowerCase() === hex.toLowerCase() && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-popover",
                )}
                style={{ backgroundColor: p }}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Drags on an element, reporting the pointer's position within it (0–1 each way). */
function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onMove(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  return {
    ref,
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      move(e);
    },
    onPointerMove: (e: React.PointerEvent) => e.currentTarget.hasPointerCapture(e.pointerId) && move(e),
  };
}

function SaturationArea({ hsv, onChange }: { hsv: Hsv; onChange: (s: number, v: number) => void }) {
  const drag = useDrag((x, y) => onChange(x, 1 - y));
  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    onChange(Math.min(1, Math.max(0, hsv.s + d[0]!)), Math.min(1, Math.max(0, hsv.v + d[1]!)));
  };
  return (
    <div
      {...drag}
      role="slider"
      tabIndex={0}
      aria-label="Saturation and brightness"
      aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
      onKeyDown={key}
      className="relative h-36 cursor-crosshair touch-none rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={{
        backgroundColor: `hsl(${hsv.h} 100% 50%)`,
        backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
      }}
    >
      <span
        className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]"
        style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
      />
    </div>
  );
}

function HueSlider({ hue, onChange }: { hue: number; onChange: (h: number) => void }) {
  const drag = useDrag((x) => onChange(Math.min(359.9, x * 360)));
  return (
    <div
      {...drag}
      role="slider"
      tabIndex={0}
      aria-label="Hue"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(hue)}
      onKeyDown={(e) => {
        const d = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
        if (!d) return;
        e.preventDefault();
        onChange((hue + d * (e.shiftKey ? 10 : 1) + 360) % 360);
      }}
      className="relative h-3 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
    >
      <span
        className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]"
        style={{ left: `${(hue / 360) * 100}%`, backgroundColor: `hsl(${hue} 100% 50%)` }}
      />
    </div>
  );
}
