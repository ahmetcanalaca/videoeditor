; Video Editör installer - NSIS 3.11, Unicode, PER-USER: no administrator rights, nothing outside the user's own profile.
; Compiled by scripts/make-installer.js, which passes /DVERSION=x.y.z  /DAPPDIR=<packaged app folder>  /DOUTFILE=<installer exe>
; /DICON=<icon.ico>  /DGEN=<folder with the generated file lists files-install.nsh and files-uninstall.nsh>  /DART=<folder with welcome.bmp>.
;
; Installer switches:  /S silent   /D=<folder> target folder (must be the LAST argument)   /LANG=tr|en   /DESKTOP desktop shortcut
;                      /NOASSOC no .vedproj association
; The folder page warns about a folder outside the user's own profile (other accounts of a shared PC could change files there); a silent install
; with /D= is the deployer's decision and is not asked.
; Uninstaller switches: /S silent   /PURGE also delete %APPDATA%\VideoEditor (settings, saved AI key, video analysis results, downloaded AI model)
; The uninstaller removes ONLY the files the installer put there (generated list) - it never deletes a folder recursively, whatever folder
; the user picked. The one exception is the application's own data folder %APPDATA%\VideoEditor, and only after the user said yes (and even
; there a junction or symbolic link is removed itself, never followed: un.SafeRmTree).
;
; This file is UTF-8 WITH a byte order mark (NSIS needs it to read the Turkish letters). Keep it that way.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
!ifdef FAST
  ; test builds only (scripts/make-installer.js --fast): quick to compile, bigger
  SetCompressor zlib
!else
  SetCompressor /SOLID lzma
  SetCompressorDictSize 64
!endif

!ifndef VERSION
  !error "run scripts/make-installer.js (it passes VERSION, APPDIR, OUTFILE, ICON and GEN)"
!endif
!ifndef APPDIR
  !error "APPDIR is missing"
!endif
!ifndef OUTFILE
  !error "OUTFILE is missing"
!endif
!ifndef ICON
  !error "ICON is missing"
!endif
!ifndef GEN
  !error "GEN is missing"
!endif
!ifndef ART
  !error "ART is missing (the folder with welcome.bmp)"
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"
!include "x64.nsh"
!insertmacro GetParameters
!insertmacro GetOptions
!insertmacro DirState
!insertmacro GetSize
!insertmacro un.GetParameters
!insertmacro un.GetOptions
!insertmacro un.GetSize

!define APP_NAME "Video Editör"
!define APP_FOLDER "Video Editor"
!define APP_ID "VideoEditor"
!define APP_EXE "VideoEditor.exe"
!define PROG_ID "VideoEditor.Project"
; the application's own data folder (the app's userData: settings.json, the encrypted AI key, the downloaded model). Only the test build
; (scripts/make-installer.js --fast) points it somewhere else, so that the tests never touch the real data of the person running them.
!ifndef DATA_DIR
  !define DATA_DIR "$APPDATA\VideoEditor"
!endif
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define APP_KEY "Software\${APP_ID}"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_FOLDER}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
BrandingText "${APP_NAME} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

;--------------------------------
; Pages

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ART}\welcome.bmp"
!define MUI_ABORTWARNING
!define MUI_LANGDLL_REGISTRY_ROOT HKCU
!define MUI_LANGDLL_REGISTRY_KEY "${APP_KEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "InstallerLanguage"
!define MUI_LANGDLL_WINDOWTITLE "${APP_NAME}"
!define MUI_LANGDLL_INFO "Kurulum dilini seçin / Select the setup language"
!define MUI_WELCOMEPAGE_TEXT "$(TXT_WELCOME)"
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "$(TXT_RUN)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Turkish first: it is the default language of the app and of this setup
!insertmacro MUI_LANGUAGE "Turkish"
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
!macro VERSION_KEYS LANG
  VIAddVersionKey /LANG=${LANG} "ProductName" "${APP_NAME}"
  VIAddVersionKey /LANG=${LANG} "ProductVersion" "${VERSION}"
  VIAddVersionKey /LANG=${LANG} "FileVersion" "${VERSION}.0"
  VIAddVersionKey /LANG=${LANG} "FileDescription" "${APP_NAME} setup"
  VIAddVersionKey /LANG=${LANG} "CompanyName" "${APP_NAME}"
  VIAddVersionKey /LANG=${LANG} "LegalCopyright" "${APP_NAME}"
!macroend
!insertmacro VERSION_KEYS ${LANG_TURKISH}
!insertmacro VERSION_KEYS ${LANG_ENGLISH}

;--------------------------------
; Texts (Turkish / English)

