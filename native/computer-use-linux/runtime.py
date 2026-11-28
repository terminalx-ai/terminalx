#!/usr/bin/env python3
"""TerminalX Linux computer-use bridge.

The Node sidecar owns TerminalX's public API. This process is intentionally a small
AT-SPI adapter: read one JSON operation file, execute it in the user's desktop
session, and print one JSON response.
"""

import base64
import ctypes
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass

import gi

gi.require_version("Atspi", "2.0")
try:
    gi.require_version("Gdk", "3.0")
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import Gdk, GdkPixbuf
except (ImportError, ValueError):
    Gdk = None
    GdkPixbuf = None
from gi.repository import Atspi

MAX_NODES = 1200
MAX_DEPTH = 64
TEXT_LIMIT = 500
MAX_SCREENSHOT_PNG_BYTES = 900_000
MAX_SCREENSHOT_EDGE = 1280
MIN_SCREENSHOT_SCALE = 0.25
SCREENSHOT_SCALE_STEP = 0.85
BLOCKED_APP_FRAGMENTS = (
    "1password",
    "bitwarden",
    "dashlane",
    "lastpass",
    "nordpass",
    "proton pass",
)
OWN_APP_RELEASE_BUNDLE_ID = "com.terminalx.next"
OWN_APP_FRAGMENTS = (
    "terminalx",
    "terminal-x",
    "terminal x",
    "com.terminalx",
    "raccoon",
)
GENERIC_INTERPRETER_NAMES = frozenset({
    "python",
    "python3",
    "sh",
    "bash",
    "zsh",
    "dash",
    "node",
    "env",
})
TOP_LEVEL_ANCESTOR_ROLES = frozenset({
    "application",
    "desktop frame",
    "frame",
    "window",
    "dialog",
    "alert",
})
CLIPBOARD_COMMAND_TIMEOUT_SECONDS = 2
CLIPBOARD_OWNER_SETTLE_SECONDS = 0.05
CLIPBOARD_PASTE_SETTLE_SECONDS = 0.15


@dataclass
class Rect:
    x: float
    y: float
    width: float
    height: float

    def to_json(self):
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}


def attempt(fn, fallback=None):
    try:
        value = fn()
        return fallback if value is None else value
    except Exception:
        return fallback


