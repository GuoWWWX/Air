!include "Win\COM.nsh"
!include "LogicLib.nsh"

Var AirShortcutTarget

; Upgrades can retain a shortcut with an obsolete Explorer icon cache entry.
; Edit its icon in place to preserve the AppUserModelID and other link properties.
Function AirRefreshShortcutIcon
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  IfFileExists "$0" 0 done
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r1 ""
  ${If} $1 P<> 0
    ${IUnknown::QueryInterface} $1 '("${IID_IPersistFile}",.r2)'
    ${If} $2 P<> 0
      ${IPersistFile::Load} $2 '("$0",0).r3'
      ${If} $3 = 0
        ${IShellLink::GetPath} $1 '(.r4,${NSIS_MAX_STRLEN},0,0).r3'
        ${If} $3 = 0
        ${AndIf} $4 == "$AirShortcutTarget"
          ${IShellLink::SetIconLocation} $1 '("$AirShortcutTarget",-32512).r3'
          ${If} $3 = 0
            ${IPersistFile::Save} $2 '("$0",1).r3'
            ${If} $3 = 0
              System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w r0, p 0)'
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${IUnknown::Release} $2 ""
    ${EndIf}
    ${IUnknown::Release} $1 ""
  ${EndIf}
done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $AirShortcutTarget "$INSTDIR\${MAINBINARYNAME}.exe"
  Push "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  Call AirRefreshShortcutIcon
  Push "$DESKTOP\${PRODUCTNAME}.lnk"
  Call AirRefreshShortcutIcon
  Push "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${PRODUCTNAME}.lnk"
  Call AirRefreshShortcutIcon
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$AirShortcutTarget", p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --air-request-remove-tun-service' $0
    ${If} $0 <> 0
      Abort
    ${EndIf}
  ${EndIf}
!macroend