LangString SEC_MAIN ${LANG_TURKISH} "Video Editör (gerekli)"
LangString SEC_MAIN ${LANG_ENGLISH} "Video Editor (required)"
LangString SEC_DESKTOP ${LANG_TURKISH} "Masaüstü kısayolu"
LangString SEC_DESKTOP ${LANG_ENGLISH} "Desktop shortcut"
LangString SEC_ASSOC ${LANG_TURKISH} ".vedproj proje dosyalarını Video Editör ile aç"
LangString SEC_ASSOC ${LANG_ENGLISH} "Open .vedproj project files with Video Editor"

LangString DESC_MAIN ${LANG_TURKISH} "Uygulama, FFmpeg ve yerleşik yapay zeka çalışma ortamı. Başlat menüsüne kısayol eklenir. Yapay zeka modelinin kendisi (≈3,4 GB) kurulumla gelmez; isterseniz uygulama içinden tek tıkla indirilir."
LangString DESC_MAIN ${LANG_ENGLISH} "The application, FFmpeg and the built-in AI runtime. A Start menu shortcut is added. The AI model itself (≈3.4 GB) is not part of the setup; you can download it from inside the app with one click."
LangString DESC_DESKTOP ${LANG_TURKISH} "Masaüstüne Video Editör kısayolu ekler."
LangString DESC_DESKTOP ${LANG_ENGLISH} "Adds a Video Editor shortcut to the Desktop."
LangString DESC_ASSOC ${LANG_TURKISH} "Proje dosyalarına (.vedproj) çift tıklayınca Video Editör açılır (yalnızca bu kullanıcı için)."
LangString DESC_ASSOC ${LANG_ENGLISH} "Double-clicking a project file (.vedproj) opens Video Editor (for this user only)."

LangString TXT_WELCOME ${LANG_TURKISH} "Bu sihirbaz Video Editör ${VERSION} uygulamasını kuracak.$\r$\n$\r$\n•  Yönetici yetkisi gerekmez; yalnızca bu Windows kullanıcısı için kurulur.$\r$\n•  Video düzenleme tamamen çevrimdışı çalışır; API anahtarı veya hesap gerekmez.$\r$\n•  Yerleşik yapay zeka modeli isteğe bağlıdır ve kurulumla gelmez.$\r$\n$\r$\nDevam etmek için İleri'ye tıklayın."
LangString TXT_WELCOME ${LANG_ENGLISH} "This wizard will install Video Editor ${VERSION}.$\r$\n$\r$\n•  No administrator rights needed; it is installed for this Windows user only.$\r$\n•  Video editing works completely offline; no API key or account is needed.$\r$\n•  The built-in AI model is optional and is not part of the setup.$\r$\n$\r$\nClick Next to continue."
LangString TXT_RUN ${LANG_TURKISH} "Video Editör'ü şimdi başlat"
LangString TXT_RUN ${LANG_ENGLISH} "Start Video Editor now"
LangString TXT_PROJECT ${LANG_TURKISH} "Video Editör projesi"
LangString TXT_PROJECT ${LANG_ENGLISH} "Video Editor project"
LangString TXT_DIR_NOTEMPTY ${LANG_TURKISH} "Seçtiğiniz klasör boş değil. Video Editör, içinde 'Video Editor' adlı bir alt klasöre kurulsun mu?$\r$\n$\r$\nEvet: alt klasöre kur.   Hayır: seçtiğiniz klasöre kur."
LangString TXT_DIR_NOTEMPTY ${LANG_ENGLISH} "The folder you chose is not empty. Install Video Editor into a sub-folder named 'Video Editor' inside it?$\r$\n$\r$\nYes: use the sub-folder.   No: use the folder you chose."
LangString TXT_DIR_OUTSIDE ${LANG_TURKISH} "Seçtiğiniz klasör Windows kullanıcı klasörünüzün dışında. Birden fazla kişinin kullandığı bir bilgisayarda diğer hesaplar bu klasördeki program dosyalarını değiştirebilir ve değiştirilen dosyalar sizin adınıza çalışır.$\r$\n$\r$\nKendi kullanıcı klasörünüze (varsayılan) kurmak daha güvenlidir.$\r$\n$\r$\nEvet: başka bir klasör seçeyim.   Hayır: yine de buraya kur."
LangString TXT_DIR_OUTSIDE ${LANG_ENGLISH} "The folder you chose is outside your Windows user profile. On a computer that several people use, other accounts may be able to change the program files in it, and changed files would run as you.$\r$\n$\r$\nInstalling into your own profile folder (the default) is safer.$\r$\n$\r$\nYes: let me choose another folder.   No: install here anyway."