def ensure_desktop_bus():
    missing = [name for name in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS") if not os.environ.get(name)]
    if missing:
        raise RuntimeError("Linux computer use requires an active desktop session; missing " + ", ".join(missing))


def desktop_root():
    return Atspi.get_desktop(0)


def children(node):
    count = int(attempt(node.get_child_count, 0) or 0)
    for index in range(count):
        child = attempt(lambda i=index: node.get_child_at_index(i))
        if child is not None:
            yield index, child


def text_attr(node, getter):
    return str(attempt(getter, "") or "")


def name_of(node):
    return text_attr(node, node.get_name)


def role_of(node):
    return text_attr(node, node.get_role_name)


def pid_of(node):
    return int(attempt(node.get_process_id, 0) or 0)


def state_set_contains(state_set, state):
    return bool(state_set is not None and state is not None and attempt(lambda: state_set.contains(state), False))


def has_state(node, state):
    return state_set_contains(attempt(node.get_state_set), state)


def screen_rect(node):
    component = attempt(node.get_component_iface)
    if component is None:
        return None
    rect = attempt(lambda: Atspi.Component.get_extents(component, Atspi.CoordType.SCREEN))
    if rect is None or rect.width <= 0 or rect.height <= 0:
        return None
    return Rect(float(rect.x), float(rect.y), float(rect.width), float(rect.height))


def relative_rect(node, window_rect):
    rect = screen_rect(node)
    if rect is None or window_rect is None:
        return rect
    return Rect(rect.x - window_rect.x, rect.y - window_rect.y, rect.width, rect.height)


def desktop_apps():
    for _, app in children(desktop_root()):
        if name_of(app):
            yield app


def windows_for(app):
    result = []
    for index, child in children(app):
        role = role_of(child).lower()
        rect = screen_rect(child)
        if rect is not None or role in {"frame", "window", "dialog", "alert"}:
            result.append((index, child))
    return result


def choose_window(app, window_id=None, window_index=None):
    windows = windows_for(app)
    if not windows:
        raise RuntimeError("No top-level AT-SPI window is available for " + name_of(app))
    if window_id is not None:
        raise RuntimeError("windowId is not supported by the Linux AT-SPI provider; use windowIndex")
    if window_index is not None:
        for item in windows:
            if item[0] == int(window_index):
                return item
        raise RuntimeError(f'windowNotFound("{window_index}")')
    for item in windows:
        if has_state(item[1], Atspi.StateType.ACTIVE):
            return item
    for item in windows:
        if has_state(item[1], Atspi.StateType.SHOWING):
            return item
    return windows[0]


def restore_window(app, window=None):
    target = window if window is not None else app
    component = attempt(target.get_component_iface)
    if component is not None and attempt(lambda: Atspi.Component.grab_focus(component), False):
        return
    pid = pid_of(app)
    if not pid or not shutil.which("xdotool"):
        return
    subprocess.run(
        ["xdotool", "search", "--pid", str(pid), "windowactivate", "--sync"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def require_keyboard_focus(window, operation, own_app=None):
    assert_no_protected_active_window(own_app)
    if has_state(window, Atspi.StateType.ACTIVE):
        return
    if operation.get("restoreWindow"):
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            assert_no_protected_active_window(own_app)
            if has_state(window, Atspi.StateType.ACTIVE):
                return
            time.sleep(0.05)
        assert_no_protected_active_window(own_app)
        if has_state(window, Atspi.StateType.ACTIVE):
            return
        raise RuntimeError("window_not_focused: keyboard input requires the target window to be focused; restoreWindow was requested but the target window is still not focused; bring it forward manually or check desktop permissions")
    raise RuntimeError("window_not_focused: keyboard input requires the target window to be focused; retry with --restore-window")


def process_executable_path(pid):
    if not pid or int(pid) <= 0:
        return ""
    try:
        return os.path.realpath(f"/proc/{int(pid)}/exe")
    except OSError:
        return ""


def process_comm(pid):
    if not pid or int(pid) <= 0:
        return ""
    try:
        with open(f"/proc/{int(pid)}/comm", "r", encoding="utf-8", errors="replace") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def _parse_proc_stat_fields(pid):
    if not pid or int(pid) <= 0:
        return None
    try:
        with open(f"/proc/{int(pid)}/stat", "r", encoding="utf-8", errors="replace") as handle:
            raw = handle.read()
    except OSError:
        return None
    close_paren = raw.rfind(")")
    if close_paren < 0:
        return None
    fields = raw[close_paren + 2:].split()
    if len(fields) < 3:
        return None
    try:
        ppid = int(fields[1])
        pgrp = int(fields[2])
        return ppid, pgrp
    except ValueError:
        return None


def process_parent_pid(pid):
    parsed = _parse_proc_stat_fields(pid)
    return parsed[0] if parsed else 0


def process_group_id(pid):
    parsed = _parse_proc_stat_fields(pid)
    return parsed[1] if parsed else 0


def is_descendant_pid(target_pid, ancestor_pid, max_depth=32):
    target = int(target_pid or 0)
    ancestor = int(ancestor_pid or 0)
    if target <= 0 or ancestor <= 0:
        return False
    if target == ancestor:
        return True
    seen = {target}
    current = target
    for _ in range(max_depth):
        parent = process_parent_pid(current)
        if parent <= 1 or parent in seen:
            return False
        if parent == ancestor:
            return True
        seen.add(parent)
        current = parent
    return False


def is_own_app_identity(*, pid=0, names=(), own_app=None):
    normalized_names = [str(value or "").strip().lower() for value in names if str(value or "").strip()]
    target_pid = int(pid or 0)
    target_exe = ""
    if target_pid > 0:
        comm = process_comm(target_pid).lower()
        if comm:
            normalized_names.append(comm)
        target_exe = process_executable_path(target_pid)
        if target_exe:
            normalized_names.append(os.path.basename(target_exe).lower())

    release_id = str((own_app or {}).get("releaseBundleId") or OWN_APP_RELEASE_BUNDLE_ID).strip().lower()
    if release_id and any(release_id in value for value in normalized_names):
        return True

    if own_app and bool(own_app.get("allowOwnWindowsForTests")):
        return False

    if any(fragment in value for fragment in OWN_APP_FRAGMENTS for value in normalized_names):
        return True

    if isinstance(own_app, dict):
        owner_pid = int(own_app.get("pid") or 0)
        if owner_pid > 0 and target_pid > 0:
            if target_pid == owner_pid or is_descendant_pid(target_pid, owner_pid):
                return True
        owner_pgid = int(own_app.get("processGroupId") or 0)
        if owner_pid > 0 and owner_pgid == owner_pid and target_pid > 0:
            if process_group_id(target_pid) == owner_pgid:
                return True
        owner_exe = str(own_app.get("executablePath") or "").strip()
        if owner_exe and target_exe:
            try:
                if os.path.realpath(target_exe) == os.path.realpath(owner_exe):
                    return True
            except OSError:
                pass
        owner_exe_name = str(own_app.get("executableName") or "").strip().lower()
        if owner_exe_name and owner_exe_name not in GENERIC_INTERPRETER_NAMES:
            if any(value == owner_exe_name for value in normalized_names):
                return True
        app_id = str(own_app.get("appIdentifier") or "").strip().lower()
        if app_id and any(app_id in value for value in normalized_names):
            return True
        for extra_key in ("appNames", "windowClasses"):
            for token in own_app.get(extra_key) or ():
                needle = str(token or "").strip().lower()
                if needle and any(needle in value for value in normalized_names):
                    return True
    return False


def is_blocked_app_identity(names):
    normalized_names = [str(value or "").strip().lower() for value in names if str(value or "").strip()]
    return any(fragment in value for fragment in BLOCKED_APP_FRAGMENTS for value in normalized_names)


def assert_query_allowed(query, own_app=None):
    needle = str(query or "").strip()
    if not needle:
        return
    lower = needle.lower()
    query_pid = 0
    if lower.startswith("pid:"):
        query_pid = parse_positive_pid(lower[4:].strip()) or 0
    elif lower.isdigit():
        query_pid = parse_positive_pid(lower) or 0
    if is_own_app_identity(pid=query_pid, names=[needle], own_app=own_app):
        raise RuntimeError(f"own_app_protected: computer use cannot observe or operate TerminalX ({needle})")
    if is_blocked_app_identity([needle]):
        raise RuntimeError(f'appBlocked("{needle}")')


def assert_no_protected_active_window(own_app=None):
    for app in attempt(lambda: list(desktop_apps()), []) or []:
        for _, win in windows_for(app):
            if has_state(win, Atspi.StateType.ACTIVE):
                names = [name_of(app), name_of(win)]
                if is_own_app_identity(pid=pid_of(app), names=names, own_app=own_app):
                    raise RuntimeError("own_app_protected: keyboard input was stopped because a TerminalX window has the keyboard focus")
                if is_blocked_app_identity(names):
                    raise RuntimeError(f'appBlocked("{name_of(app)}")')


def app_matches(app, query):
    needle = str(query or "").strip().lower()
    if not needle:
        return False
    if needle.startswith("pid:"):
        requested_pid = parse_positive_pid(needle[4:].strip())
        return requested_pid is not None and pid_of(app) == requested_pid
    if needle.isdigit() and int(needle) > 0 and pid_of(app) == int(needle):
        return True
    haystacks = [name_of(app).lower()] + [name_of(window).lower() for _, window in windows_for(app)]
    return any(value == needle or needle in value for value in haystacks)


def parse_positive_pid(value):
    return int(value) if value.isdigit() and int(value) > 0 else None


def find_app(query, own_app=None):
    assert_query_allowed(query, own_app=own_app)
    for app in desktop_apps():
        if app_matches(app, query):
            reject_blocked_app(app, own_app=own_app)
            return app
    raise RuntimeError(f'appNotFound("{query}")')


def reject_blocked_app(app, own_app=None):
    haystacks = [name_of(app)] + [name_of(window) for _, window in windows_for(app)]
    if is_own_app_identity(pid=pid_of(app), names=haystacks, own_app=own_app):
        raise RuntimeError(f"own_app_protected: computer use cannot observe or operate {name_of(app)}")
    if is_blocked_app_identity(haystacks):
        raise RuntimeError(f'appBlocked("{name_of(app)}")')


def action_labels(node):
    labels = []
    count = int(attempt(node.get_n_actions, 0) or 0)
    for index in range(count):
        label = str(attempt(lambda i=index: node.get_action_name(i), "") or "")
        description = str(attempt(lambda i=index: node.get_action_description(i), "") or "")
        value = label or description
        if value and value not in labels:
            labels.append(value)
    return labels


def meaningful_actions(actions):
    noisy = {
        "click",
        "press",
        "show default ui",
        "show alternate ui",
        "show menu",
        "scroll to visible",
        "raise",
    }
    return [action for action in actions if action.strip().lower() not in noisy]


def display_action(action):
    value = str(action or "").strip()
    if not value:
        return value
    return " ".join(value.replace("_", " ").split())


def sanitize_text(value):
    return " ".join(str(value or "").replace("\r", " ").replace("\n", " ").split())


def formatted_value(role_key, title, value):
    clean = sanitize_text(value)
    if not clean or clean == title:
        return ""
    if role_key in {"label", "static", "static text", "text", "entry", "text entry"}:
        return " " + clean
    return ", Value: " + clean


def suppress_children(role_key, title, value, summary):
    has_compact_label = bool(title or sanitize_text(value) or sanitize_text(summary))
    return has_compact_label and role_key in {
        "button",
        "check box",
        "checkbox",
        "combo box",
        "heading",
        "link",
        "menu item",
        "page tab",
        "push button",
        "radio button",
    }


def text_iface(node):
    return attempt(lambda: node.get_text_iface())


def is_text_node(node):
    result = attempt(lambda: node.is_text())
    return bool(result) if result is not None else text_iface(node) is not None


def string_value(node, *, is_secure=None, is_text=None):
    if is_secure is None:
        is_secure = is_secure_node(node)
    if is_secure:
        return "[redacted]"
    if is_text is None:
        is_text = is_text_node(node)
    if is_text:
        iface = text_iface(node)
        count = int(attempt(lambda: Atspi.Text.get_character_count(iface), 0) or 0)
        if iface is not None and count > 0:
            value = str(attempt(lambda: Atspi.Text.get_text(iface, 0, min(count, TEXT_LIMIT)), "") or "")
            return value + ("..." if count > TEXT_LIMIT else "")
    value_iface = attempt(node.get_value_iface)
    if value_iface is not None:
        current = attempt(lambda: Atspi.Value.get_current_value(value_iface))
        if current is not None:
            return str(current)
    return ""


def is_secure_metadata(role, name, acc_id, state_set):
    label = " ".join([role.lower(), name.lower(), acc_id.lower()])
    sensitive_terms = ("password", "passcode", "secret", "one-time code", "verification code")
    if any(term in label for term in sensitive_terms) or re.search(r"(^|[^a-z0-9])pin([^a-z0-9]|$)", label):
        return True
    protected_state = getattr(Atspi.StateType, "PROTECTED", None)
    if state_set_contains(state_set, protected_state):
        return True
    return False


def is_secure_node(node, *, check_ancestors=True):
    if node is None:
        return False
    if is_secure_metadata(role_of(node), name_of(node), accessible_id(node), attempt(node.get_state_set)):
        return True
    if not check_ancestors:
        return False
    protected_state = getattr(Atspi.StateType, "PROTECTED", None)
    seen = {id(node)}
    current = node
    for _ in range(MAX_DEPTH):
        parent = attempt(current.get_parent)
        if parent is None or id(parent) in seen:
            break
        seen.add(id(parent))
        parent_state = attempt(parent.get_state_set)
        if state_set_contains(parent_state, protected_state):
            return True
        parent_role = role_of(parent)
        if parent_role.lower() in TOP_LEVEL_ANCESTOR_ROLES:
            break
        if is_secure_metadata(parent_role, name_of(parent), accessible_id(parent), parent_state):
            return True
        current = parent
    return False


def accessible_id(node):
    return str(attempt(node.get_accessible_id, "") or "")


def record(node, index, path, window_rect):
    role = role_of(node)
    name = name_of(node)
    acc_id = accessible_id(node)
    state_set = attempt(node.get_state_set)
    rect = relative_rect(node, window_rect)
    return {
        "index": index,
        "runtimeId": path,
        "automationId": acc_id,
        "name": name,
        "controlType": role,
        "localizedControlType": role,
        "className": str(attempt(node.get_toolkit_name, "") or ""),
        "value": string_value(node, is_secure=is_secure_node(node)),
        "isSelected": state_set_contains(state_set, getattr(Atspi.StateType, "SELECTED", None)),
        "nativeWindowHandle": 0,
        "frame": rect.to_json() if rect else None,
        "actions": action_labels(node),
    }


def selected_text_from_node(node, *, is_secure=None):
    if node is None:
        return None
    if is_secure is None:
        is_secure = is_secure_node(node)
    iface = text_iface(node)
    if iface is None:
        return None
    selections = attempt(lambda: Atspi.Text.get_text_selections(iface), [])
    if not selections:
        return None
    selection = selections[0]
    start = max(0, int(attempt(lambda: selection.start_offset, 0) or 0))
    end = max(start, int(attempt(lambda: selection.end_offset, start) or start))
    if is_secure:
        return "[redacted]" if end > start else None
    if end == start:
        return ""
    capped_end = min(end, start + TEXT_LIMIT)
    text = attempt(lambda: Atspi.Text.get_text(iface, start, capped_end))
    if text is None:
        return None
    text = str(text)
    if len(text) > TEXT_LIMIT:
        return text[:TEXT_LIMIT] + "..."
    if end > capped_end:
        return text + "..."
    return text


def render_accessibility_tree_with_focus(root, window_rect, root_path, compact_browser_tabs=False):
    records = []
    lines = []
    truncation = {"truncated": False, "maxNodes": MAX_NODES, "maxDepth": MAX_DEPTH, "maxDepthReached": False}

    # Per-walk cache avoids repeated D-Bus IPC for children, state sets, and
    # attributes across summary extraction, elision, and main tree rendering.
    node_cache = {}
    plain_text_rejected = set()
    focused_state = getattr(Atspi.StateType, "FOCUSED", None)
    selected_state = getattr(Atspi.StateType, "SELECTED", None)
    focused_entry = None
    focused_text_node = None
    focused_text_secure = False

    def get_entry(node):
        key = id(node)
        entry = node_cache.get(key)
        if entry is None:
            entry = {"node": node}
            node_cache[key] = entry
        return entry

    def cached_role(node):
        entry = get_entry(node)
        if "role" not in entry:
            entry["role"] = role_of(node)
        return entry["role"]

    def cached_name(node):
        entry = get_entry(node)
        if "name" not in entry:
            entry["name"] = name_of(node)
        return entry["name"]

    def cached_accessible_id(node):
        entry = get_entry(node)
        if "accessible_id" not in entry:
            entry["accessible_id"] = accessible_id(node)
        return entry["accessible_id"]

    def cached_state_set(node):
        entry = get_entry(node)
        if "state_set" not in entry:
            entry["state_set"] = attempt(node.get_state_set)
        return entry["state_set"]

    def cached_is_text(node):
        entry = get_entry(node)
        if "is_text" not in entry:
            entry["is_text"] = is_text_node(node)
        return entry["is_text"]

    def cached_is_secure(node, ancestor_secure=False):
        entry = get_entry(node)
        if "own_secure" not in entry:
            entry["own_secure"] = is_secure_metadata(
                cached_role(node),
                cached_name(node),
                cached_accessible_id(node),
                cached_state_set(node),
            )
        return ancestor_secure or entry["own_secure"]

    def cached_value(node, ancestor_secure=False):
        if ancestor_secure:
            return "[redacted]"
        entry = get_entry(node)
        if "value" not in entry:
            secure = cached_is_secure(node, ancestor_secure=False)
            entry["value"] = string_value(node, is_secure=secure, is_text=cached_is_text(node))
        return entry["value"]

    def cached_actions(node):
        entry = get_entry(node)
        if "actions" not in entry:
            entry["actions"] = action_labels(node)
        return entry["actions"]

    def cached_children(node):
        entry = get_entry(node)
        if "children" not in entry:
            entry["children"] = list(children(node))
        return entry["children"]

    def observe_focus(node, ancestor_secure=False):
        nonlocal focused_entry, focused_text_node, focused_text_secure
        if focused_state is None or (focused_entry is not None and focused_text_node is not None):
            return
        if state_set_contains(cached_state_set(node), focused_state):
            if focused_entry is None:
                focused_entry = get_entry(node)
            if focused_text_node is None and cached_is_text(node):
                focused_text_node = node
                focused_text_secure = cached_is_secure(node, ancestor_secure=ancestor_secure)

    def cached_record(node, index, path, ancestor_secure=False):
        role = cached_role(node)
        name = cached_name(node)
        acc_id = cached_accessible_id(node)
        state_set = cached_state_set(node)
        rect = relative_rect(node, window_rect)
        return {
            "index": index,
            "runtimeId": path,
            "automationId": acc_id,
            "name": name,
            "controlType": role,
            "localizedControlType": role,
            "className": str(attempt(node.get_toolkit_name, "") or ""),
            "value": cached_value(node, ancestor_secure=ancestor_secure),
            "isSelected": state_set_contains(state_set, selected_state),
            "nativeWindowHandle": 0,
            "frame": rect.to_json() if rect else None,
            "actions": cached_actions(node),
        }

    def collect_text_snippets(node, limit=6, max_depth=3, ancestor_secure=False):
        values = []
        seen = set()

        def collect(candidate, depth, inherited_secure):
            if len(values) >= limit or depth > max_depth:
                return
            node_secure = cached_is_secure(candidate, ancestor_secure=inherited_secure)
            observe_focus(candidate, ancestor_secure=inherited_secure)
            role = cached_role(candidate).lower()
            if role in {"label", "static", "static text", "text", "link"}:
                for raw in (cached_name(candidate), cached_value(candidate, ancestor_secure=node_secure)):
                    value = " ".join(str(raw or "").split())
                    if value and value not in seen:
                        seen.add(value)
                        values.append(value[:80])
                        if len(values) >= limit:
                            return
            next_secure = node_secure if role not in TOP_LEVEL_ANCESTOR_ROLES else inherited_secure
            for _, child in cached_children(candidate):
                collect(child, depth + 1, next_secure)
                if len(values) >= limit:
                    return

        collect(node, 0, ancestor_secure)
        return values

    def collect_plain_text_summary(node, limit=8, max_depth=4, ancestor_secure=False):
        if id(node) in plain_text_rejected:
            return None
        allowed = {"panel", "filler", "unknown", "section", "label", "static", "static text", "text", "link", "image"}
        values = []
        seen = set()
        saw_text = False

        def visit(candidate, depth, inherited_secure):
            nonlocal saw_text
            if depth > max_depth or id(candidate) in plain_text_rejected:
                return False
            node_secure = cached_is_secure(candidate, ancestor_secure=inherited_secure)
            observe_focus(candidate, ancestor_secure=inherited_secure)
            role = cached_role(candidate).lower()
            if role not in allowed:
                plain_text_rejected.add(id(candidate))
                return False
            if meaningful_actions(cached_actions(candidate)):
                plain_text_rejected.add(id(candidate))
                return False
            if role in {"label", "static", "static text", "text", "link"}:
                saw_text = True
                if len(values) < limit:
                    for raw in (cached_name(candidate), cached_value(candidate, ancestor_secure=node_secure)):
                        value = " ".join(str(raw or "").split())
                        if value and value not in seen:
                            seen.add(value)
                            values.append(value[:80])
                            if len(values) >= limit:
                                break
            next_secure = node_secure if role not in TOP_LEVEL_ANCESTOR_ROLES else inherited_secure
            for _, child in cached_children(candidate):
                if not visit(child, depth + 1, next_secure):
                    return False
            return True

        if not visit(node, 0, ancestor_secure) or not saw_text or len(values) < 2:
            return None
        return " ".join(values)

    def should_elide(item, child_count, summary):
        role = (item["controlType"] or "").lower()
        has_text = bool(item["name"] or item["automationId"] or item["value"])
        return role in {"panel", "filler", "unknown", "section"} and not has_text and not meaningful_actions(item["actions"]) and summary is None and child_count <= 1

    def walk(node, depth, path, ancestor_secure=False):
        if len(records) >= MAX_NODES or depth > MAX_DEPTH:
            truncation["truncated"] = True
            if depth > MAX_DEPTH:
                truncation["maxDepthReached"] = True
            return
        node_secure = cached_is_secure(node, ancestor_secure=ancestor_secure)
        observe_focus(node, ancestor_secure=ancestor_secure)
        item = cached_record(node, len(records), path, ancestor_secure=ancestor_secure)
        role_key = (item["controlType"] or "").lower()
        child_ancestor_secure = node_secure if role_key not in TOP_LEVEL_ANCESTOR_ROLES else (
            ancestor_secure or state_set_contains(cached_state_set(node), getattr(Atspi.StateType, "PROTECTED", None))
        )
        filtered_actions = meaningful_actions(item["actions"])
        generic_summary = None
        child_items = None
        if role_key in {"panel", "filler", "unknown", "section"} and not item["name"] and not item["value"]:
            if not filtered_actions:
                generic_summary = collect_plain_text_summary(node, limit=8, max_depth=4, ancestor_secure=child_ancestor_secure)
            if generic_summary is None and not item["automationId"] and not filtered_actions:
                child_items = cached_children(node)
                if should_elide(item, len(child_items), generic_summary):
                    for child_index, child in child_items:
                        walk(child, depth, path + [child_index], child_ancestor_secure)
                    return
        records.append(item)
        title = item["name"] or item["automationId"] or ""
        role_label = item["localizedControlType"] or item["controlType"]
        line = f'{item["index"]} {role_label} {sanitize_text(title)}'.rstrip()
        line += formatted_value(role_key, title, item["value"])
        if generic_summary and generic_summary != title:
            line += ", Text: " + sanitize_text(generic_summary)
        elif role_key in {"row", "table row", "list item"}:
            row_summary = " ".join(collect_text_snippets(node, ancestor_secure=child_ancestor_secure))
            if row_summary and row_summary != title:
                line += ", Text: " + sanitize_text(row_summary)
        if filtered_actions:
            line += ", Secondary Actions: " + ", ".join(display_action(action) for action in filtered_actions)
        lines.append(("\t" * depth) + line)
        if generic_summary or suppress_children(role_key, title, item["value"], generic_summary):
            return
        if child_items is None:
            child_items = cached_children(node)
        child_line_start = len(lines)
        for child_index, child in child_items:
            walk(child, depth + 1, path + [child_index], child_ancestor_secure)
        if compact_browser_tabs:
            compact_rendered_browser_tabs(records, lines, child_line_start, depth + 1)

    walk(root, 0, root_path, False)
    focused_summary_text = None
    if focused_entry is not None:
        focused_node = focused_entry["node"]
        focused_summary_text = (cached_role(focused_node) + " " + cached_name(focused_node)).strip()
    focus_info = {
        "focusedSummary": focused_summary_text,
        "selectedText": (
            selected_text_from_node(
                focused_text_node,
                is_secure=focused_text_secure or is_secure_node(focused_text_node),
            )
            if focused_text_node is not None
            else None
        ),
    }
    return records, lines, truncation, focus_info


def render_accessibility_tree(root, window_rect, root_path, compact_browser_tabs=False):
    records, lines, truncation, _ = render_accessibility_tree_with_focus(
        root,
        window_rect,
        root_path,
        compact_browser_tabs=compact_browser_tabs,
    )
    return records, lines, truncation


def compact_rendered_browser_tabs(records, lines, start_line, depth):
    tab_line_indexes = [
        line_index
        for line_index in range(start_line, len(lines))
        if is_direct_rendered_browser_tab_line(lines[line_index], depth)
    ]
    if len(tab_line_indexes) < 10:
        return
    records_by_index = {int(item["index"]): item for item in records}
    active_line_indexes = {
        line_index
        for line_index in tab_line_indexes
        if is_active_rendered_browser_tab_line(lines[line_index], depth, records_by_index)
    }
    if not active_line_indexes:
        return

    omitted_record_indexes = set()
    omitted_count = 0
    insertion_index = tab_line_indexes[0]
    for line_index in reversed(tab_line_indexes):
        if line_index in active_line_indexes:
            continue
        record_index = rendered_element_index(lines[line_index], depth)
        if record_index is not None:
            omitted_record_indexes.add(record_index)
        del lines[line_index]
        omitted_count += 1
    if omitted_count <= 0:
        return
    records[:] = [item for item in records if int(item["index"]) not in omitted_record_indexes]
    lines.insert(insertion_index, ("\t" * depth) + f"... {omitted_count} inactive browser tabs omitted")


def is_direct_rendered_browser_tab_line(line, depth):
    indent = "\t" * depth
    if not line.startswith(indent):
        return False
    text = line[len(indent):]
    if text.startswith("\t"):
        return False
    return re.match(r"^\d+ (page tab|tab item|tab)($|[ (,])", text, re.IGNORECASE) is not None


def is_active_rendered_browser_tab_line(line, depth, records_by_index):
    if "(selected" in line:
        return True
    record_index = rendered_element_index(line, depth)
    record = records_by_index.get(record_index)
    if not record:
        return False
    return bool(record.get("isSelected")) or sanitize_text(record.get("value")) == "1"


def is_browser_app(query, app):
    text = f"{query} {name_of(app)}".lower()
    tokens = set(re.split(r"[^a-z0-9]+", text))
    browser_tokens = {
        "arc",
        "brave",
        "chrome",
        "chromium",
        "edge",
        "msedge",
        "firefox",
        "librewolf",
        "opera",
        "vivaldi",
        "zen",
    }
    return not tokens.isdisjoint(browser_tokens)


def rendered_element_index(line, depth):
    text = line[len("\t" * depth):]
    match = re.match(r"^(\d+)", text)
    return int(match.group(1)) if match else None


def capture_png(rect):
    if Gdk is None or GdkPixbuf is None or rect is None or os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        return None
    screen = Gdk.Screen.get_default()
    root = screen.get_root_window() if screen else None
    if root is None:
        return None
    pixbuf = Gdk.pixbuf_get_from_window(root, round(rect.x), round(rect.y), max(1, round(rect.width)), max(1, round(rect.height)))
    if pixbuf is None:
        return None
    return bounded_png_payload(pixbuf)


def png_bytes(pixbuf):
    ok, data = pixbuf.save_to_bufferv("png", [], [])
    return bytes(data) if ok else None


def screenshot_payload(data, width, height, original_width):
    return {
        "base64": base64.b64encode(data).decode("ascii"),
        "width": width,
        "height": height,
        "scale": width / max(1, original_width),
    }


def bounded_png_payload(pixbuf):
    original_width = max(1, pixbuf.get_width())
    original_height = max(1, pixbuf.get_height())
    data = png_bytes(pixbuf)
    if data is None:
        return None
    if len(data) <= MAX_SCREENSHOT_PNG_BYTES:
        return screenshot_payload(data, original_width, original_height, original_width)

    # Why: screenshots are sent through JSON/stdout; matching macOS bounds keeps
    # large or high-DPI windows from multiplying native, base64, and Node memory.
    scale = min(1.0, MAX_SCREENSHOT_EDGE / max(original_width, original_height))
    while scale >= MIN_SCREENSHOT_SCALE:
        width = max(1, round(original_width * scale))
        height = max(1, round(original_height * scale))
        if width == original_width and height == original_height:
            scale *= SCREENSHOT_SCALE_STEP
            continue
        scaled = pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)
        if scaled is None:
            scale *= SCREENSHOT_SCALE_STEP
            continue
        candidate = png_bytes(scaled)
        if candidate is not None:
            if len(candidate) <= MAX_SCREENSHOT_PNG_BYTES:
                return screenshot_payload(candidate, width, height, original_width)
        scale *= SCREENSHOT_SCALE_STEP

    return {
        "error": {
            "code": "screenshot_failed",
            "message": "screenshot exceeded the computer-use payload cap after downscaling; retry with --no-screenshot or target a smaller window",
        }
    }


def first_descendant(root, predicate, max_nodes=MAX_NODES, max_depth=MAX_DEPTH):
    visited_count = 0
    stack = [(root, 0)]
    seen = set()
    while stack and visited_count < max_nodes:
        node, depth = stack.pop()
        identity = id(node)
        if identity in seen:
            continue
        seen.add(identity)
        visited_count += 1
        if predicate(node):
            return node
        if depth >= max_depth:
            continue
        # Why: focused/selection summaries run after the rendered tree is capped;
        # keep them from walking a larger or cyclic AT-SPI tree and timing out.
        child_items = list(children(node))
        for _, child in reversed(child_items):
            stack.append((child, depth + 1))
    return None


def focused_summary(window):
    node = first_descendant(window, lambda candidate: has_state(candidate, Atspi.StateType.FOCUSED))
    if node is None:
        return None
    return (role_of(node) + " " + name_of(node)).strip()


def selected_text(window):
    node = first_descendant(window, lambda candidate: has_state(candidate, Atspi.StateType.FOCUSED) and is_text_node(candidate))
    return selected_text_from_node(node)


def app_json(app):
    return {"name": name_of(app), "bundleIdentifier": name_of(app), "pid": pid_of(app)}


def window_json(app, index, window):
    bounds = screen_rect(window)
    showing = has_state(window, Atspi.StateType.SHOWING)
    return {
        "index": index,
        "app": app_json(app),
        "id": None,
        "title": name_of(window),
        "x": round(bounds.x) if bounds else None,
        "y": round(bounds.y) if bounds else None,
        "width": max(0, round(bounds.width if bounds else 0)),
        "height": max(0, round(bounds.height if bounds else 0)),
        "isMinimized": not showing,
        "isOffscreen": not showing,
        "screenIndex": None,
        "platform": {"backend": "at-spi", "runtimeId": [index], "role": role_of(window)},
    }


def make_snapshot(query, include_screenshot, window_id=None, window_index=None, restore=False, own_app=None):
    app = find_app(query, own_app=own_app)
    window_index, window = choose_window(app, window_id, window_index)
    if restore:
        restore_window(app, window)
        window_index, window = choose_window(app, window_id, window_index)
    bounds = screen_rect(window)
    records, lines, truncation, focus_info = render_accessibility_tree_with_focus(
        window,
        bounds,
        [window_index],
        compact_browser_tabs=is_browser_app(query, app),
    )
    screenshot = capture_png(bounds) if include_screenshot else None
    return {
        "snapshotId": str(uuid.uuid4()),
        "app": app_json(app),
        "windowTitle": name_of(window),
        "windowId": None,
        "windowIndex": window_index,
        "windowBounds": bounds.to_json() if bounds else None,
        "screenshotPngBase64": screenshot.get("base64") if screenshot else None,
        "screenshotWidth": screenshot.get("width") if screenshot else None,
        "screenshotHeight": screenshot.get("height") if screenshot else None,
        "screenshotScale": screenshot.get("scale") if screenshot else None,
        "screenshotError": screenshot.get("error") if screenshot else None,
        "coordinateSpace": "window",
        "truncation": truncation,
        "treeLines": lines,
        "focusedSummary": focus_info["focusedSummary"],
        "selectedText": focus_info["selectedText"],
        "elements": records,
    }


def list_apps_response():
    apps = []
    for app in sorted(desktop_apps(), key=lambda value: (name_of(value).lower(), pid_of(value))):
        if windows_for(app):
            apps.append({"name": name_of(app), "bundleIdentifier": name_of(app), "pid": pid_of(app)})
    return apps


def list_windows_response(query, own_app=None):
    app = find_app(query, own_app=own_app)
    return {"app": app_json(app), "windows": [window_json(app, index, window) for index, window in windows_for(app)]}


def handshake_response():
    is_wayland = os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
    has_hotkey = shutil.which("xdotool") is not None and not is_wayland
    has_clipboard = any(shutil.which(command) for command in ("wl-copy", "xclip", "xsel"))
    has_screenshot = Gdk is not None and GdkPixbuf is not None and not is_wayland
    return {
        "platform": "linux",
        "provider": "terminalx-computer-use-linux",
        "providerVersion": "1.0.0",
        "protocolVersion": 1,
        "supports": {
            "apps": {"list": True, "bundleIds": False, "pids": True},
            "windows": {"list": True, "targetById": False, "targetByIndex": True, "focus": False, "moveResize": False},
            "observation": {"screenshot": has_screenshot, "annotatedScreenshot": False, "elementFrames": True, "ocr": False},
            "actions": {
                "click": True,
                "typeText": True,
                "pressKey": True,
                "hotkey": has_hotkey,
                "pasteText": has_clipboard,
                "scroll": True,
                "drag": True,
                "setValue": True,
                "performAction": True,
            },
            "surfaces": {"menus": False, "dialogs": False, "dock": False, "menubar": False},
        },
    }


def find_by_path(app, path):
    node = app
    for raw_index in path or []:
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            return None
        if index < 0:
            return None
        count = int(attempt(node.get_child_count, 0) or 0)
        if index >= count:
            return None
        node = attempt(lambda n=node, i=index: n.get_child_at_index(i))
        if node is None:
            return None
    return node


def all_nodes(root):
    result = []

    def walk(node):
        if len(result) >= MAX_NODES:
            return
        result.append(node)
        for _, child in children(node):
            walk(child)

    walk(root)
    return result


def find_element(app, saved):
    if not saved:
        return None
    by_path = find_by_path(app, saved.get("runtimeId"))
    if by_path is not None and same_element_signature(by_path, saved):
        return by_path
    return None


def same_element_signature(node, saved):
    if role_of(node) != str(saved.get("controlType") or ""):
        return False
    if name_of(node) != str(saved.get("name") or ""):
        return False
    if accessible_id(node) != str(saved.get("automationId") or ""):
        return False
    saved_actions = [str(action) for action in saved.get("actions") or []]
    return action_labels(node) == saved_actions


def preferred_action(node):
    if node is None:
        return None
    priority = {"click", "press", "activate", "invoke", "select", "toggle", "open"}
    fallback = None
    for index in range(int(attempt(node.get_n_actions, 0) or 0)):
        label = str(attempt(lambda i=index: node.get_action_name(i), "") or "").lower()
        if label in priority:
            return index
        if fallback is None and any(term in label for term in ("click", "press", "activate")):
            fallback = index
    return fallback


def perform_action(node, index):
    return bool(index is not None and attempt(lambda: node.do_action(int(index)), False))


def validate_window_local_point(window_rect, x, y, x_name="x", y_name="y"):
    if window_rect is None or window_rect.width <= 0 or window_rect.height <= 0:
        raise RuntimeError("coordinate action requires a visible window and coordinates")
    try:
        fx = float(x)
        fy = float(y)
    except (TypeError, ValueError):
        raise RuntimeError(f"{x_name} and {y_name} must be finite numbers")
    if not (math.isfinite(fx) and math.isfinite(fy)):
        raise RuntimeError(f"{x_name} and {y_name} must be finite numbers")
    if fx < 0.0 or fy < 0.0 or fx > window_rect.width or fy > window_rect.height:
        raise RuntimeError(
            f"invalid_argument: {x_name} and {y_name} ({fx}, {fy}) are out of window bounds [0, {window_rect.width}] x [0, {window_rect.height}]"
        )
    return fx, fy


def validate_screen_point_in_window(window_rect, screen_x, screen_y):
    if window_rect is None or window_rect.width <= 0 or window_rect.height <= 0:
        raise RuntimeError("coordinate action requires a visible window and coordinates")
    if (
        screen_x < window_rect.x
        or screen_y < window_rect.y
        or screen_x > window_rect.x + window_rect.width
        or screen_y > window_rect.y + window_rect.height
    ):
        raise RuntimeError(
            f"invalid_argument: target point ({screen_x}, {screen_y}) is out of window bounds"
        )


def screen_point(window_rect, saved_element=None, x=None, y=None, node=None, x_name="x", y_name="y"):
    rect = screen_rect(node) if node is not None else None
    if rect is not None:
        px = rect.x + rect.width / 2
        py = rect.y + rect.height / 2
        validate_screen_point_in_window(window_rect, px, py)
        return px, py
    if saved_element is not None:
        raise RuntimeError("stale element frame; run get-app-state again and use a fresh element index")
    if window_rect is None or x is None or y is None:
        raise RuntimeError("coordinate action requires a visible window and coordinates")
    fx, fy = validate_window_local_point(window_rect, x, y, x_name=x_name, y_name=y_name)
    return window_rect.x + fx, window_rect.y + fy


def _x11_window_property_bytes(x11, display, window_id, atom):
    actual_type = ctypes.c_ulong(0)
    actual_format = ctypes.c_int(0)
    nitems = ctypes.c_ulong(0)
    bytes_after = ctypes.c_ulong(0)
    prop = ctypes.c_void_p(0)
    status = x11.XGetWindowProperty(
        display,
        ctypes.c_ulong(window_id),
        ctypes.c_ulong(atom),
        ctypes.c_long(0),
        ctypes.c_long(1024),
        ctypes.c_int(0),
        ctypes.c_ulong(0),  # AnyPropertyType
        ctypes.byref(actual_type),
        ctypes.byref(actual_format),
        ctypes.byref(nitems),
        ctypes.byref(bytes_after),
        ctypes.byref(prop),
    )
    if status != 0 or not prop.value:
        return 0, 0, b""
    try:
        fmt = actual_format.value
        count = nitems.value
        if fmt == 32:
            byte_len = count * ctypes.sizeof(ctypes.c_ulong)
        elif fmt == 16:
            byte_len = count * 2
        else:
            byte_len = count
        raw = ctypes.string_at(prop.value, byte_len) if byte_len > 0 else b""
        return fmt, count, raw
    finally:
        x11.XFree(prop)


def _x11_window_pid_and_names(x11, display, window_id, pid_atom, wm_class_atom, net_wm_name_atom, wm_name_atom):
    pid = 0
    fmt, count, raw = _x11_window_property_bytes(x11, display, window_id, pid_atom)
    if fmt == 32 and count >= 1 and len(raw) >= ctypes.sizeof(ctypes.c_ulong):
        pid = int(ctypes.c_ulong.from_buffer_copy(raw[: ctypes.sizeof(ctypes.c_ulong)]).value)
    names = []
    for atom in (wm_class_atom, net_wm_name_atom, wm_name_atom):
        p_fmt, _, p_raw = _x11_window_property_bytes(x11, display, window_id, atom)
        if p_fmt == 8 and p_raw:
            for part in p_raw.split(b"\x00"):
                text = part.decode("utf-8", errors="replace").strip()
                if text:
                    names.append(text)
    return pid, names


def x11_topmost_window_at_point(screen_x, screen_y):
    """Return topmost X11 window metadata at `(screen_x, screen_y)` or None."""
    px = int(round(screen_x))
    py = int(round(screen_y))
    try:
        x11 = ctypes.CDLL("libX11.so.6")
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        x11.XInternAtom.restype = ctypes.c_ulong
        x11.XTranslateCoordinates.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
            ctypes.c_int, ctypes.c_int,
            ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong),
        ]
        x11.XTranslateCoordinates.restype = ctypes.c_int
        x11.XGetWindowProperty.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
            ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        x11.XGetWindowProperty.restype = ctypes.c_int
        x11.XFree.argtypes = [ctypes.c_void_p]

        display = x11.XOpenDisplay(None)
        if not display:
            return None
        try:
            root = x11.XDefaultRootWindow(display)
            pid_atom = x11.XInternAtom(display, b"_NET_WM_PID", 1)
            wm_class_atom = x11.XInternAtom(display, b"WM_CLASS", 1)
            net_wm_name_atom = x11.XInternAtom(display, b"_NET_WM_NAME", 1)
            wm_name_atom = x11.XInternAtom(display, b"WM_NAME", 1)

            chain = []
            cur_win = root
            cur_x, cur_y = px, py
            for _ in range(32):
                dest_x = ctypes.c_int(0)
                dest_y = ctypes.c_int(0)
                child = ctypes.c_ulong(0)
                ok = x11.XTranslateCoordinates(
                    display, cur_win, cur_win, cur_x, cur_y,
                    ctypes.byref(dest_x), ctypes.byref(dest_y), ctypes.byref(child),
                )
                if not ok or child.value == 0:
                    break
                chain.append(int(child.value))
                # Translate root (px, py) into child coordinates for next descent step
                ok_child = x11.XTranslateCoordinates(
                    display, root, child.value, px, py,
                    ctypes.byref(dest_x), ctypes.byref(dest_y), ctypes.byref(ctypes.c_ulong(0)),
                )
                if not ok_child:
                    break
                cur_win = child.value
                cur_x, cur_y = dest_x.value, dest_y.value

            if not chain:
                return None

            collected_names = []
            resolved_pid = 0
            resolved_wid = chain[-1]
            for wid in reversed(chain):
                w_pid, w_names = _x11_window_pid_and_names(
                    x11, display, wid, pid_atom, wm_class_atom, net_wm_name_atom, wm_name_atom
                )
                collected_names.extend(w_names)
                if w_pid > 0 and resolved_pid == 0:
                    resolved_pid = w_pid
                    resolved_wid = wid
            return {"window_id": resolved_wid, "pid": resolved_pid, "names": collected_names}
        finally:
            x11.XCloseDisplay(display)
    except Exception:
        return None


