@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
if "%~1"=="" (
  python "%~dp0upload_r2.py"
) else (
  python "%~dp0upload_r2.py" %*
)
echo.
pause
