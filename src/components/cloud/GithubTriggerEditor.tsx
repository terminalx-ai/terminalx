import type { GithubAutomationRepository, GithubAutomationTrigger } from "@/lib/api";
import { Button } from "@/components/ui/button";

export const GITHUB_EVENTS = [
  { value: "opened", label: "PR opened" },
  { value: "synchronize", label: "PR updated (new commits)" },
  { value: "merged", label: "PR merged" },
  { value: "push", label: "Branch pushed" },
] as const;
const inputClass = "rounded-md border border-hairline bg-transparent px-2 py-1";

export function GithubTriggerEditor({ value, repositories, onChange }: { value: GithubAutomationTrigger; repositories: GithubAutomationRepository[]; onChange: (value: GithubAutomationTrigger) => void }) {
  return <fieldset className="flex flex-col gap-2" aria-label="GitHub event trigger">
    <label>Repository <select aria-label="GitHub repository" className={inputClass} value={value.repositoryId} onChange={(event) => onChange({ ...value, repositoryId: event.target.value })}>
      <option value="">Choose a connected repository</option>
      {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
    </select></label>
    {repositories.length === 0 && <p>Connect and select a repository in the organization’s GitHub App settings first.</p>}
    <div role="group" aria-label="GitHub events" className="flex flex-wrap gap-2">
      {GITHUB_EVENTS.map((event) => <label key={event.value} className="flex items-center gap-1"><input type="checkbox" checked={value.events.includes(event.value)} onChange={(e) => onChange({ ...value, events: e.target.checked ? [...value.events, event.value] : value.events.filter((item) => item !== event.value) })} />{event.label}</label>)}
    </div>
    <p>All filters must match. Author means the PR author, or the GitHub sender for a branch push. Base branch means the PR target, or the pushed branch. Label filters exclude branch pushes for both operators because pushes have no PR labels. Names are exact; author names ignore case.</p>
    {value.filters.map((filter, index) => <div key={index} className="flex flex-wrap gap-1">
      <select aria-label={`Filter ${index + 1} field`} className={inputClass} value={filter.field} onChange={(e) => onChange({ ...value, filters: value.filters.map((item, at) => at === index ? { ...item, field: e.target.value as typeof filter.field } : item) })}>
        <option value="label">Label</option><option value="author">Author</option><option value="baseBranch">Base branch</option>
      </select>
      <select aria-label={`Filter ${index + 1} operator`} className={inputClass} value={filter.operator} onChange={(e) => onChange({ ...value, filters: value.filters.map((item, at) => at === index ? { ...item, operator: e.target.value as typeof filter.operator } : item) })}>
        <option value="is">is</option><option value="is-not">is not</option>
      </select>
      <input aria-label={`Filter ${index + 1} value`} className={inputClass} value={filter.value} maxLength={255} onChange={(e) => onChange({ ...value, filters: value.filters.map((item, at) => at === index ? { ...item, value: e.target.value } : item) })} />
      <Button type="button" size="xs" variant="ghost" aria-label={`Remove filter ${index + 1}`} onClick={() => onChange({ ...value, filters: value.filters.filter((_, at) => at !== index) })}>Remove</Button>
    </div>)}
    <Button type="button" size="xs" variant="outline" disabled={value.filters.length >= 12} onClick={() => onChange({ ...value, filters: [...value.filters, { field: "label", operator: "is", value: "" }] })}>Add filter</Button>
    <p role="note">GitHub App installers may need to approve updated repository access before events arrive. An owner should review GitHub’s permission request and the App’s Pull request and Push subscriptions. Saving this task does not approve that request.</p>
  </fieldset>;
}
