import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { Loader2 } from "@/icons";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * A step may hold the person back when they leave it (the Environment step
 * with unbuilt changes, 14.15). `leave` is called with what leaving would do;
 * it returns true to let it happen now, or false after it has taken the
 * action to run once the person confirms.
 */
export type LeaveGuard = (leave: () => void) => boolean;

export const LeaveGuardContext = createContext<(guard: LeaveGuard | null) => void>(() => undefined);

/** Hold every way out of the flow (another step, Finish later, Esc) while `guard` is set. */
export function useLeaveGuard(guard: LeaveGuard | null): void {
  const register = useContext(LeaveGuardContext);
  const latest = useRef(guard);
  latest.current = guard;
  const active = guard !== null;
  useEffect(() => {
    if (!active) return;
    register((leave) => latest.current?.(leave) ?? true);
    return () => register(null);
  }, [active, register]);
}

/** A step's page: its heading and copy, its body, and the column on the right (12.01–12.06). */
export function StepPage({
  eyebrow,
  title,
  description,
  aside,
  asideLabel,
  wide = false,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: ReactNode;
  aside?: ReactNode;
  /** The small capitals over the right column ("Preview · how your team appears"). */
  asideLabel?: string;
  /** The Environment step uses the whole width for its build panel (12.05). */
  wide?: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), [title]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-8 xl:flex-row xl:gap-[60px]", wide ? "max-w-[1100px]" : "max-w-[1020px]")}>
      <section className={cn("min-w-0 flex-1", wide ? "max-w-[640px]" : "max-w-[660px]")} aria-labelledby="cloud-setup-step-title">
        {eyebrow && <div className="text-[12.5px] text-muted-foreground">{eyebrow}</div>}
        <h1 id="cloud-setup-step-title" ref={heading} tabIndex={-1} className={cn("text-[26px] leading-8 font-semibold tracking-[-0.01em] outline-none", eyebrow && "mt-1")}>
          {title}
        </h1>
        <div className="mt-1.5 text-[13.5px] leading-[21px] text-muted-foreground">{description}</div>
        <div className="mt-7">{children}</div>
      </section>
      {aside && (
        <aside className={cn("min-w-0 shrink-0", wide ? "w-full xl:w-[440px] xl:pt-[60px]" : "w-full xl:w-[300px] xl:pt-[68px]")} aria-label={asideLabel}>
          {asideLabel && <div className="mb-3 text-[11px] font-medium tracking-[0.08em] text-faint uppercase">{asideLabel}</div>}
          {aside}
        </aside>
      )}
    </div>
  );
}

/** The step's main button: Enter presses it from anywhere in the step that is not a field or another control. */
export function PrimaryButton({ busy = false, children, className, ...props }: ButtonProps & { busy?: boolean }) {
  return (
    <Button data-cloud-setup-primary="" className={cn("h-9 px-3 text-[12.5px]", className)} {...props}>
      {busy && <Loader2 className="animate-spin" />}
      {children}
      <kbd aria-hidden className="ml-1 rounded border border-current/25 px-1 text-xs leading-4 opacity-70">
        ↵
      </kbd>
    </Button>
  );
}

/** The row under a step: its main button and a line about what it does. */
export function StepActions({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-3">
      {children}
      {note && <span className="text-[12.5px] text-muted-foreground">{note}</span>}
    </div>
  );
}

export function FieldLabel({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12.5px] font-medium">
      {children}
      {hint && <span className="font-normal text-muted-foreground"> · {hint}</span>}
    </label>
  );
}

export function StepError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-3 text-xs text-destructive">
      {children}
    </p>
  );
}
