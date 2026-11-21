type TextField = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

type CaretPosition = {
  x: number;
  y: number;
  height: number;
  fieldX: number;
  fieldY: number;
  scrollX: number;
  scrollY: number;
};

const textInputTypes = new Set(["text", "search", "tel", "url", "password"]);
const textStyles = [
  "font-family", "font-size", "font-style", "font-weight", "font-stretch",
  "font-kerning", "font-feature-settings", "font-variation-settings", "font-variant-numeric",
  "letter-spacing", "line-height", "text-indent", "text-align", "text-transform",
  "direction", "tab-size", "word-spacing",
];

// Sample the Zen caret's 70 ms exponential glide for a finite animation.
const glideDuration = 280;
const glideEasing = `linear(${Array.from({ length: 15 }, (_, index) => {
  const elapsed = glideDuration * index / 14;
  return (1 - Math.exp(-elapsed / 70)) / (1 - Math.exp(-glideDuration / 70));
}).join(", ")})`;

export function initCaretGlide() {
  if (!CSS.supports("animation-timing-function", glideEasing)) return;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const mirror = document.createElement("div");
  const caret = document.createElement("div");
  const text = document.createTextNode("");
  const range = document.createRange();
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;overflow:hidden";
  mirror.append(text);
  caret.setAttribute("aria-hidden", "true");
  caret.style.cssText = "position:fixed;top:0;left:0;width:1px;pointer-events:none;z-index:2147483647";
  caret.hidden = true;
  document.body.append(mirror, caret);

  let field: TextField | null = null;
  let previous: CaretPosition | null = null;
  let animation: Animation | null = null;
  let frame = 0;
  let composing = false;

  function stopGlide() {
    animation?.cancel();
    animation = null;
    caret.hidden = true;
    field?.removeAttribute("data-caret-gliding");
  }

  function reset() {
    stopGlide();
    previous = null;
    text.data = "";
  }

  /** A contenteditable box (one that opts in with data-fast-caret-glide): the caret's place comes from the selection. */
  function measureEditable(box: HTMLElement): CaretPosition | null {
    const sel = getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed || !box.contains(sel.anchorNode)) return null;
    const rect = sel.getRangeAt(0).getClientRects()[0];
    // A caret on an empty line has no rectangle of its own; the native caret does that one.
    if (!rect?.height) return null;
    const hit = document.elementFromPoint(rect.left, rect.top + rect.height / 2);
    if (!hit || !box.contains(hit)) return null;
    const box_ = box.getBoundingClientRect();
    return { x: rect.left, y: rect.top, height: rect.height, fieldX: box_.left, fieldY: box_.top, scrollX: box.scrollLeft, scrollY: box.scrollTop };
  }

  function measure(input: TextField): CaretPosition | null {
    if (input.isContentEditable) return measureEditable(input);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return null;
    const offset = input.selectionStart;
    if (offset === null || offset !== input.selectionEnd || input.readOnly || input.disabled) return null;

    const multiline = input instanceof HTMLTextAreaElement;
    const style = getComputedStyle(input);
    const box = input.getBoundingClientRect();
    const scaleX = box.width / input.offsetWidth;
    const scaleY = box.height / input.offsetHeight;
    if (!scaleX || !scaleY || style.visibility !== "visible") return null;

    const paddingLeft = parseFloat(style.paddingLeft);
    const left = parseFloat(style.borderLeftWidth) + paddingLeft;
    const top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const bottom = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
    for (const property of textStyles) {
      mirror.style.setProperty(property, style.getPropertyValue(property));
    }
    mirror.style.width = `${input.clientWidth - paddingLeft - parseFloat(style.paddingRight)}px`;
    mirror.style.whiteSpace = multiline && input.wrap !== "off" ? "pre-wrap" : "pre";
    mirror.style.overflowWrap = multiline && input.wrap !== "off" ? "break-word" : "normal";

    // Match Chromium's mask glyph without copying the password into another node.
    const password = input instanceof HTMLInputElement && input.type === "password";
    const value = password ? "x".repeat(input.value.length) : input.value;
    mirror.style.setProperty("-webkit-text-security", password ? "disc" : "none");
    text.data = value === "" || value.endsWith("\n") ? value + "\u200b" : value;
    range.setStart(text, offset);
    range.collapse(true);
    const rect = range.getClientRects()[0];
    if (!rect?.height) return null;

    const x = box.left + (left + rect.left - input.scrollLeft) * scaleX;
    const height = rect.height * scaleY;
    const y = multiline
      ? box.top + (top + rect.top - input.scrollTop) * scaleY
      : box.top + (box.height + (top - bottom) * scaleY - height) / 2;
    // The native caret already handles clipping inside scrollable or covered fields.
    if (document.elementFromPoint(x, y + height / 2) !== input) return null;

    return { x, y, height, fieldX: box.left, fieldY: box.top, scrollX: input.scrollLeft, scrollY: input.scrollTop };
  }

  function update() {
    frame = 0;
    if (!field || field !== document.activeElement || reducedMotion.matches || composing) {
      reset();
      return;
    }

    const from = previous;
    const to = measure(field);
    previous = to;
    if (!from || !to || from.fieldX !== to.fieldX || from.fieldY !== to.fieldY ||
      from.scrollX !== to.scrollX || from.scrollY !== to.scrollY) {
      stopGlide();
      return;
    }
    if (from.x === to.x && from.y === to.y) return;

    // Retarget from the visible position when another keystroke interrupts a glide.
    const current = animation ? caret.getBoundingClientRect() : from;
    stopGlide();
    caret.style.height = `${to.height}px`;
    caret.style.backgroundColor = getComputedStyle(field).color;
    caret.style.transform = `translate(${to.x}px, ${to.y}px)`;
    caret.hidden = false;
    field.setAttribute("data-caret-gliding", "");
    const glide = caret.animate(
      { transform: [`translate(${current.x}px, ${current.y}px)`, caret.style.transform] },
      { duration: field.hasAttribute("data-fast-caret-glide") ? 110 : glideDuration, easing: glideEasing },
    );
    animation = glide;
    glide.onfinish = () => {
      if (animation === glide) stopGlide();
    };
  }

  function schedule() {
    if (field && !frame && !reducedMotion.matches) frame = requestAnimationFrame(update);
  }

  function resync() {
    reset();
    schedule();
  }

  document.addEventListener("focusin", ({ target }) => {
    reset();
    composing = false;
    field = target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && textInputTypes.has(target.type)) ||
      (target instanceof HTMLElement && target.isContentEditable && target.hasAttribute("data-fast-caret-glide")) ? target : null;
    schedule();
  });
  document.addEventListener("focusout", () => {
    reset();
    field = null;
  });
  for (const event of ["input", "keydown", "selectionchange"]) {
    document.addEventListener(event, schedule, true);
  }
  document.addEventListener("pointerdown", resync, true);
  document.addEventListener("scroll", resync, true);
  document.addEventListener("compositionstart", () => {
    composing = true;
    reset();
  });
  document.addEventListener("compositionend", () => {
    composing = false;
    resync();
  });
  window.addEventListener("blur", reset);
  window.addEventListener("focus", schedule);
  window.addEventListener("resize", resync);
  reducedMotion.addEventListener("change", resync);
}
