@echo off
chcp 65001 >nul
setlocal
set "SCRIPT_DIR=%~dp0"
set "PY_EXE=%SCRIPT_DIR%..\..\.venv\Scripts\python.exe"
set "AUTO_SUB=%SCRIPT_DIR%auto_sub.py"

if not exist "%PY_EXE%" (
    echo [LOI] Khong tim thay moi truong .venv tai: %PY_EXE%
    pause
    exit /b 1
)

echo ========================================================
echo   TAO PHU DE .SRT DICH SANG TIENG ANH BANG GPU WHISPER
echo ========================================================
echo.

if "%~1"=="" goto :picker
"%PY_EXE%" "%AUTO_SUB%" --model small --language auto --task translate %*
goto :done

:picker
"%PY_EXE%" "%AUTO_SUB%" --model small --language auto --task translate

:done
echo.
pause
