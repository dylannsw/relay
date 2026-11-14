import { IconSearch } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/**
 * A search box at the top of a list: a grey field with a magnifier, no border until it has focus.
 * Escape clears it (and is only passed on once it's empty, so it doesn't also close what's around it).
 */
export function SearchField({
  value,
  onValueChange,
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "value" | "onChange"> & { value: string; onValueChange: (value: string) => void }) {
  return (
    <label
      data-slot="search-field"
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg border border-transparent bg-muted px-2.5 text-sm text-muted-foreground transition-[border-color] focus-within:border-field-focus",
        className,
      )}
    >
      <IconSearch className="size-4 shrink-0" />
      <input
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onValueChange("");
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        {...props}
      />
    </label>
  );
}