def verify_pointer_target(app, window, window_rect, screen_x, screen_y, own_app=None):
    """Ensure `(screen_x, screen_y)` lies inside the target window and is owned
    by the target PID (not occluded by another app, password manager, or TerminalX)."""
    validate_screen_point_in_window(window_rect, screen_x, screen_y)
    reject_blocked_app(app, own_app=own_app)
    target_pid = pid_of(app)

    # Secondary AT-SPI check: reject if an active protected/blocked window covers this point.
    for candidate_app in attempt(lambda: list(desktop_apps()), []) or []:
        for _, candidate_win in windows_for(candidate_app):
            if not has_state(candidate_win, Atspi.StateType.ACTIVE):
                continue
            c_rect = screen_rect(candidate_win)
            if c_rect is None:
                continue
            if c_rect.x <= screen_x <= c_rect.x + c_rect.width and c_rect.y <= screen_y <= c_rect.y + c_rect.height:
                c_names = [name_of(candidate_app), name_of(candidate_win)]
                if is_own_app_identity(pid=pid_of(candidate_app), names=c_names, own_app=own_app):
                    raise RuntimeError("own_app_protected: pointer input stopped because a TerminalX window owns this screen coordinate")
                if is_blocked_app_identity(c_names):
                    raise RuntimeError(f'appBlocked("{name_of(candidate_app)}")')

    is_wayland = os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
    if is_wayland:
        if not has_state(window, Atspi.StateType.ACTIVE):
            raise RuntimeError("window_not_focused: pointer input on Wayland requires the target window to be active; bring it forward and retry")
        return

    if os.environ.get("DISPLAY"):
        hit = x11_topmost_window_at_point(screen_x, screen_y)
        if hit is None:
            raise RuntimeError(
                f"window_not_focused: no visible window owns screen coordinate ({round(screen_x)}, {round(screen_y)}); bring the target window forward and retry"
            )
        hit_pid = int(hit.get("pid") or 0)
        hit_names = list(hit.get("names") or [])
        if is_own_app_identity(pid=hit_pid, names=hit_names, own_app=own_app):
            raise RuntimeError("own_app_protected: pointer input stopped because a TerminalX window owns this screen coordinate")
        if is_blocked_app_identity(hit_names):
            raise RuntimeError(f'appBlocked("{hit_names[0] if hit_names else hit_pid}")')
        if target_pid > 0 and hit_pid != target_pid:
            if not (is_descendant_pid(hit_pid, target_pid) or is_descendant_pid(target_pid, hit_pid)):
                raise RuntimeError(
                    f"window_not_focused: screen coordinate ({round(screen_x)}, {round(screen_y)}) is occluded by another window (pid {hit_pid}, expected pid {target_pid}); bring the target window forward and retry"
                )


