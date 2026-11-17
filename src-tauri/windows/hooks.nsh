; Developer Notch: NSIS hooks for the Tauri bundler (bundle.windows.nsis.installerHooks).
;
; The Tauri template inserts these macros:
; - NSIS_HOOK_PREINSTALL, at the start of `Section Install`, after `SetOutPath $INSTDIR` and
;   before any file, registry value or shortcut is written;
; - NSIS_HOOK_POSTUNINSTALL, at the end of `Section Uninstall`.
;
; The pre-install hook replaces Developer Notch 0.1.0 (Electron, electron-builder NSIS) with
; this version. 0.1.0 lives in a different folder and under a different uninstall key, so the
; Tauri installer would otherwise leave both installed, both starting at login.
; The 0.1.0 data in %APPDATA%\Developer Notch is never touched.
;
; This file is UTF-8 with a BOM so makensis reads the Spanish text correctly.

; electron-builder's uninstall GUID for appId `dev.developernotch.app`:
; UUID v5 of the appId in electron-builder's namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3.
!define DN_V010_GUID "38a9d2fb-eef1-505d-af16-fc0f6b0e6c06"
; Uninstall entry (UninstallString, QuietUninstallString, DisplayVersion...), no braces.
!define DN_V010_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${DN_V010_GUID}"
; electron-builder's own key with InstallLocation.
!define DN_V010_INSTKEY "Software\${DN_V010_GUID}"
!define DN_V010_UNINSTALLER "Uninstall Developer Notch.exe"
; Electron's setLoginItemSettings names the Run value after the AUMID, which 0.1.0 set to
; the appId. electron-builder's uninstaller does not remove it.
!define DN_V010_RUNVALUE "dev.developernotch.app"
!define DN_RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define DN_APPROVEDKEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

; Looks up the 0.1.0 uninstall entry under ROOT (HKCU or HKLM) in the current registry view.
; Out: $R2 = "1" if the entry exists, else "";
;      $R0 = install dir, $R1 = path of its uninstaller ("" when unknown);
;      $R3 = DisplayVersion.
; Clobbers $R4.
!macro DN_FIND_V010 ROOT
  StrCpy $R0 ""
  StrCpy $R1 ""
  StrCpy $R2 ""
  ReadRegStr $R3 ${ROOT} "${DN_V010_UNINSTKEY}" "UninstallString"
  ${If} $R3 != ""
    StrCpy $R2 "1"
    ; electron-builder stores the install dir in Software\<GUID>, InstallLocation.
    ReadRegStr $R0 ${ROOT} "${DN_V010_INSTKEY}" "InstallLocation"
    ${If} $R0 == ""
      ; Fallback: UninstallString is `"<dir>\Uninstall Developer Notch.exe" /currentuser`
      ; (or /allusers). Take the text between the first pair of quotes and keep its parent.
      StrCpy $R4 $R3 1
      ${If} $R4 == '"'
        StrCpy $R3 $R3 "" 1
        ${StrLoc} $R4 $R3 '"' ">"
        ${If} $R4 != ""
          StrCpy $R3 $R3 $R4
          ${GetParent} $R3 $R0
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $R0 != ""
      StrCpy $R1 "$R0\${DN_V010_UNINSTALLER}"
    ${EndIf}
    ReadRegStr $R3 ${ROOT} "${DN_V010_UNINSTKEY}" "DisplayVersion"
  ${EndIf}
!macroend

; Switches the registry view to the one recorded in $R6 ("64" or "32").
!macro DN_SET_VIEW_R6
  ${If} $R6 == "32"
    SetRegView 32
  ${Else}
    SetRegView 64
  ${EndIf}
!macroend

; Restores the view the Tauri template uses (its SetContext macro): 64 on x64 Windows.
!macro DN_RESTORE_VIEW
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    SetRegView default
  ${EndIf}
!macroend

; Leaves no trace of this installer before an Abort: SetOutPath already created $INSTDIR.
; RMDir without /r only removes it when empty, so an existing install is never touched.
!macro DN_ABORT_CLEANUP
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
!macroend

