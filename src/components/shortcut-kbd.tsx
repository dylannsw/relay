import { cn } from "@/lib/utils";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { bindingOf, keyParts, keyText, useShortcutBindings, type ShortcutId } from "@/shortcuts";

/**
 * The key for an action (follows the user's bindings), or a fixed key such as "Escape".
 * Renders nothing when the action has no key assigned.
 */
export function ShortcutKbd({ id, keys, className }: { id?: ShortcutId; keys?: string; className?: string }) {
  useShortcutBindings();
  const parts = keyParts(id ? bindingOf(id) : (keys ?? ""));
  if (!parts.length) return null;
  return (
    <KbdGroup className={className}>
      {parts.map((p, i) => (
        <Kbd key={i}>{p}</Kbd>
      ))}
    </KbdGroup>
  );
}

/** Plain-text version for menus (e.g. "Ctrl K"); empty when unassigned. */
export function ShortcutText({ id, className }: { id: ShortcutId; className?: string }) {
  useShortcutBindings();
  const text = keyText(bindingOf(id));
  return text ? <span className={cn(className)}>{text}</span> : null;
}