def require_positive_integer(value, name):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"{name} must be a positive integer")
    if parsed <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return parsed


def require_positive_number(value, name):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"{name} must be a positive number")
    if not math.isfinite(parsed) or parsed <= 0:
        raise RuntimeError(f"{name} must be a positive number")
    return parsed


def require_non_empty_string(value, name):
    if value is None or str(value) == "":
        raise RuntimeError(f"{name} is required")
    return str(value)


def click_at(x, y, button, count, modifiers=None):
    button = (button or "left").lower()
    buttons = {"left": ("b1p", "b1r"), "right": ("b3p", "b3r"), "middle": ("b2p", "b2r")}
    if button not in buttons:
        raise RuntimeError(f"unsupported mouse button: {button}")
    parsed_count = require_positive_integer(1 if count is None else count, "click_count")
    modifier_keys = click_modifier_keys(modifiers)
    if modifier_keys:
        modified_click_at(x, y, button, parsed_count, modifier_keys)
        return
    down, up = buttons[button]
    for _ in range(parsed_count):
        Atspi.generate_mouse_event(round(x), round(y), "abs")
        Atspi.generate_mouse_event(round(x), round(y), down)
        time.sleep(0.03)
        Atspi.generate_mouse_event(round(x), round(y), up)


def click_modifier_keys(raw):
    if raw is None:
        return []
    aliases = {
        "ctrl": "ctrl", "control": "ctrl", "cmdorctrl": "ctrl", "commandorcontrol": "ctrl",
        "shift": "shift", "alt": "alt", "option": "alt",
        "meta": "super", "super": "super", "win": "super", "cmd": "super", "command": "super",
    }
    parts = [part.strip().lower() for part in str(raw).split("+")]
    if not parts or any(not part or part not in aliases for part in parts):
        raise RuntimeError("click modifiers require modifier keys only")
    return list(dict.fromkeys(aliases[part] for part in parts))