LangString MSG_CLOSE ${LANG_TURKISH} "Video Editör şu anda çalışıyor. Lütfen uygulamayı kapatın ve Yeniden dene'ye tıklayın."
LangString MSG_CLOSE ${LANG_ENGLISH} "Video Editor is running. Please close it and click Retry."
LangString MSG_PREVIOUS ${LANG_TURKISH} "Önceki sürüm kaldırılamadı. Uygulamanın kapalı olduğundan emin olup kurulumu yeniden başlatın."
LangString MSG_PREVIOUS ${LANG_ENGLISH} "The previous version could not be removed. Make sure the app is closed and start the setup again."
LangString MSG_X64 ${LANG_TURKISH} "Video Editör yalnızca 64 bit Windows 10/11 üzerinde çalışır."
LangString MSG_X64 ${LANG_ENGLISH} "Video Editor only runs on 64-bit Windows 10/11."
LangString UMSG_DATA ${LANG_TURKISH} "Ayarlarınız, kayıtlı yapay zeka anahtarınız, video analizi sonuçlarınız ve indirilmiş yapay zeka modeli ($0 MB) şu klasörde duruyor:$\r$\n${DATA_DIR}$\r$\n$\r$\nBunlar da silinsin mi? (Hayır'ı seçerseniz Video Editör'ü yeniden kurduğunuzda korunurlar.)"
LangString UMSG_DATA ${LANG_ENGLISH} "Your settings, saved AI key, video analysis results and the downloaded AI model ($0 MB) are stored in this folder:$\r$\n${DATA_DIR}$\r$\n$\r$\nDelete them too? (If you choose No they are kept for when you install Video Editor again.)"

;--------------------------------
; Helpers

; The running program locks its exe: if the exe cannot be opened for writing, the app is still running. A virus scanner may also hold a freshly
; written exe for a moment, so a silent run waits up to 30 s before it concludes that the app is running.
!macro CLOSE_CHECK un
Function ${un}CloseCheck
  Push $0
  Push $1
  StrCpy $1 0
  retry:
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXE}"
    Goto done
  ${EndIf}
  ClearErrors
  FileOpen $0 "$INSTDIR\${APP_EXE}" a
  ${IfNot} ${Errors}
    FileClose $0
    Goto done
  ${EndIf}
  ${If} ${Silent}
    IntOp $1 $1 + 1
    ${If} $1 < 60
      Sleep 500
      Goto retry
    ${EndIf}
    SetErrorLevel 5
    Abort
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(MSG_CLOSE)" IDRETRY retry
  Abort
  done:
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro CLOSE_CHECK ""
!insertmacro CLOSE_CHECK "un."

; An earlier installation of this program (recorded in the user's own registry hive, so a planted file elsewhere is never run) is removed first;
; the user's data is kept.
Function RemovePrevious
  ReadRegStr $R0 HKCU "${UNINST_KEY}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} ${FileExists} "$R0\uninstall.exe"
    ExecWait '"$R0\uninstall.exe" /S _?=$R0' $R1
    ${If} $R1 <> 0
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "$(MSG_PREVIOUS)"
      ${EndIf}
      SetErrorLevel 6
      Abort
    ${EndIf}
    Delete "$R0\uninstall.exe"
    RMDir "$R0"
  ${EndIf}
FunctionEnd

; $R9 = 1 when $INSTDIR lies inside the folder ${ROOT} (the comparison ignores upper/lower case; the trailing backslash makes "C:\Users\a" and
; "C:\Users\ab" different folders)
!macro CHECK_UNDER ROOT
  StrLen $R8 "${ROOT}\"
  StrCpy $R7 "$INSTDIR\" $R8
  ${If} $R7 == "${ROOT}\"
    StrCpy $R9 1
  ${EndIf}
!macroend

; A folder that already holds other things gets the choice of its own sub-folder. A folder outside the user's own profile gets a warning:
; a new folder there usually inherits "every account may modify" from its parent, so on a computer that several people use another account could
; replace the program files and have them run as this user (the default folder is inside the profile and only the user can write there).
Function DirLeave
  ${DirState} "$INSTDIR" $0
  ${If} $0 = 1
  ${AndIfNot} ${FileExists} "$INSTDIR\uninstall.exe"
    MessageBox MB_YESNO|MB_ICONQUESTION "$(TXT_DIR_NOTEMPTY)" IDNO keep
    StrCpy $INSTDIR "$INSTDIR\${APP_FOLDER}"
    keep:
  ${EndIf}
  StrCpy $R9 0
  !insertmacro CHECK_UNDER "$PROFILE"
  !insertmacro CHECK_UNDER "$LOCALAPPDATA"
  !insertmacro CHECK_UNDER "$APPDATA"
  ${If} $R9 = 0
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON1 "$(TXT_DIR_OUTSIDE)" IDNO outside_ok
    Abort ; stay on the folder page
    outside_ok:
  ${EndIf}
FunctionEnd

;--------------------------------
; Install

Section "$(SEC_MAIN)" SecMain
  SectionIn RO
  SetShellVarContext current
  Call CloseCheck
  Call RemovePrevious

  SetOutPath "$INSTDIR"
  !include "${GEN}\files-install.nsh"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  ; remembered for the uninstaller (MUI saves it too, but only when the pages are shown - not in a silent install)
  WriteRegStr HKCU "${APP_KEY}" "InstallerLanguage" "$LANGUAGE"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

Section /o "$(SEC_DESKTOP)" SecDesktop
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

Section "$(SEC_ASSOC)" SecAssoc
  WriteRegStr HKCU "Software\Classes\.vedproj" "" "${PROG_ID}"
  WriteRegStr HKCU "Software\Classes\${PROG_ID}" "" "$(TXT_PROJECT)"
  WriteRegStr HKCU "Software\Classes\${PROG_ID}\DefaultIcon" "" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROG_ID}\shell\open\command" "" '"$INSTDIR\${APP_EXE}" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "$(DESC_MAIN)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "$(DESC_DESKTOP)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAssoc} "$(DESC_ASSOC)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; (after the sections: their ${SecXxx} indexes exist only from here on)
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "$(MSG_X64)"
    Abort
  ${EndIf}
  ; Turkish unless the user picks English (dialog, or /LANG=en for scripted installs)
  StrCpy $LANGUAGE ${LANG_TURKISH}
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/LANG=" $R1
  ${If} ${Errors}
    !insertmacro MUI_LANGDLL_DISPLAY
  ${ElseIf} $R1 == "en"
    StrCpy $LANGUAGE ${LANG_ENGLISH}
  ${EndIf}
  ; switches for the optional components (they matter for silent installs)
  ClearErrors
  ${GetOptions} $R0 "/DESKTOP" $R1
  ${IfNot} ${Errors}
    !insertmacro SelectSection ${SecDesktop}
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/NOASSOC" $R1
  ${IfNot} ${Errors}
    !insertmacro UnselectSection ${SecAssoc}
  ${EndIf}
