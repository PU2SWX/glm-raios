@echo off
title GLM Raios - Radioamadores
cd /d "%~dp0"

set PORT=8080
set URL=http://localhost:%PORT%

echo.
echo  ========================================
echo   GLM Raios - Mapa para Radioamadores
echo  ========================================
echo.

:: Verifica se o Python está disponível
where python >nul 2>&1
if %errorlevel%==0 (
    set PYTHON=python
    goto :start
)

where py >nul 2>&1
if %errorlevel%==0 (
    set PYTHON=py
    goto :start
)

echo [ERRO] Python nao encontrado!
echo.
echo Instale o Python em: https://www.python.org/downloads/
echo (marque a opcao "Add Python to PATH" durante a instalacao)
echo.
pause
exit /b 1

:start
echo Iniciando servidor na porta %PORT%...
echo.
echo Depois de usar, feche esta janela para parar o servidor.
echo.

:: Inicia o servidor em uma nova janela minimizada
%PYTHON% -c "import netCDF4" >nul 2>&1
if errorlevel 1 (
    echo Instalando dependencias...
    %PYTHON% -m pip install -r requirements.txt
)
start "GLM Server" /min %PYTHON% glm_server.py %PORT%

:: Espera o servidor subir
timeout /t 2 /nobreak >nul

:: Abre o navegador
echo Abrindo o mapa no navegador...
start "" "%URL%"

echo.
echo Pronto! O mapa deve ter aberto.
echo Mantenha esta janela aberta enquanto usar o mapa.
echo.
pause