def modified_click_at(x, y, button, count, modifier_keys):
    xdotool = shutil.which("xdotool")
    is_wayland = os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
    if not xdotool or is_wayland:
        raise RuntimeError("modified clicks require xdotool on an X11 session")
    button_number = {"left": "1", "middle": "2", "right": "3"}[button]
    command = [xdotool, "mousemove", "--sync", str(round(x)), str(round(y))]
    for modifier in modifier_keys:
        command.extend(["keydown", modifier])
    command.extend(["click", "--repeat", str(count), "--delay", "35", button_number])
    for modifier in reversed(modifier_keys):
        command.extend(["keyup", modifier])
    try:
        subprocess.run(command, check=True, timeout=5)
    finally:
        subprocess.run(
            [xdotool, *[item for modifier in reversed(modifier_keys) for item in ("keyup", modifier)]],
            check=False,
            timeout=2,
        )


def scroll_at(x, y, direction, pages):
    if direction is None or str(direction).strip() == "":
        raise RuntimeError("direction is required")
    direction = str(direction).lower()
    wheel_events = {
        "up": ("b4p", "b4r"),
        "down": ("b5p", "b5r"),
        "left": ("b6p", "b6r"),
        "right": ("b7p", "b7r"),
    }
    if direction not in wheel_events:
        raise RuntimeError(f"unsupported scroll direction: {direction}")
    down, up = wheel_events[direction]
    page_count = max(1, math.ceil(require_positive_number(1 if pages is None else pages, "pages")))
    for _ in range(page_count):
        Atspi.generate_mouse_event(round(x), round(y), "abs")
        Atspi.generate_mouse_event(round(x), round(y), down)
        time.sleep(0.03)
        Atspi.generate_mouse_event(round(x), round(y), up)


