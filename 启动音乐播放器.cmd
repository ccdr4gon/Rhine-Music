@echo off
rem Tauri Rust native client launcher; never start the legacy browser service.
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 goto directory_error

if exist "Rhine Music.exe" goto portable
if exist "rhine-music.exe" goto installed
if exist "src-tauri\target\release\rhine-music.exe" goto release
if exist "src-tauri\target\debug\rhine-music.exe" goto debug
echo 未找到 Rhine Music 客户端。请完整解压 Portable ZIP，或先运行 npm run desktop:build。
popd
pause
exit /b 1

:portable
start "" "Rhine Music.exe" --local
goto done
:installed
start "" "rhine-music.exe" --local
goto done
:release
start "" "src-tauri\target\release\rhine-music.exe" --local
goto done
:debug
start "" "src-tauri\target\debug\rhine-music.exe" --local
:done
popd
exit /b 0

:directory_error
echo 无法打开工程目录。请完整解压后再启动。
pause
exit /b 1

