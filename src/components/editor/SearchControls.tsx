import type { ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/** An icon that stays lit while its option is on: match case, regex, whole word. */
export function SearchToggle({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <WithTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          "rounded-md p-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          pressed ? "bg-veil-strong text-foreground" : "text-faint hover:text-foreground",
        )}
      >
        {children}
      </button>
    </WithTooltip>
  );
}

/** A checkbox drawn from the app's tokens; `mixed` when only some of a group is on. */
export function SearchCheck({ label, checked, onChange, className }: { label: string; checked: boolean | "mixed"; onChange: (next: boolean) => void; className?: string }) {
  const on = checked === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-label={label}
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        checked === false ? "border-hairline-strong bg-well hover:border-ring/50" : "border-transparent bg-accent text-accent-foreground",
        className,
      )}
    >
      {checked === "mixed" ? <Minus className="size-2.5" strokeWidth={3} /> : on ? <Check className="size-2.5" strokeWidth={3} /> : null}
    </button>
  );
}