def drag_between(start, end):
    Atspi.generate_mouse_event(round(start[0]), round(start[1]), "abs")
    Atspi.generate_mouse_event(round(start[0]), round(start[1]), "b1p")
    for step in range(1, 13):
        x = start[0] + (end[0] - start[0]) * step / 12
        y = start[1] + (end[1] - start[1]) * step / 12
        Atspi.generate_mouse_event(round(x), round(y), "abs")
        time.sleep(0.02)
    Atspi.generate_mouse_event(round(end[0]), round(end[1]), "b1r")


def key_name(raw):
    aliases = {
        "return": "Return", "enter": "Return", "tab": "Tab", "escape": "Escape", "esc": "Escape",
        "backspace": "BackSpace", "delete": "Delete", "space": "space", "left": "Left", "right": "Right",
        "up": "Up", "down": "Down", "home": "Home", "end": "End", "insert": "Insert",
        "pageup": "Page_Up", "page_up": "Page_Up", "pagedown": "Page_Down", "page_down": "Page_Down",
    }
    return aliases.get(str(raw).lower(), str(raw))


def press_key(raw):
    name = key_name(raw)
    if len(name) == 1:
        Atspi.generate_keyboard_event(0, name, Atspi.KeySynthType.STRING)
        return
    if Gdk is None:
        raise RuntimeError("GDK is required for non-character key synthesis")
    Atspi.generate_keyboard_event(Gdk.keyval_from_name(name), None, Atspi.KeySynthType.PRESSRELEASE)


