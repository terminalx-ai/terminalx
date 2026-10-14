import { Button } from "@/components/ui/button";
import { mentionsAgentLogins } from "@/lib/cloudCreate";
import { openAgentLogins } from "@/lib/settingsLinks";

/** The way to Settings → Account → Agent logins, next to a message that names it; nothing for any other message. */
export function AgentLoginsLink({ message, className }: { message: string | null | undefined; className?: string }) {
  if (!mentionsAgentLogins(message)) return null;
  return (
    <Button type="button" size="xs" variant="outline" className={className} data-testid="open-agent-logins" onClick={openAgentLogins}>
      Open Agent logins
    </Button>
  );
}