; Handles one 0.1.0 install that DN_FIND_V010 found: hive in $R5 ("HKCU" or "HKLM"), HKLM
; view in $R6, dir/uninstaller/version in $R0/$R1/$R3. Warns, uninstalls and cleans up;
; Cancel or a failed uninstall aborts the whole installation. Clobbers $R2, $R4, $R7.
!macro DN_HANDLE_V010
  ${If} $R1 == ""
    ; Neither Software\<GUID> InstallLocation nor a parsable UninstallString: the entry may
    ; still belong to a working 0.1.0, so leave it (and its keys) alone. Tell the user to
    ; remove it by hand and continue; electron-builder's installer never leaves this state.
    DetailPrint "Developer Notch 0.1.0: uninstall entry in $R5 without a known location, left alone."
    StrCpy $R7 "Developer Notch $R3 seems to be installed, but its folder could not be found. It was not uninstalled.$\r$\n$\r$\nIf it is still installed, uninstall it from Settings > Apps."
    !ifdef LANG_SPANISH
      ${If} $LANGUAGE == ${LANG_SPANISH}
        StrCpy $R7 "Parece que Developer Notch $R3 está instalado, pero no se encuentra su carpeta. No se ha desinstalado.$\r$\n$\r$\nSi sigue instalado, desinstálalo desde Configuración > Aplicaciones."
      ${EndIf}
    !endif
    MessageBox MB_OK|MB_ICONINFORMATION "$R7" /SD IDOK
  ${ElseIfNot} ${FileExists} "$R1"
    ; The location is known but the uninstaller is gone: a stale entry that cannot be run.
    ; Drop the orphan per-user keys (an HKLM one would need elevation; it is harmless).
    DetailPrint "Developer Notch 0.1.0: uninstall entry in $R5 without an uninstaller, skipped."
    ${If} $R5 == "HKCU"
      DeleteRegKey HKCU "${DN_V010_UNINSTKEY}"
      DeleteRegKey HKCU "${DN_V010_INSTKEY}"
    ${EndIf}
  ${Else}
    ; Step 2: warn in the installer language (es/en). OK uninstalls 0.1.0 and continues;
    ; Cancel aborts with nothing installed. Silent mode (/S) answers OK.
    StrCpy $R7 "Developer Notch $R3 is installed on this computer"
    ${If} $R5 == "HKLM"
      StrCpy $R7 "$R7 for all users"
    ${EndIf}
    StrCpy $R7 "$R7.$\r$\n$\r$\nThe installer will uninstall it first. Your data and settings (%APPDATA%\Developer Notch) are kept."
    ${If} $R5 == "HKLM"
      StrCpy $R7 "$R7$\r$\n$\r$\nWindows will ask for administrator permission for $\"Windows Command Processor$\" (cmd.exe), which runs the uninstaller of version $R3."
    ${EndIf}
    StrCpy $R7 "$R7$\r$\n$\r$\nOK: uninstall $R3 and continue.$\r$\nCancel: exit without installing anything."
    !ifdef LANG_SPANISH
      ${If} $LANGUAGE == ${LANG_SPANISH}
        StrCpy $R7 "Developer Notch $R3 está instalado en este equipo"
        ${If} $R5 == "HKLM"
          StrCpy $R7 "$R7 para todos los usuarios"
        ${EndIf}
        StrCpy $R7 "$R7.$\r$\n$\r$\nEl instalador lo desinstalará primero. Tus datos y ajustes (%APPDATA%\Developer Notch) se conservan."
        ${If} $R5 == "HKLM"
          StrCpy $R7 "$R7$\r$\n$\r$\nWindows pedirá permisos de administrador para el $\"Procesador de comandos de Windows$\" (cmd.exe), que ejecuta el desinstalador de la versión $R3."
        ${EndIf}
        StrCpy $R7 "$R7$\r$\n$\r$\nAceptar: desinstalar la $R3 y continuar.$\r$\nCancelar: salir sin instalar nada."
      ${EndIf}
    !endif
    ${If} ${Cmd} `MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$R7" /SD IDOK IDCANCEL`
      DetailPrint "Developer Notch 0.1.0 found; the user cancelled the installation."
      !insertmacro DN_ABORT_CLEANUP
      Abort
    ${EndIf}

    ; The processes started below inherit $OUTDIR as their working directory, and here it
    ; is $INSTDIR, which the user can write. cmd.exe searches it before PATH, so a planted
    ; reg.cmd would run elevated. Use the system folder; the end of the hook restores it.
    SetOutPath "$SYSDIR"

    ${If} $R5 == "HKCU"
      ; Steps 3-4, per user: no elevation needed. `_?=<dir>` makes the NSIS uninstaller run
      ; in place instead of copying itself to %TEMP% and returning at once, so ExecWait
      ; really waits. /currentuser matches the hive. No --delete-app-data: data is kept.
      DetailPrint "Uninstalling Developer Notch $R3 (current user)..."
      ExecWait '"$R1" /S /currentuser _?=$R0'
      ; Step 5: with `_?=` the uninstaller cannot delete itself. Remove it and the folder,
      ; but only once the uninstall entry is gone, so a failed run keeps a usable 0.1.0.
      ; RMDir without /r only removes an empty folder: nothing else is ever deleted.
      ReadRegStr $R2 HKCU "${DN_V010_UNINSTKEY}" "UninstallString"
      ${If} $R2 == ""
        Delete "$R1"
        RMDir "$R0"
      ${EndIf}
    ${Else}
      ; Steps 3-4, all users: this installer runs as the user (installMode currentUser), so
      ; it starts the uninstall with ShellExecute's "runas" verb (ExecShellWait), which
      ; raises one UAC prompt and waits for the process. A declined prompt fails the launch.
      ; The elevated process is cmd.exe so the leftover uninstaller and folder in Program
      ; Files (step 5) are removed under the same prompt. Its command line:
      ;   "<uninstaller>" /S /allusers _?=<dir>
      ;   & "<system>\reg.exe" query <uninstall key> || (del "<uninstaller>" & rmdir "<dir>")
      ; - /d skips AutoRun commands and /v:off disables delayed expansion (`!`);
      ; - every program is called by its full path; del and rmdir are cmd built-ins;
      ; - cmd /c waits for the uninstaller; `_?=` makes it run in place, as above;
      ; - the cleanup runs only if the uninstall entry is gone (reg query fails);
      ; - rmdir without /s only removes an empty folder.
      ; cmd would expand or split on % & ^ in the path, so such a path skips cmd and only
      ; runs the uninstaller (the empty folder and uninstaller then stay behind).
      StrCpy $R4 ""
      ${StrLoc} $R2 $R0 "%" ">"
      ${If} $R2 != ""
        StrCpy $R4 "1"
      ${EndIf}
      ${StrLoc} $R2 $R0 "&" ">"
      ${If} $R2 != ""
        StrCpy $R4 "1"
      ${EndIf}
      ${StrLoc} $R2 $R0 "^" ">"
      ${If} $R2 != ""
        StrCpy $R4 "1"
      ${EndIf}
      DetailPrint "Uninstalling Developer Notch $R3 (all users, elevated)..."
      ${If} $R4 == "1"
        ExecShellWait "runas" "$R1" '/S /allusers _?=$R0' SW_HIDE
      ${Else}
        ExecShellWait "runas" "$SYSDIR\cmd.exe" '/d /v:off /s /c ""$R1" /S /allusers _?=$R0& "$SYSDIR\reg.exe" query "HKLM\${DN_V010_UNINSTKEY}" /reg:$R6 >nul 2>nul || (del /f /q "$R1"& rmdir /q "$R0")"' SW_HIDE
      ${EndIf}
      !insertmacro DN_SET_VIEW_R6
      ReadRegStr $R2 HKLM "${DN_V010_UNINSTKEY}" "UninstallString"
      !insertmacro DN_RESTORE_VIEW
    ${EndIf}

    ; Step 7: a failed uninstall (error, UAC declined, uninstaller cancelled) aborts.
    ; Going on would leave 0.1.0 and 0.2.0 side by side, both starting at login and both
    ; with shortcuts that share the AUMID dev.developernotch.app: the state this hook
    ; exists to prevent. Aborting installs nothing, so the user can fix it and run again.
    ${If} $R2 != ""
      StrCpy $R7 "Developer Notch $R3 could not be uninstalled (or the administrator permission was declined). Nothing was installed.$\r$\n$\r$\nClose Developer Notch, or uninstall it from Settings > Apps, and run this installer again."
      !ifdef LANG_SPANISH
        ${If} $LANGUAGE == ${LANG_SPANISH}
          StrCpy $R7 "No se pudo desinstalar Developer Notch $R3 (o se rechazaron los permisos de administrador). No se ha instalado nada.$\r$\n$\r$\nCierra Developer Notch, o desinstálalo desde Configuración > Aplicaciones, y vuelve a ejecutar este instalador."
        ${EndIf}
      !endif
      MessageBox MB_OK|MB_ICONSTOP "$R7" /SD IDOK
      DetailPrint "Developer Notch 0.1.0 uninstall failed; installation aborted."
      !insertmacro DN_ABORT_CLEANUP
      Abort
    ${EndIf}
    DetailPrint "Developer Notch $R3 uninstalled. Data in %APPDATA%\Developer Notch kept."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Registers: $R0 dir, $R1 uninstaller, $R2 found flag / re-check, $R3 version,
  ; $R4 scratch, $R5 hive ("HKCU" or "HKLM"), $R6 HKLM view, $R7 message text.
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7

  StrCpy $R6 "64"

  ; Step 1: find 0.1.0. Per user first: HKCU\Software is shared by both views.
  !insertmacro DN_FIND_V010 HKCU
  ${If} $R2 == "1"
    StrCpy $R5 "HKCU"
    !insertmacro DN_HANDLE_V010
  ${EndIf}

  ; Then for all users, always: 0.1.0 can be installed both per user and per machine at once
  ; (different hives and folders), and both must go. electron-builder writes x64 apps to the
  ; 64-bit view (check64BitAndSetRegView); the 32-bit view is checked too, just in case.
  SetRegView 64
  !insertmacro DN_FIND_V010 HKLM
  ${If} $R2 != "1"
    SetRegView 32
    !insertmacro DN_FIND_V010 HKLM
    StrCpy $R6 "32"
  ${EndIf}
  !insertmacro DN_RESTORE_VIEW
  ${If} $R2 == "1"
    StrCpy $R5 "HKLM"
    !insertmacro DN_HANDLE_V010
  ${EndIf}

  ; Step 6: remove the 0.1.0 autostart value and its Task Manager state. Done even without
  ; a 0.1.0 install, since its uninstaller always left the value behind. Only 0.1.0 uses
  ; this name; this version's value is "Developer Notch". A cancel or failure aborted
  ; above, so a 0.1.0 that stays installed keeps its value.
  DeleteRegValue HKCU "${DN_RUNKEY}" "${DN_V010_RUNVALUE}"
  DeleteRegValue HKCU "${DN_APPROVEDKEY}" "${DN_V010_RUNVALUE}"

  ; Put SetOutPath back where the template expects it.
  SetOutPath "$INSTDIR"

  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The Tauri template already deletes HKCU\...\Run\${PRODUCTNAME} (the app's "start with
  ; Windows" value, see platform/autostart.rs) unless it runs in update mode. The app also
  ; writes the Task Manager "startup apps" state under StartupApproved\Run; remove it under
  ; the same condition so no startup entry is left behind.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${DN_APPROVEDKEY}" "${PRODUCTNAME}"
  ${EndIf}
!macroend
