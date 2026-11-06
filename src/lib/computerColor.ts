export const COMPUTER_COLORS = [
  { id: "blue", label: "Blue", value: "#60a5fa" },
  { id: "violet", label: "Violet", value: "#a78bfa" },
  { id: "pink", label: "Pink", value: "#f472b6" },
  { id: "orange", label: "Orange", value: "#fb923c" },
  { id: "green", label: "Green", value: "#4ade80" },
  { id: "teal", label: "Teal", value: "#2dd4bf" },
] as const;

/** Never use server-provided text directly as a CSS value. */
export function computerColor(value?: string | null): string {
  return (COMPUTER_COLORS.find((color) => color.id === value) ?? COMPUTER_COLORS[0]).value;
}
