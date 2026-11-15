import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { cleanHostName } from "./host-name";

/**
 * What this phone remembers about machines on the account that are not
 * paired here (#987): a name typed on this phone, and whether they are
 * hidden from the list. Kept on the phone only, so both work with no
 * connection; neither changes anything on the account or the machine.
 *
 * Paired machines keep their name in their stored entry (`store/hosts.ts`);
 * when a machine from this list is paired, its name moves there.
 */
const KEY = "terminalx:mobile:account-machines:v1";

const entrySchema = z.object({
  customName: z.string().min(1).max(256).optional(),
  hidden: z.literal(true).optional(),
});

export type AccountMachinePrefs = Readonly<Record<string, z.infer<typeof entrySchema>>>;

export async function readAccountMachinePrefs(): Promise<AccountMachinePrefs> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return {};
  try {
    const parsed = z.record(z.string().min(1), entrySchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Name `hostId` on this phone; an empty name goes back to the machine's own. */
export function setAccountMachineName(hostId: string, typed: string): Promise<AccountMachinePrefs> {
  const customName = cleanHostName(typed) ?? undefined;
  return change(hostId, (entry) => ({ ...entry, customName }));
}

/** Hide `hostId` from this phone's list, or show it again. */
export function setAccountMachineHidden(hostId: string, hidden: boolean): Promise<AccountMachinePrefs> {
  return change(hostId, (entry) => ({ ...entry, hidden: hidden ? true : undefined }));
}

/** Drop what is remembered about `hostId`, returning what it was (for a machine just paired). */
export async function takeAccountMachinePrefs(hostId: string): Promise<{ prefs: AccountMachinePrefs; taken: AccountMachinePrefs[string] | undefined }> {
  const current = await readAccountMachinePrefs();
  const taken = current[hostId];
  if (!taken) return { prefs: current, taken };
  const { [hostId]: _dropped, ...rest } = current;
  await AsyncStorage.setItem(KEY, JSON.stringify(rest));
  return { prefs: rest, taken };
}

async function change(hostId: string, update: (entry: AccountMachinePrefs[string]) => AccountMachinePrefs[string]): Promise<AccountMachinePrefs> {
  const current = await readAccountMachinePrefs();
  const next = entrySchema.parse(JSON.parse(JSON.stringify(update(current[hostId] ?? {}))));
  const { [hostId]: _previous, ...rest } = current;
  const prefs = Object.keys(next).length ? { ...rest, [hostId]: next } : rest;
  await AsyncStorage.setItem(KEY, JSON.stringify(prefs));
  return prefs;
}
