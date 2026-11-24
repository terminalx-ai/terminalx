import type { Fact } from "../../../ui/FactRows";
import type { Review } from "./flow";
import { repositoryName } from "./repository";
import { AGENT_LOGINS, idleValue, loginName, quotedSize } from "./words";

/** The review's facts: the whole configuration as the quote priced it. */
export function reviewFacts(review: Review): Fact[] {
  const { configuration } = review.quote;
  const repository = review.setup.repositories?.[0];
  const repositoryFact = repository ? [repositoryName(repository.cloneUrl) ?? repository.cloneUrl, repository.ref].filter(Boolean).join(" · ") : null;
  const agents = review.setup.credentialIds
    .map((id) => review.facts.credentials.find((credential) => credential.id === id)?.provider)
    .filter((provider): provider is string => !!provider && AGENT_LOGINS.includes(provider))
    .map(loginName);
  return [
    { label: "Name", value: review.draft.name.trim() },
    { label: "Provider", value: review.facts.provider.descriptor.label },
    { label: "Size", value: quotedSize(configuration) },
    { label: "Region", value: configuration.locationLabel },
    { label: "Stops when idle", value: idleValue(configuration.idleSuspendMinutes) },
    ...(repositoryFact ? [{ label: "Repository", value: repositoryFact }] : []),
    ...(agents.length ? [{ label: "Agents", value: agents.join(", ") }] : []),
  ];
}