def hotkey(raw):
    key_spec = re.sub(r"(?i)commandorcontrol|cmdorctrl", "ctrl", str(raw))
    xdotool = shutil.which("xdotool")
    if xdotool:
        subprocess.run([xdotool, "key", key_spec], check=True)
        return
    if "+" in key_spec:
        raise RuntimeError("hotkey combinations require xdotool")
    press_key(key_spec)


def type_text(value):
    Atspi.generate_keyboard_event(0, str(value), Atspi.KeySynthType.STRING)


def paste_text(value):
    text = str(value)
    previous = read_clipboard()
    try:
        write_clipboard(text)
        hotkey("ctrl+v")
        # Why: X11 paste consumers may read the selection after the key event
        # returns, so keep the pasted text as the owner briefly before restore.
        time.sleep(CLIPBOARD_PASTE_SETTLE_SECONDS)
    finally:
        if previous is not None:
            write_clipboard(previous)
        else:
            # Why: if the clipboard had no readable prior value, do not leave
            # the agent-provided paste text in the user's system clipboard.
            write_clipboard("")


def read_clipboard():
    for command in (["wl-paste"], ["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]):
        if shutil.which(command[0]):
            try:
                result = subprocess.run(
                    command,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=CLIPBOARD_COMMAND_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                continue
            if result.returncode == 0:
                return result.stdout
    return None


def write_clipboard(value):
    if shutil.which("wl-copy"):
        subprocess.run(
            ["wl-copy"],
            input=value,
            check=True,
            text=True,
            timeout=CLIPBOARD_COMMAND_TIMEOUT_SECONDS,
        )
        return
    for command in (["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
        if not shutil.which(command[0]):
            continue
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        if process.stdin is not None:
            process.stdin.write(value)
            process.stdin.close()
        time.sleep(CLIPBOARD_OWNER_SETTLE_SECONDS)
        if process.poll() not in (None, 0):
            raise RuntimeError(f"{command[0]} failed to set clipboard")
        return
    raise RuntimeError("paste_text requires wl-copy, xclip, or xsel")


def set_value(node, value):
    if node is not None and bool(attempt(node.is_editable_text, False)):
        editable = attempt(node.get_editable_text_iface)
        if editable is not None and attempt(lambda: Atspi.EditableText.set_text_contents(editable, str(value)), False):
            return True
    value_iface = attempt(node.get_value_iface) if node is not None else None
    if value_iface is not None:
        return bool(attempt(lambda: Atspi.Value.set_current_value(value_iface, float(value)), False))
    return False


def run_operation(operation):
    tool = operation.get("tool")
    own_app = operation.get("ownApp")
    include_screenshot = not bool(operation.get("noScreenshot"))
    if tool == "handshake":
        return {"ok": True, "capabilities": handshake_response()}
    if tool == "list_apps":
        return {"ok": True, "apps": list_apps_response()}
    if tool == "list_windows":
        return {"ok": True, **list_windows_response(operation.get("app", ""), own_app=own_app)}
    if tool == "get_app_state":
        return {
            "ok": True,
            "snapshot": make_snapshot(
                operation.get("app", ""),
                include_screenshot,
                operation.get("windowId"),
                operation.get("windowIndex"),
                bool(operation.get("restoreWindow")),
                own_app=own_app,
            ),
        }

    app = find_app(operation.get("app", ""), own_app=own_app)
    _, window = choose_window(app, operation.get("windowId"), operation.get("windowIndex"))
    if operation.get("restoreWindow"):
        restore_window(app, window)
        _, window = choose_window(app, operation.get("windowId"), operation.get("windowIndex"))
    if tool in {"type_text", "press_key", "hotkey", "paste_text"}:
        require_keyboard_focus(window, operation, own_app=own_app)
    bounds = screen_rect(window)
    saved = operation.get("element")
    node = find_element(app, saved)
    from_node = find_element(app, operation.get("fromElement"))
    to_node = find_element(app, operation.get("toElement"))
    action = None

    if tool == "click":
        # Why: agents expect a click into a target app to make the next
        # keyboard action safe, even when the click uses an accessibility path.
        restore_window(app, window)
        preferred = preferred_action(node)
        click_count = (
            require_positive_integer(operation.get("click_count"), "click_count")
            if operation.get("click_count") is not None
            else 1
        )
        has_modifiers = bool(str(operation.get("modifiers") or "").strip())
        handled = not has_modifiers and operation.get("mouse_button", "left") == "left" and click_count <= 1 and perform_action(node, preferred)
        if not handled:
            px, py = screen_point(bounds, saved, operation.get("x"), operation.get("y"), node)
            verify_pointer_target(app, window, bounds, px, py, own_app=own_app)
            click_at(
                px,
                py,
                operation.get("mouse_button", "left"),
                click_count,
                operation.get("modifiers"),
            )
            action = {"path": "synthetic", "actionName": None, "fallbackReason": "actionUnsupported"}
        else:
            labels = action_labels(node)
            action = {"path": "accessibility", "actionName": labels[preferred] if preferred is not None and preferred < len(labels) else "action", "fallbackReason": None}
    elif tool == "perform_secondary_action":
        wanted = str(operation.get("action", "")).lower()
        for index, label in enumerate(action_labels(node)):
            if label.lower() == wanted and perform_action(node, index):
                action = {"path": "accessibility", "actionName": label, "fallbackReason": None}
                break
        else:
            raise RuntimeError(f'{operation.get("action", "")} is not a valid secondary action')
    elif tool == "scroll":
        # Why: pointer wheel events should land in the requested app window even
        # when another desktop window is currently foregrounded.
        restore_window(app, window)
        px, py = screen_point(bounds, saved, operation.get("x"), operation.get("y"), node)
        verify_pointer_target(app, window, bounds, px, py, own_app=own_app)
        scroll_at(px, py, operation.get("direction"), operation.get("pages"))
        action = {"path": "synthetic", "actionName": "scroll", "fallbackReason": None}
    elif tool == "drag":
        # Why: pointer drags are synthetic global input, so activate the target
        # window before using cached coordinates from its accessibility tree.
        restore_window(app, window)
        start = screen_point(bounds, operation.get("fromElement"), operation.get("from_x"), operation.get("from_y"), from_node, x_name="from_x", y_name="from_y")
        end = screen_point(bounds, operation.get("toElement"), operation.get("to_x"), operation.get("to_y"), to_node, x_name="to_x", y_name="to_y")
        verify_pointer_target(app, window, bounds, start[0], start[1], own_app=own_app)
        verify_pointer_target(app, window, bounds, end[0], end[1], own_app=own_app)
        drag_between(start, end)
        action = {"path": "synthetic", "actionName": "drag", "fallbackReason": None}
    elif tool == "type_text":
        type_text(require_non_empty_string(operation.get("text"), "text"))
        action = {"path": "synthetic", "actionName": "typeText", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "press_key":
        press_key(require_non_empty_string(operation.get("key"), "key"))
        action = {"path": "synthetic", "actionName": "pressKey", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "hotkey":
        hotkey(require_non_empty_string(operation.get("key"), "key"))
        action = {"path": "synthetic", "actionName": "hotkey", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "paste_text":
        paste_text(require_non_empty_string(operation.get("text"), "text"))
        action = {"path": "clipboard", "actionName": "paste", "fallbackReason": None, "verification": {"state": "unverified", "reason": "clipboard_paste"}}
    elif tool == "set_value":
        if not set_value(node, operation.get("value", "")):
            raise RuntimeError("element value is not settable")
        action = {"path": "accessibility", "actionName": "setValue", "fallbackReason": None}
    else:
        raise RuntimeError("unknown tool: " + str(tool))

    try:
        snapshot = make_snapshot(
            operation.get("app", ""),
            include_screenshot,
            operation.get("windowId"),
            operation.get("windowIndex"),
            own_app=own_app,
        )
    except Exception:
        if operation.get("windowId") is None and operation.get("windowIndex") is None:
            raise
        action.setdefault("verification", {"state": "unverified", "reason": "window_changed"})
        snapshot = make_snapshot(operation.get("app", ""), include_screenshot, None, None, own_app=own_app)

    return {"ok": True, "action": action, "snapshot": snapshot}


def main():
    try:
        ensure_desktop_bus()
        with open(sys.argv[1], "r", encoding="utf-8") as handle:
            operation = json.load(handle)
        print(json.dumps(run_operation(operation), separators=(",", ":")))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, separators=(",", ":")))


if __name__ == "__main__":
    main()