FunctionEnd

;--------------------------------
; Uninstall

Function un.onInit
  SetShellVarContext current
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

; Deletes a folder tree WITHOUT following junctions or symbolic links: a link is removed itself, never what it points to. (NSIS "RMDir /r" would
; follow a junction that was placed inside the folder and delete the files it points to.)
; In: top of the stack = the folder (it is removed as well).
Function un.SafeRmTree
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  FindFirst $1 $2 "$0\*.*"
  ${DoWhile} $2 != ""
    ${If} $2 != "."
    ${AndIf} $2 != ".."
      System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i .r3'
      IntOp $4 $3 & 0x400
      ${If} $4 <> 0
        ; a junction or symbolic link (FILE_ATTRIBUTE_REPARSE_POINT): only the link goes
        IntOp $4 $3 & 0x10
        ${If} $4 <> 0
          RMDir "$0\$2"
        ${Else}
          Delete "$0\$2"
        ${EndIf}
      ${Else}
        IntOp $4 $3 & 0x10
        ${If} $4 <> 0
          Push "$0\$2"
          Call un.SafeRmTree
        ${Else}
          SetFileAttributes "$0\$2" NORMAL
          Delete "$0\$2"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    FindNext $1 $2
  ${Loop}
  FindClose $1
  RMDir "$0"
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The application's own data (settings, the encrypted AI key, the downloaded model): kept unless the user says yes (or /PURGE is given).
Function un.AskPurge
  ${If} "$APPDATA" == ""
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "${DATA_DIR}\*.*"
    Return
  ${EndIf}
  ${un.GetParameters} $R0
  ClearErrors
  ${un.GetOptions} $R0 "/PURGE" $R1
  ${If} ${Errors}
    ${If} ${Silent}
      Return
    ${EndIf}
    ${un.GetSize} "${DATA_DIR}" "/S=0K" $0 $1 $2
    IntOp $0 $0 / 1024
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(UMSG_DATA)" IDYES purge
    Return
  ${EndIf}
  purge:
  Push "${DATA_DIR}"
  Call un.SafeRmTree
  Push "$TEMP\VideoEditor-cache"
  Call un.SafeRmTree
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Call un.CloseCheck

  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  ReadRegStr $0 HKCU "Software\Classes\.vedproj" ""
  ${If} $0 == "${PROG_ID}"
    DeleteRegKey HKCU "Software\Classes\.vedproj"
  ${EndIf}
  DeleteRegKey HKCU "Software\Classes\${PROG_ID}"

  !include "${GEN}\files-uninstall.nsh"
  Delete "$INSTDIR\uninstall.exe"
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"

  Call un.AskPurge
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
