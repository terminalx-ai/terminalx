import { useEffect } from "react";
import { View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { githubReturn } from "@mobile/cloud/github";
import { useTheme } from "@mobile/ui/theme";

/**
 * Where the server's GitHub result page sends the browser
 * (`terminalx://github-app/connect?attemptId=…`, PRO-537). On iOS the sign-in
 * sheet takes that address itself and this page is never opened. It is opened
 * when the link reaches the app another way: the page's Return to TerminalX
 * button in a browser of its own, or Android's intent.
 *
 * The link proves nothing, so nothing is decided here: the page that started
 * the attempt is told its id and asks the server; this page then steps aside.
 * With no page waiting (the app was opened by the link), it goes to Cloud.
 */
export default function GithubReturnScreen() {
  const { attemptId } = useLocalSearchParams<{ attemptId?: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  useEffect(() => {
    if (typeof attemptId === "string" && attemptId) githubReturn.arrived(attemptId);
    if (router.canGoBack()) router.back();
    else router.replace("/cloud");
  }, [attemptId, router]);
  return <View style={{ flex: 1, backgroundColor: palette.page }}>
    <Stack.Screen options={{ headerShown: false, animation: "none" }} />
  </View>;
}
