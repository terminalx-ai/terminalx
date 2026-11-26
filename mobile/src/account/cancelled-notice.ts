import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { CloudApi } from "../cloud/api";
import { accountDeletionText, stoppedAtConfirm } from "./deletion";

/**
 * "Account deletion cancelled" (PRO-584, board 26.01 screen 9): signing in
 * during the 14 days cancelled the deletion, and the server says so once
 * (`notice: "cancelled"`) until the phone tells it the notice was shown.
 * Settings reads it once for each sign-in and shows it while the person is
 * on Settings; leaving Settings puts it away.
 */
const checked = new Set<string>();

export function useCancelledDeletionNotice(api: Pick<CloudApi, "accountDeletion" | "acknowledgeAccountDeletionNotice"> | null, userId: string | null): string | null {
  // Whose notice it is: one shown for an account is never shown to the next.
  const [shown, setShown] = useState<{ userId: string; text: string } | null>(null);
  // Each look at Settings may read it, for a sign-in not read yet.
  const [look, setLook] = useState(0);
  useFocusEffect(useCallback(() => {
    setLook((value) => value + 1);
    return () => setShown(null);
  }, []));
  // A read under way lands while the page is there, even if Settings was looked at again meanwhile.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    // Signed out: the next sign-in, by anyone, is read again.
    if (!userId) { checked.clear(); return; }
    if (!api || checked.has(userId)) return;
    checked.add(userId);
    void api.accountDeletion().then(async (read) => {
      if (read.notice !== "cancelled") return;
      const stopped = read.deletion?.state === "cancelled" && stoppedAtConfirm(read.deletion) > 0;
      if (mounted.current) setShown({ userId, text: stopped ? accountDeletionText.cancelledStopped : accountDeletionText.cancelledBody });
      await api.acknowledgeAccountDeletionNotice().catch(() => undefined);
    }, () => {
      // Not read (offline, say): read again on the next look at Settings.
      checked.delete(userId);
    });
  }, [api, userId, look]);
  return shown && shown.userId === userId ? shown.text : null;
}

/** For tests: forget which accounts were read. */
export function resetCancelledNoticeForTests(): void {
  checked.clear();
}
