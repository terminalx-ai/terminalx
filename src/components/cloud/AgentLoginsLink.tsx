import { Button } from "@/components/ui/button";
import { mentionsAgentLogins } from "@/lib/cloudCreate";
import { openAgentLogins } from "@/lib/settingsLinks";

/**
 * The way to an organization's Agent logins (Settings → Organizations, its
 * page), next to a message that names them; nothing for any other message.
 * `organizationId` is the organization the message is about (the workspace's
 * own, PRO-107); without one it opens the active organization's page.
 */
export function AgentLoginsLink({ message, organizationId, className }: { message: string | null | undefined; organizationId: string | null | undefined; className?: string }) {
  if (!mentionsAgentLogins(message)) return null;
  return (
    <Button type="button" size="xs" variant="outline" className={className} data-testid="open-agent-logins" onClick={() => openAgentLogins(organizationId ?? null)}>
      Open Agent logins
    </Button>
  );
}
