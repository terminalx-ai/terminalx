import { useId } from "react";

/** A presentation contract. The share owner supplies the user's answered policy before wiring Save. */
export type EveryonePolicy = { defaultRole: "viewer" | "driver"; write: "require-approvals" | "warn" };
export type GeneralAccessRole = "viewer" | "driver" | null;

/** Prepared for PRO-167; not connected to a permission-changing API while the policy is unanswered. */
export function CloudGeneralAccess({ orgName, value, policy, allTabsRequireApproval, disabled, onChange }: {
  orgName: string;
  value: GeneralAccessRole;
  policy: EveryonePolicy | null;
  allTabsRequireApproval: boolean | null;
  disabled: boolean;
  onChange: (role: GeneralAccessRole) => void;
}) {
  const warningId = useId();
  const held = disabled || policy === null;
  const writeBlocked = policy?.write === "require-approvals" && allTabsRequireApproval !== true;
  return (
    <fieldset disabled={held} className="flex flex-col gap-2 border-t border-hairline pt-3">
      <legend className="text-sm font-medium">General access</legend>
      <label className="flex flex-wrap items-center gap-2 text-xs">
        Who can open this workspace
        <select
          aria-label="General access"
          className="rounded-md border border-hairline bg-transparent px-2 py-1"
          value={value === null ? "invited" : "everyone"}
          onChange={(event) => {
            if (!held && policy) onChange(event.target.value === "invited" ? null : policy.defaultRole);
          }}
        >
          <option value="invited">Only people invited</option>
          <option value="everyone">Everyone at {orgName}</option>
        </select>
      </label>
      {value !== null && (
        <label className="flex flex-wrap items-center gap-2 text-xs">
          Everyone can
          <select
            aria-label="Everyone access level"
            aria-describedby={warningId}
            className="rounded-md border border-hairline bg-transparent px-2 py-1"
            value={value}
            onChange={(event) => {
              if (held || (event.target.value === "driver" && writeBlocked)) return;
              onChange(event.target.value === "driver" ? "driver" : "viewer");
            }}
          >
            <option value="viewer">Read</option>
            <option value="driver" disabled={writeBlocked}>Write</option>
          </select>
        </label>
      )}
      <div id={warningId} className="text-xs text-muted-foreground">
        {value !== null && writeBlocked && <p>Write for everyone requires approval on every agent tab.</p>}
        {value === "driver" && allTabsRequireApproval !== true && (
          <p role="alert">Everyone at {orgName} will be able to run commands through agents here.</p>
        )}
      </div>
    </fieldset>
  );
}
