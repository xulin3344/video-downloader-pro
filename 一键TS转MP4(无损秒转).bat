@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title TS 视频一键无损转 MP4 工具 (FFmpeg 高速换壳)

echo ========================================================
echo        TS 视频一键无损转 MP4 工具 (零耗时·原画质秒转)
echo ========================================================
echo.

set "FFMPEG=C:\ProgramData\scoop\shims\ffmpeg.exe"
if not exist "%FFMPEG%" (
    where ffmpeg >nul 2>nul
    if %errorlevel% equ 0 (
        set "FFMPEG=ffmpeg"
    ) else (
        echo [错误] 未检测到 ffmpeg，请先确认安装 FFmpeg！
        pause
        exit /b 1
    )
)

:: 检查是否为拖拽文件进入
if not "%~1"=="" goto DRAG_MODE

echo 使用方式：
echo 1. 您可以直接把任意 .ts 视频文件【拖拽】到本批处理图标上，松开鼠标即可秒转！
echo 2. 或者直接选择下方选项，一键自动批量转换：
echo.
echo [1] 一键转换【下载目录】(Downloads) 中的全部 .ts 视频 (推荐)
echo [2] 一键转换【当前目录】中的全部 .ts 视频
echo [3] 退出
echo.
set /p choice="请输入选择 [1/2/3] (直接回车默认 1): "
if "%choice%"=="" set choice=1
if "%choice%"=="3" exit /b 0

if "%choice%"=="2" (
    set "TARGET_DIR=%~dp0"
) else (
    set "TARGET_DIR=%USERPROFILE%\Downloads"
)

echo.
echo 正在扫描目录: !TARGET_DIR! 中的所有 .ts 文件...
set count=0
for %%f in ("!TARGET_DIR!\*.ts") do (
    set /a count+=1
    echo.
    echo 正在转换 [!count!]: %%~nxf
    "%FFMPEG%" -i "%%f" -c copy "!TARGET_DIR!\%%~nf.mp4" -y -loglevel error
    if !errorlevel! equ 0 (
        echo --^> [完成] 已生成: "!TARGET_DIR!\%%~nf.mp4"
    ) else (
        echo --^> [失败] 转换失败
    )
)

if !count! equ 0 (
    echo 未在指定目录下找到任何 .ts 视频文件。
) else (
    echo.
    echo ========================================================
    echo  🎉 转换完成！共处理了 !count! 个视频，原画质无损秒级出片！
    echo ========================================================
    echo 提示：转换后的 .mp4 与原始 .ts 存放在同一目录下，原始文件已完整保留。
)

echo.
pause
exit /b 0

:DRAG_MODE
set count=0
:DRAG_LOOP
if "%~1"=="" goto DRAG_END
set /a count+=1
echo.
echo 正在转换 [%count%]: "%~nx1"
"%FFMPEG%" -i "%~1" -c copy "%~dp1%~n1.mp4" -y -loglevel error
if %errorlevel% equ 0 (
    echo --^> [完成] 已生成: "%~dp1%~n1.mp4"
) else (
    echo --^> [失败] 转换失败: "%~1"
)
shift
goto DRAG_LOOP

:DRAG_END
echo.
echo ========================================================
echo  🎉 拖拽文件已全部完成转换！
echo ========================================================
pause
exit /b 0
