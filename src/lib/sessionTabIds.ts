import type { SelectedSessionTab } from "@/lib/terminal";

export function tabNodeId(tab: SelectedSessionTab) {
  return `session-${tab.kind}-tab-${encodeURIComponent(tab.id)}`;
}

export function tabPanelId(tab: SelectedSessionTab) {
  return `session-${tab.kind}-panel-${encodeURIComponent(tab.id)}`;
}
