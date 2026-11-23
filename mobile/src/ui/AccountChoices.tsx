import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import type { NewSessionAgent } from "@mobile/data/host-api";
import { accountsOf, chosenAccount, type NewSessionChoices } from "@mobile/data/new-session";
import { Card, SectionTitle } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * The new-session form's Account section (#980): which of the agent's
 * accounts on the Mac the session starts on. Drawn only when the agent has
 * more than one; the project's default, then the agent's, is chosen until
 * the person picks another. Only ids and labels reach the phone.
 */
export function AccountChoices({ agent, choices, onChange }: { agent: NewSessionAgent | null; choices: NewSessionChoices; onChange(patch: Partial<NewSessionChoices>): void }) {
  const { palette } = useTheme();
  const accounts = accountsOf(agent);
  const shown = chosenAccount(choices, agent);
  if (!accounts || !shown || !agent) return null;
  const projectId = choices.where && "projectId" in choices.where ? choices.where.projectId : null;
  const note = (id: string) => (projectId && agent.projectDefaults?.[projectId] === id ? "This project's default" : agent.defaultAccount === id ? "Default" : undefined);
  return <>
    <SectionTitle>Account</SectionTitle>
    <Card style={styles.group}>
      {accounts.map((account) => {
        const selected = account.id === shown.id;
        const detail = note(account.id);
        return <Pressable key={account.id} accessibilityRole="button" accessibilityLabel={account.label} accessibilityHint={detail} accessibilityState={{ selected }}
          onPress={() => onChange({ account: account.id })} style={[styles.choice, { backgroundColor: selected ? palette.selected : palette.raised }]}>
          <View style={styles.flex}>
            <Text style={[styles.label, { color: palette.ink }]} numberOfLines={1}>{account.label}</Text>
            {detail ? <Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text> : null}
          </View>
          {selected ? <Check size={17} color={palette.accent} /> : null}
        </Pressable>;
      })}
    </Card>
  </>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  group: { padding: 6, gap: 4 },
  choice: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  label: { fontSize: 15, fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 18 },
});
