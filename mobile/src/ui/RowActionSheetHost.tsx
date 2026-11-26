import { useEffect, useState } from "react";
import { ChoiceSheet } from "./ChoiceSheet";
import { setRowActionSheet, type RowActionRequest } from "./row-actions";

/**
 * Where a row's actions are drawn on Android, mounted once at the app's root. Android's own alert holds
 * three buttons at most and drops the rest, and a workspace can offer four actions and Cancel: so the
 * actions are listed in the app's sheet instead, where a tap outside is Cancel.
 */
export function RowActionSheetHost() {
  const [request, setRequest] = useState<RowActionRequest | null>(null);
  useEffect(() => setRowActionSheet(setRequest), []);
  if (!request) return null;
  const close = () => setRequest(null);
  return <ChoiceSheet
    title={request.title}
    subtitle={request.message}
    chosen={null}
    choices={request.actions.map((action) => ({ id: action.name, label: action.label }))}
    onChoose={(name) => request.actions.find((action) => action.name === name)?.run()}
    onClose={close}
  />;
}
