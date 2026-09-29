; 欢迎页：与启动画面同一段动画（石框描出 → `>` → 光标呼吸）。
; 帧由 npm run installer:sidebar 生成到 build/installer-anim/，这里用 nsDialogs 定时器逐帧换图。
; 只有欢迎页在动；安装进度页保持 NSIS 默认。

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER

Var AnimBitmap
Var AnimImage
Var AnimFrame
Var AnimHold

; 卸载器编译轮不引用这些函数，整段放进 ifndef 避免「未引用」告警被当成错误
!macro customWelcomePage
  Page custom yanWelcomeCreate yanWelcomeLeave
!macroend

Function yanWelcomeCreate
  nsDialogs::Create 1044
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  SetCtlColors $0 "" "0xFFFFFF"

  InitPluginsDir
  SetOutPath "$PLUGINSDIR\anim"
  File "${BUILD_RESOURCES_DIR}\installer-anim\frame-*.bmp"

  ${NSD_CreateBitmap} 0 0 109u 193u ""
  Pop $AnimBitmap
  StrCpy $AnimFrame 0
  StrCpy $AnimHold 0
  Call yanWelcomeShowFrame

  ${NSD_CreateLabel} 120u 14u 175u 30u "欢迎使用 砚 · Inkstone"
  Pop $0
  SendMessage $0 ${WM_SETFONT} 0 0
  SetCtlColors $0 "0x252522" "0xFFFFFF"
  ${NSD_CreateLabel} 120u 52u 175u 60u "本向导将把砚安装到这台电脑。$\r$\n$\r$\n点击「下一步」继续。"
  Pop $0
  SetCtlColors $0 "0x252522" "0xFFFFFF"

  ${NSD_CreateTimer} yanWelcomeTick 90
  nsDialogs::Show
  ${NSD_KillTimer} yanWelcomeTick
  ${If} $AnimImage != ""
    System::Call 'gdi32::DeleteObject(p $AnimImage)'
  ${EndIf}
FunctionEnd

; 帧序：0–11 描画，之后在 12（光标淡）与 11（光标亮）之间呼吸，每帧停 5 拍
Function yanWelcomeTick
  ${If} $AnimFrame < 11
    IntOp $AnimFrame $AnimFrame + 1
  ${Else}
    IntOp $AnimHold $AnimHold + 1
    ${If} $AnimHold >= 5
      StrCpy $AnimHold 0
      ${If} $AnimFrame == 11
        StrCpy $AnimFrame 12
      ${Else}
        StrCpy $AnimFrame 11
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Call yanWelcomeShowFrame
FunctionEnd

Function yanWelcomeShowFrame
  ${If} $AnimFrame < 10
    StrCpy $0 "0$AnimFrame"
  ${Else}
    StrCpy $0 "$AnimFrame"
  ${EndIf}
  ; LR_LOADFROMFILE|LR_CREATEDIBSECTION = 0x2010，IMAGE_BITMAP = 0
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\anim\frame-$0.bmp", i 0, i 0, i 0, i 0x2010) p .r1'
  SendMessage $AnimBitmap ${STM_SETIMAGE} ${IMAGE_BITMAP} $1 $2
  ${If} $AnimImage != ""
  ${AndIf} $2 != 0
    System::Call 'gdi32::DeleteObject(p $2)'
  ${EndIf}
  StrCpy $AnimImage $1
FunctionEnd

Function yanWelcomeLeave
FunctionEnd

!endif
