import { useEffect, useRef, useState } from "react";

/** Type a section's name: Return keeps it, Escape leaves the old one, leaving the field keeps what was typed. */
export function SectionNameInput({ name, onDone, creating = false }: { creating?: boolean; name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  // After a menu that opened it has put the focus back where it was.
  useEffect(() => {
    const timer = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <> <input
      ref={ref}
      value={value}
      placeholder="Section name"
      maxLength={60}
      aria-label="Section name"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      className="h-6 min-w-0 flex-1 rounded-sm bg-well px-1.5 text-[12px] outline-none focus:ring-2 focus:ring-ring/40"
      data-testid="cloud-section-name-input"
    />{creating && <span className="shrink-0 text-[10px] text-faint">↵ create</span>}</>
  );
}
