import type { CloudScheduleGithubTrigger, CloudSelectedRepository } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { githubTriggerError } from "@/lib/cloudSchedules";

const inputClass = "rounded-md border border-hairline bg-transparent px-2 py-1";
export function GithubTriggerEditor({ value, repositories, onChange }: {
  value: CloudScheduleGithubTrigger;
  repositories: CloudSelectedRepository[];
  onChange: (value: CloudScheduleGithubTrigger) => void;
}) {
  const error = githubTriggerError(value, repositories);
  return <fieldset className="flex flex-col gap-2" aria-label="GitHub event trigger">
    <label>Repository <select aria-label="GitHub repository" className={inputClass} value={value.repositoryId} onChange={(e) => onChange({ ...value, repositoryId: e.target.value })}>
      <option value="">Choose a selected repository</option>
      {repositories.map((repo, index) => <option key={repo.id ?? `${repo.fullName}:${index}`} value={repo.id ?? ""} disabled={repo.state !== "accessible" || !repo.id}>{repo.fullName}{!repo.id ? " (repository ID unavailable)" : repo.state !== "accessible" ? " (unavailable)" : ""}</option>)}
    </select></label>
    <label>Event <select aria-label="GitHub event" className={inputClass} value={value.event} onChange={(e) => onChange({ ...value, event: e.target.value as CloudScheduleGithubTrigger["event"] })}>
      <option value="opened">PR opened</option><option value="pushed">PR or branch pushed</option><option value="merged">PR merged</option>
    </select></label>
    <p>All filters must match (up to five). Label and author ignore case; base branch matches exactly. Author means PR author or push sender. Base branch means PR target or pushed branch. Both label operators exclude pushes because pushes have no PR labels.</p>
    {value.filters.map((filter, index) => <div key={index} className="flex flex-wrap gap-1">
      <select aria-label={`Filter ${index + 1} field`} className={inputClass} value={filter.field} onChange={(e) => onChange({ ...value, filters: value.filters.map((item, at) => at === index ? { ...item, field: e.target.value as typeof filter.field } : item) })}>
        <option value="label">Label</option><option value="author">Author</option><option value="baseBranch">Base branch</option>
      </select>
      <select aria-label={`Filter ${index + 1} operator`} className={inputClass} value={filter.operator} onChange={(e) => onChange({ ...value, filters: value.filters.map((item, at) => at === index ? { ...item, operator: e.target.value as typeof filter.operator } : item) })}>
        <option value="is">is</option><option value="is-not">is not</option>
      </select>
      <input aria-label={`Filter ${index + 1} value`} className={inputClass} maxLength={255} value={filter.value} onChange={(e) => onChange({ ...value, filters: value.filters.map((item, at) => at === index ? { ...item, value: e.target.value } : item) })} />
      <Button type="button" size="xs" variant="ghost" onClick={() => onChange({ ...value, filters: value.filters.filter((_, at) => at !== index) })}>Remove filter {index + 1}</Button>
    </div>)}
    <Button type="button" size="xs" variant="outline" disabled={value.filters.length >= 5} onClick={() => onChange({ ...value, filters: [...value.filters, { field: "label", operator: "is", value: "" }] })}>Add filter</Button>
    <label><input type="checkbox" checked={value.allowForkPullRequests ?? false} onChange={(e) => onChange({ ...value, allowForkPullRequests: e.target.checked })} /> Allow pull requests from forks</label>
    <p>Opting in lets untrusted fork PR metadata reach the agent under this automation's credentials and approval policy.</p>
    {error && <p role="status">{error}</p>}
    <p>GitHub App event access and real delivery still require operator acceptance. Saving an automation does not approve installation changes or enable delivery.</p>
  </fieldset>;
}
