import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const chipClass = "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-hairline bg-well px-1.5 py-0.5 text-[11px] font-medium text-foreground";

/** A label only: plans and access descriptions confer no authority. Keep state in words. */
export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={cn(chipClass, "break-words", className)} />;
}

/** A chip with native button semantics; usable asChild with PopoverTrigger. */
export const ChipButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(({ className, type = "button", ...props }, ref) => (
  <button ref={ref} type={type} {...props} className={cn(chipClass, "min-h-6 cursor-default hover:bg-veil-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50 disabled:cursor-default", className)} />
));
ChipButton.displayName = "ChipButton";
