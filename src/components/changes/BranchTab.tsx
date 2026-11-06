import { useEffect, useRef, useState, type ComponentProps } from "react";
import { BranchPanel } from "./BranchPanel";
import { PrPanel } from "./PrPanel";

/**
 * Where the work stands, in one scroll: the branch, the one thing to do next,
 * its pull request, then its line of commits. The branch's own step (pull,
 * commit, push…) comes first; the pull request's (open one, mark ready,
 * merge) is offered only once the branch has none. A cloud workspace has no
 * branch picture (it reads this computer's checkout), so only its pull request.
 * `focusPr` grows each time the pull request is asked for, and scrolls to it.
 */
export function BranchTab({ branch, pr, focusPr = 0 }: {
  branch: Omit<ComponentProps<typeof BranchPanel>, "onStep" | "inline" | "children"> | null;
  pr: Omit<ComponentProps<typeof PrPanel>, "inline" | "held">;
  focusPr?: number;
}) {
  const prSection = useRef<HTMLElement>(null);
  const [held, setHeld] = useState(true);
  useEffect(() => {
    if (focusPr) prSection.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusPr]);
  const section = (
    <section ref={prSection} data-testid="branch-pull-request">
      <PrPanel {...pr} inline held={branch ? held : false} />
    </section>
  );
  return (
    <div className="h-full overflow-y-auto scrollbar-thin" data-testid="branch-tab">
      {branch ? (
        <BranchPanel {...branch} inline onStep={setHeld}>
          {section}
        </BranchPanel>
      ) : (
        section
      )}
    </div>
  );
}
