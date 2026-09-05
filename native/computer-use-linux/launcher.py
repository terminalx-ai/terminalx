"""Compatibility entry point for the unmodified Legacy AT-SPI runtime.

libatspi's introspection bindings expose get_editable_text_iface(), while some
versions lack the is_editable_text() convenience method Legacy calls. Add only
that missing predicate and adapt key synthesis for older X11 registries.
The vendor runtime, rendering, and modifier-chord delivery stay unchanged.
This file is embedded in the Rust bridge and executed with python3 -c.
"""
import os
import runpy
import shutil
import subprocess
import sys


def install_compatibility(accessible_type):
    if not hasattr(accessible_type, "is_editable_text"):
        def is_editable_text(node):
            return node.get_editable_text_iface() is not None
        accessible_type.is_editable_text = is_editable_text


def install_keyboard_compatibility(atspi, wayland, xdotool=None, key_name=None):
    original = atspi.generate_keyboard_event

    def generate(keyval, keystring, synth_type):
        if synth_type == atspi.KeySynthType.STRING and not wayland:
            if xdotool:
                # Keep text out of argv, including secrets explicitly requested
                # by the user. xdotool owns the entire closed input sequence.
                subprocess.run([xdotool, "type", "--clearmodifiers", "--delay", "1", "--file", "-"],
                               input=keystring, text=True, check=True, timeout=20)
                return True
            # Old registryd releases cannot synthesize composed strings on X11.
            # Emit closed symbolic key events, with no fallback replay that
            # could duplicate a partially delivered string.
            for character in keystring:
                codepoint = ord(character)
                keysym = {"\n": 0xff0d, "\r": 0xff0d, "\t": 0xff09}.get(
                    character, codepoint if codepoint <= 0xff else 0x1000000 | codepoint)
                if original(keysym, None, atspi.KeySynthType.SYM) is False:
                    raise RuntimeError("keyboard synthesis failed")
            return True
        if synth_type == atspi.KeySynthType.PRESSRELEASE:
            if xdotool and not wayland and key_name:
                name = key_name(keyval)
                if name:
                    subprocess.run([xdotool, "key", "--clearmodifiers", name], check=True, timeout=5)
                    return True
            # Legacy passes GDK keysyms here, not X11 hardware keycodes.
            synth_type = atspi.KeySynthType.SYM
        result = original(keyval, keystring, synth_type)
        if result is False:
            raise RuntimeError("keyboard synthesis failed")
        return result

    atspi.generate_keyboard_event = generate


def main():
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
    except (ImportError, ValueError):
        # Let the runtime report its original dependency error. Overrides and
        # fake bridge scripts may not use AT-SPI at all.
        pass
    else:
        install_compatibility(Atspi.Accessible)
        wayland = os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland" or bool(os.environ.get("WAYLAND_DISPLAY"))
        def key_name(keyval):
            gi.require_version("Gdk", "3.0")
            from gi.repository import Gdk
            return Gdk.keyval_name(keyval)
        install_keyboard_compatibility(Atspi, wayland, shutil.which("xdotool"), key_name)
    sys.argv = sys.argv[1:]
    runpy.run_path(sys.argv[0], run_name="__main__")


if __name__ == "__main__":
    main()
