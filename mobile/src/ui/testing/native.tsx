import { useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { vi } from "vitest";

/**
 * React Native drawn as DOM, for component tests: every view is an element
 * whose flattened style, accessibility props and test id can be read back.
 * Used as `vi.mock("react-native", () => import("@mobile/ui/testing/native"))`.
 */
type Props = Record<string, any>;

const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style && typeof style === "object" ? style as Record<string, unknown> : {};

/** What a view says to the screen and to assistive technology, as attributes. */
function attributes({ testID, style, accessibilityRole, accessibilityLabel, accessibilityHint, accessibilityState, accessibilityValue, accessibilityElementsHidden, importantForAccessibility }: Props, pressed = false) {
  const flat = flatten(typeof style === "function" ? style({ pressed }) : style);
  return {
    "data-testid": testID,
    "data-style": Object.keys(flat).length ? JSON.stringify(flat) : undefined,
    role: accessibilityRole,
    "aria-label": accessibilityLabel,
    "data-hint": accessibilityHint,
    "aria-valuetext": accessibilityValue?.text,
    "aria-disabled": accessibilityState?.disabled ? true : undefined,
    "aria-selected": accessibilityState?.selected ? true : undefined,
    "aria-busy": accessibilityState?.busy ? true : undefined,
    "aria-hidden": accessibilityElementsHidden || importantForAccessibility === "no-hide-descendants" ? true : undefined,
  };
}

export const View = (props: Props) => <div {...attributes(props)}>{props.children}</div>;
export const ScrollView = View;
export const Text = (props: Props) => <span {...attributes(props)} data-selectable={props.selectable ? "true" : undefined} data-lines={props.numberOfLines}>{props.children}</span>;

export function Pressable(props: Props) {
  const children: ReactNode = typeof props.children === "function" ? props.children({ pressed: false }) : props.children;
  return <div {...attributes(props)} aria-disabled={props.disabled || props.accessibilityState?.disabled ? true : undefined} onClick={props.disabled ? undefined : (event) => { event.stopPropagation(); props.onPress?.(); }}>{children}</div>;
}

/** An input that is controlled only when it is handed a `value`, as the native one is. */
export function TextInput({ ref, ...props }: Props & { ref?: Ref<unknown> }) {
  const element = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () => element.current?.focus(),
    blur: () => element.current?.blur(),
    // As on the phone, clearing says nothing to onChangeText.
    clear: () => { if (element.current) element.current.value = ""; },
    isFocused: () => document.activeElement === element.current,
  }), []);
  const controlled = props.value !== undefined;
  return <input
    ref={element}
    {...attributes(props)}
    type={props.secureTextEntry ? "password" : "text"}
    data-controlled={controlled ? "true" : undefined}
    data-multiline={props.multiline ? "true" : undefined}
    {...(controlled ? { value: props.value } : {})}
    autoFocus={props.autoFocus}
    disabled={props.editable === false}
    placeholder={props.placeholder}
    onChange={(event) => props.onChangeText?.(event.currentTarget.value)}
    onFocus={() => props.onFocus?.()}
    onBlur={() => props.onBlur?.()}
    onKeyDown={(event) => { if (event.key === "Enter") props.onSubmitEditing?.(); }}
  />;
}

export const Switch = (props: Props) => <input {...attributes(props)} type="checkbox" role="switch" checked={!!props.value} disabled={!!props.disabled} data-track={JSON.stringify(props.trackColor ?? {})} onChange={(event) => props.onValueChange?.(event.currentTarget.checked)} />;

export const StyleSheet = { create: <T,>(styles: T): T => styles, hairlineWidth: 1, flatten };
export const Platform = { OS: "ios", select: <T,>(choices: { ios?: T; default?: T }) => choices.ios ?? choices.default };

class Value { constructor(public value: number) {} setValue(value: number) { this.value = value; } interpolate() { return "0deg"; } }
const motion = () => ({ start: () => undefined, stop: () => undefined });
export const Animated = { View, Value, timing: motion, loop: motion };
export const Easing = { linear: (value: number) => value };
export const AccessibilityInfo = { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove: () => undefined }) };

export const ActionSheetIOS = { showActionSheetWithOptions: vi.fn() };
export const Alert = { alert: vi.fn() };
