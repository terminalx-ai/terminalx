import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { CloudProvider } from "@mobile/cloud/api";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { useTheme } from "./theme";

/** The provider list as the compute pages hold it: the server's last answer, and why a later read failed. */
export interface ProvidersRead {
  /** Null until the list was read once. In the server's order (`descriptor.order`). */
  providers: CloudProvider[] | null;
  /** Why the last read failed; what was read before stays. */
  error: unknown;
  reading: boolean;
  /** Reads again; the list, or null when it could not be read. */
  read(): Promise<CloudProvider[] | null>;
}

/**
 * The organization's compute providers, read from the server each time the
 * page comes to the front: a key connected or removed on the next page, on
 * the desktop or in the console is shown on the way back. Nothing is kept on
 * the phone.
 */
export function useProviders(catalog: CloudCatalog, orgId: string): ProvidersRead {
  const [state, setState] = useState<{ providers: CloudProvider[] | null; error: unknown }>({ providers: null, error: null });
  const [reading, setReading] = useState(true);
  // Only the latest read is shown; one that answers after the page left is dropped.
  const turn = useRef(0);
  const read = useCallback(async () => {
    const mine = ++turn.current;
    setReading(true);
    try {
      const providers = [...(await catalog.api.providers(orgId))].sort((a, b) => a.descriptor.order - b.descriptor.order);
      if (turn.current === mine) setState({ providers, error: null });
      return providers;
    } catch (error) {
      if (turn.current === mine) setState((before) => ({ providers: before.providers, error }));
      return null;
    } finally {
      if (turn.current === mine) setReading(false);
    }
  }, [catalog, orgId]);
  useFocusEffect(useCallback(() => {
    void read();
    return () => { turn.current += 1; };
  }, [read]));
  return { ...state, reading, read };
}

/** A page's title with the organization under it, as 25.03 heads its pages. */
export function TitleWithOrganization({ title, organization }: { title: string; organization?: string | null }) {
  const { palette } = useTheme();
  return <View accessible accessibilityRole="header" accessibilityLabel={organization ? `${title}, ${organization}` : title} style={styles.title}>
    <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{title}</Text>
    {organization ? <Text numberOfLines={1} style={[styles.organization, { color: palette.muted }]}>{organization}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  title: { alignItems: "center", maxWidth: 220 },
  name: { fontSize: 17, fontWeight: "600" },
  organization: { fontSize: 12, lineHeight: 15 },
});
