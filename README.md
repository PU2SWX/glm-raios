# GLM Raios – Mapa para Radioamadores

Mapa de raios detectados pelo **Geostationary Lightning Mapper (GLM)** do satélite
**GOES-19** (NASA/NOAA), com dados reais quase em tempo real (atraso típico de ~1–2 min).

Feito para rodar no PC e ser aberto no celular, para compartilhar com amigos radioamadores.

<img width="1366" height="770" alt="GLM" src="https://github.com/user-attachments/assets/69843824-da4c-416c-afec-e28337024863" />

## Como usar

**Linux:** dê duplo clique em `GLM-Raios.desktop` ou rode `./iniciar-glm.sh`.
Na primeira vez ele cria uma `.venv` e instala o `netCDF4` sozinho.

**Windows:** veja `LEIA-ME-WINDOWS.txt` (`iniciar-glm.bat` ou `iniciar-glm-silencioso.vbs`).

**Manual (qualquer sistema):**

```bash
pip install -r requirements.txt     # netCDF4 + numpy
python3 glm_server.py               # abre em http://localhost:8080
```

A primeira execução baixa ~35 min de histórico (~100 arquivos de 0,3 MB) e leva cerca
de 1 minuto; o mapa mostra "Baixando dados do GLM…" nesse tempo.

No celular, abra `http://IP-DO-PC:8080` (mesma rede Wi-Fi).
Modo demonstração (dados fictícios): `http://localhost:8080/?demo`

## Como funciona

O `glm_server.py` serve o app e a API `/api/flashes?minutes=30`. Ele baixa os arquivos
`GLM-L2-LCFA` do bucket público `noaa-goes19` na AWS (sem conta, sem chave), extrai
`flash_lat`, `flash_lon` e a hora de cada flash, descarta flashes de baixa qualidade e
fora da América do Sul, e mantém os últimos ~35 min em memória, verificando arquivos
novos a cada 30 s. O botão Atualizar e o auto-refresh (90 s) consultam essa API.

## O que já tem

- Dados reais do GLM (GOES-19), com a idade do dado mais recente na barra de status
- Cores por idade do flash: vermelho (0–2 min), laranja (2–5), amarelo (5–15) e azul claro (15–30)
- Heatmap (botão 🔥) na mesma escala de cores
- Nuvens (botão ☁️): infravermelho do GOES-19 (banda 13), reprojetado pelo servidor a cada ~10 min; quanto mais frio o topo da nuvem, mais branco
- Mapas: claro, escuro (Esri Dark Gray, sem chave de API) e satélite
- Filtros rápidos: Brasil / Sudeste / Sul / Norte / Nordeste / América do Sul
- Botão de localização, contador de flashes e auto-refresh a cada 90 s
- `manifest.json` e service worker incluídos; para instalar como PWA falta adicionar `icon-192.png` e `icon-512.png` na pasta

## Problemas comuns

- **404 ou "Servidor GLM indisponível":** o servidor errado está na porta 8080 (ex.: um
  `python3 -m http.server` antigo). O `iniciar-glm.sh` já encerra isso; manualmente:
  `fuser -k 8080/tcp`.
- **Nada aparece no mapa:** abra `http://localhost:8080/api/flashes?minutes=30` e veja
  `loaded`, `error` e `count`. O log do servidor fica em `/tmp/glm-server.log` (Linux).
- **Muitos pontos deixam o celular lento:** use os filtros de região. Acima de 30.000 raios na região o app troca sozinho para o mapa de calor (constante `MAX_POINTS` no `app.js`).
- Observação técnica: a leitura de NetCDF é feita um arquivo por vez de propósito
  (a biblioteca HDF5 não é thread-safe e derrubava o servidor com leituras paralelas).

## Ideias futuras

- Alertas de atividade alta perto da sua posição
- Histórico das últimas horas
- Placefile para softwares de tempo (GRLevelX etc.)
- Integração com grupos de radioamadores (Telegram/WhatsApp)

## Segurança

O servidor escuta em `0.0.0.0:8080` **sem autenticação**, de propósito, para abrir no celular
pela mesma rede Wi-Fi. Use apenas em rede de confiança e **não exponha a porta na internet**.

## Créditos e fontes de dados

- Raios: Geostationary Lightning Mapper (GLM) e nuvens: ABI banda 13, ambos do **GOES-19**
  (NOAA/NASA), via bucket público `noaa-goes19` na AWS (NOAA Open Data Dissemination)
- Mapa: [Leaflet](https://leafletjs.com/) e [leaflet.heat](https://github.com/Leaflet/Leaflet.heat)
- Tiles: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors e Esri
  (Dark Gray, World Imagery). Respeite as políticas de uso de tiles de cada provedor; para uso
  intenso, configure sua própria fonte de tiles
- Radar de chuva: [RainViewer](https://www.rainviewer.com/api.html)
- Clima atual: [Open-Meteo](https://open-meteo.com/)

## Licença

[MIT](LICENSE) © 2026 Marcelo (PU2SWX)

---

Feito com curiosidade e 73.
