import { AndroidImportance, setNotificationChannelAsync } from "expo-notifications";

/**
 * Android plays a notification's sound by its channel, not by the notification: a sound turned off
 * for one notification is ignored there. So there is one channel that sounds and one that does not,
 * each made once, and a notification is sent on the one its sound setting picks.
 */
export const ALERT_CHANNEL = "alerts";
export const QUIET_CHANNEL = "quiet";

let made: Promise<void> | null = null;

function makeChannels(): Promise<void> {
  return (made ??= Promise.all([
    setNotificationChannelAsync(ALERT_CHANNEL, { name: "Agents that need you", importance: AndroidImportance.HIGH, sound: "default" }),
    setNotificationChannelAsync(QUIET_CHANNEL, { name: "Quiet updates", importance: AndroidImportance.DEFAULT, sound: null }),
  ]).then(() => undefined, (cause: unknown) => { made = null; throw cause; }));
}

/** The channel a notification goes on: the sounding one, or the quiet one. */
export async function androidChannel(sound: boolean): Promise<string> {
  await makeChannels();
  return sound ? ALERT_CHANNEL : QUIET_CHANNEL;
}
