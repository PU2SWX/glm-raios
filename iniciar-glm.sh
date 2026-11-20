#!/bin/bash

# ============================================================
# Lançador do GLM Raios (dados reais GOES-19)
# ============================================================

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

PORT=8080
URL="http://localhost:$PORT"
LOG="/tmp/glm-server.log"

aviso() {
    echo "$1"
    command -v notify-send >/dev/null 2>&1 && notify-send "GLM Raios" "$1"
}

# O servidor certo responde em /api/flashes (o http.server antigo dá 404)
servidor_ok() {
    curl -sf -o /dev/null "$URL/api/flashes?minutes=1" 2>/dev/null
}

if servidor_ok; then
    echo "Servidor já está rodando. Abrindo o mapa..."
else
    # Algo antigo (ex.: http.server) ocupando a porta? Encerra.
    if curl -s --head "$URL" >/dev/null 2>&1; then
        echo "Porta $PORT ocupada por servidor antigo. Encerrando..."
        fuser -k "$PORT"/tcp >/dev/null 2>&1 || pkill -f "http.server $PORT" 2>/dev/null
        sleep 1
    fi

    # Escolhe o Python (usa .venv se existir; cria se faltar o netCDF4)
    PY=python3
    [ -x .venv/bin/python ] && PY=.venv/bin/python
    if ! $PY -c "import netCDF4" 2>/dev/null; then
        echo "Instalando dependências (netCDF4) em .venv ..."
        if ! { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }; then
            aviso "Falha ao instalar dependências. Rode: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
            read -r -p "Enter para fechar..." _ 2>/dev/null
            exit 1
        fi
        PY=.venv/bin/python
    fi

    echo "Iniciando servidor na porta $PORT..."
    # setsid + nohup: o servidor continua rodando mesmo que este lançador/terminal feche
    setsid nohup $PY glm_server.py $PORT > "$LOG" 2>&1 < /dev/null &
    echo $! > /tmp/glm-server.pid

    # Espera até 20 s o servidor responder
    for i in $(seq 1 40); do
        servidor_ok && break
        sleep 0.5
    done

    if ! servidor_ok; then
        aviso "O servidor não iniciou. Veja o log: $LOG"
        echo "---- últimas linhas do log ----"
        tail -n 15 "$LOG"
        read -r -p "Enter para fechar..." _ 2>/dev/null
        exit 1
    fi
fi

echo "Abrindo $URL ..."
xdg-open "$URL" 2>/dev/null || \
  sensible-browser "$URL" 2>/dev/null || \
  x-www-browser "$URL" 2>/dev/null || \
  firefox "$URL" 2>/dev/null || \
  google-chrome "$URL" 2>/dev/null || \
  chromium-browser "$URL" 2>/dev/null

echo "Pronto! Para parar o servidor: kill \$(cat /tmp/glm-server.pid)"
