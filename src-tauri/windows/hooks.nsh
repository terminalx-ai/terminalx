; TerminalX installer hooks (Tauri NSIS bundler, bundle.windows.nsis.installerHooks).

; Removing TerminalX also removes the command line shims Settings > Install CLI
; wrote to %USERPROFILE%\.local\bin, and only those: a file of the same name is
; deleted only when its second line is the TerminalX shim's own. An update runs
; the uninstaller too ($UpdateMode = 1); the shims stay then, as the new version
; keeps using them.
!macro TERMINALX_REMOVE_SHIM NAME
  StrCpy $R0 "$PROFILE\.local\bin\${NAME}"
  IfFileExists "$R0" 0 +9
    ClearErrors
    FileOpen $R1 "$R0" r
    IfErrors +6
    FileRead $R1 $R2
    FileRead $R1 $R2
    FileClose $R1
    StrCmp $R2 "rem TerminalX CLI shim$\r$\n" 0 +2
    Delete "$R0"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    !insertmacro TERMINALX_REMOVE_SHIM "terminalx.cmd"
    !insertmacro TERMINALX_REMOVE_SHIM "tnx.cmd"
  ${EndIf}
!macroend
