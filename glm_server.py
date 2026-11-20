#!/usr/bin/env python3
"""
GLM Raios - servidor local com dados REAIS do GLM (GOES-19).

- Serve o app (index.html, app.js, ...) e a API  /api/flashes
- Baixa os arquivos GLM-L2-LCFA (NetCDF, a cada ~20 s) do bucket público
  noaa-goes19 na AWS (sem conta, sem chave), extrai flash_lat / flash_lon /
  hora de cada flash e mantém só os últimos minutos em memória.

Uso:   python3 glm_server.py [porta]        (padrão: 8080)
Requer: pip install -r requirements.txt     (netCDF4 + numpy)
"""

import faulthandler
import gzip
import json
import math
import os
import re
import struct
import sys
import threading
import time
import zlib
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from netCDF4 import Dataset

# ------------------------------------------------------------
# Configuração
# ------------------------------------------------------------
BUCKET = "noaa-goes19"          # GOES-19 = GOES-East (cobre as Américas)
SATELLITE = "GOES-19"
PRODUCT = "GLM-L2-LCFA"
KEEP_MIN = 35                   # minutos mantidos em memória
POLL_SEC = 30                   # intervalo de verificação de arquivos novos
WORKERS = 8                     # downloads em paralelo
# América do Sul (lat_min, lon_min, lat_max, lon_max)
BBOX = (-56.0, -82.0, 13.0, -34.0)

J2000_MS = int(datetime(2000, 1, 1, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "glm-raios/1.0 (radioamador)"}

STORE = {}   # key -> list[(lat, lon, t_ms)]
STATE = {"loaded": False, "error": None, "latest_ms": None, "updated_ms": None}
LOCK = threading.Lock()
PARSE_LOCK = threading.Lock()   # HDF5/netCDF4 NÃO é thread-safe: ler um arquivo por vez
faulthandler.enable()


# ------------------------------------------------------------
# S3 (acesso anônimo via HTTPS)
# ------------------------------------------------------------
def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def list_keys(prefix):
    keys, token = [], None
    while True:
        url = (f"https://{BUCKET}.s3.amazonaws.com/?list-type=2"
               f"&prefix={urllib.parse.quote(prefix)}")
        if token:
            url += "&continuation-token=" + urllib.parse.quote(token)
        root = ET.fromstring(http_get(url, timeout=20))
        keys += [e.text for e in root.findall(".//{*}Key")]
        trunc = root.find("{*}IsTruncated")
        if trunc is not None and trunc.text == "true":
            token = root.find("{*}NextContinuationToken").text
        else:
            return keys


def hour_prefixes(now, minutes):
    t = (now - timedelta(minutes=minutes + 1)).replace(minute=0, second=0, microsecond=0)
    out = []
    while t <= now:
        out.append(f"{PRODUCT}/{t.year}/{t.timetuple().tm_yday:03d}/{t.hour:02d}/")
        t += timedelta(hours=1)
    return out


_KEY_RE = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_e")


def key_start_ms(key):
    m = _KEY_RE.search(key)
    if not m:
        return None
    y, doy, hh, mm, ss, ds = map(int, m.groups())
    t = datetime(y, 1, 1, tzinfo=timezone.utc) + timedelta(
        days=doy - 1, hours=hh, minutes=mm, seconds=ss, milliseconds=ds * 100)
    return int(t.timestamp() * 1000)


# ------------------------------------------------------------
# Leitura do NetCDF
# ------------------------------------------------------------
def parse_file(data, start_ms):
    """Retorna lista de (lat, lon, t_ms) dos flashes dentro de BBOX."""
    with PARSE_LOCK:
        return _parse_locked(data, start_ms)


def _parse_locked(data, start_ms):
    ds = Dataset("glm.nc", mode="r", memory=data)
    try:
        if "flash_lat" not in ds.variables:
            return []
        lat = np.ma.filled(ds.variables["flash_lat"][:].astype("float64"), np.nan)
        lon = np.ma.filled(ds.variables["flash_lon"][:].astype("float64"), np.nan)
        off = np.ma.filled(
            ds.variables["flash_time_offset_of_first_event"][:].astype("float64"), np.nan)
        if lat.size == 0:
            return []

        # hora absoluta: offsets pequenos = relativos ao início do arquivo;
        # offsets grandes = segundos desde 2000-01-01 12:00 UTC
        if np.nanmax(np.abs(off)) > 3600:
            t_ms = J2000_MS + off * 1000.0
        else:
            t_ms = start_ms + off * 1000.0

        # cada arquivo cobre ~20 s a partir do início: nenhum flash pode ter hora
        # fora dessa janela (protege contra interpretação errada do offset)
        t_ms = np.clip(t_ms, start_ms - 2000, start_ms + 25000)

        ok = np.isfinite(lat) & np.isfinite(lon) & np.isfinite(t_ms)
        if "flash_quality_flag" in ds.variables:       # 0 = flash bom
            q = np.ma.filled(ds.variables["flash_quality_flag"][:], 0)
            ok &= (q == 0)
        ok &= (lat >= BBOX[0]) & (lat <= BBOX[2]) & (lon >= BBOX[1]) & (lon <= BBOX[3])

        return [(round(float(a), 3), round(float(b), 3), int(t))
                for a, b, t in zip(lat[ok], lon[ok], t_ms[ok])]
    finally:
        ds.close()


def fetch_parse(key):
    data = http_get(f"https://{BUCKET}.s3.amazonaws.com/{urllib.parse.quote(key)}")
    return key, parse_file(data, key_start_ms(key))


# ------------------------------------------------------------
# Atualização em segundo plano
# ------------------------------------------------------------
def refresh():
    now = datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    cutoff = now_ms - KEEP_MIN * 60000

    wanted = {}
    for p in hour_prefixes(now, KEEP_MIN):
        for k in list_keys(p):
            s = key_start_ms(k)
            if s is not None and s >= cutoff - 30000:
                wanted[k] = s

    with LOCK:
        new = [k for k in wanted if k not in STORE]

    if new:
        with ThreadPoolExecutor(WORKERS) as ex:
            futures = [ex.submit(fetch_parse, k) for k in new]
            for f in futures:
                try:
                    k, fl = f.result()
                    with LOCK:
                        STORE[k] = fl
                except Exception as e:  # arquivo falhou: tenta de novo no próximo ciclo
                    print("  aviso: falha ao ler arquivo:", e, flush=True)

    with LOCK:
        for k in [k for k in STORE if k not in wanted]:
            del STORE[k]
        STATE["latest_ms"] = max((key_start_ms(k) for k in STORE), default=None)
        STATE["updated_ms"] = now_ms
        STATE["loaded"] = True
        STATE["error"] = None
    print(f"[{now:%H:%M:%S}] {len(new)} arquivo(s) novo(s); "
          f"{sum(len(v) for v in STORE.values())} flashes em memória", flush=True)


def updater():
    while True:
        try:
            refresh()
        except Exception as e:
            with LOCK:
                STATE["error"] = str(e)
            print("erro ao atualizar:", e, flush=True)
        time.sleep(POLL_SEC)



# ------------------------------------------------------------
# Camada de nuvens: GOES-19 ABI Banda 13 (infravermelho "limpo", 10,3 µm)
# Baixa o disco completo (ABI-L2-CMIPF), reprojeta para o mapa (Web Mercator)
# e gera um PNG transparente: quanto mais frio o topo da nuvem, mais branco.
# ------------------------------------------------------------
SAT_BAND_RE = re.compile(r"CMIPF-M\dC13_G19_s")
SAT_BOUNDS = (-40.0, -80.0, 8.0, -30.0)   # lat_min, lon_min, lat_max, lon_max
SAT_WIDTH = 1100                          # largura em pixels (~0,045 grau)
SAT = {"png": None, "key": None, "time_ms": None, "error": None}


def geos_xy(lat_deg, lon_deg, lon0_deg, h, req, rpol):
    """lat/lon -> ângulos de varredura (x, y) do GOES-R (PUG, vol. 3)."""
    big_h = h + req
    phi = np.radians(lat_deg)
    lam = np.radians(lon_deg)
    lam0 = math.radians(lon0_deg)
    e2 = (req ** 2 - rpol ** 2) / req ** 2
    phic = np.arctan((rpol ** 2 / req ** 2) * np.tan(phi))
    rc = rpol / np.sqrt(1.0 - e2 * np.cos(phic) ** 2)
    sx = big_h - rc * np.cos(phic) * np.cos(lam - lam0)
    sy = -rc * np.cos(phic) * np.sin(lam - lam0)
    sz = rc * np.sin(phic)
    visible = big_h * (big_h - sx) >= sy ** 2 + (req ** 2 / rpol ** 2) * sz ** 2
    x = np.arcsin(-sy / np.sqrt(sx ** 2 + sy ** 2 + sz ** 2))
    y = np.arctan(sz / sx)
    return x, y, visible


def sat_grid():
    """Latitudes (linhas espaçadas em Mercator) e longitudes do PNG de saída."""
    lat_min, lon_min, lat_max, lon_max = SAT_BOUNDS
    merc = lambda la: math.log(math.tan(math.pi / 4 + math.radians(la) / 2))
    y_n, y_s = merc(lat_max), merc(lat_min)
    span = math.radians(lon_max - lon_min)
    height = int(round(SAT_WIDTH * (y_n - y_s) / span))
    ys = y_n - (np.arange(height) + 0.5) / height * (y_n - y_s)
    lats = np.degrees(2 * np.arctan(np.exp(ys)) - math.pi / 2)
    lons = lon_min + (np.arange(SAT_WIDTH) + 0.5) / SAT_WIDTH * (lon_max - lon_min)
    return np.meshgrid(lons, lats)          # (lon2d, lat2d)


def colorize(t):
    """Temperatura de brilho (K) -> RGBA. Nuvem fria = mais branca e opaca."""
    t = np.where(np.isfinite(t), t, 400.0)
    a = np.clip((253.0 - t) / 50.0, 0.0, 1.0)          # 0 em >=253 K, 1 em <=203 K
    tt = np.clip(t, 203.0, 253.0)
    r = np.interp(tt, [203, 223, 253], [225, 255, 150])
    g = np.interp(tt, [203, 223, 253], [200, 255, 175])
    b = np.interp(tt, [203, 223, 253], [255, 255, 200])
    alpha = (a ** 0.8) * 190.0
    return np.dstack([r, g, b, alpha]).astype(np.uint8)


def png_bytes(rgba):
    h, w, _ = rgba.shape
    raw = np.concatenate([np.zeros((h, 1), np.uint8), rgba.reshape(h, w * 4)], axis=1).tobytes()

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


def render_sat(data):
    with PARSE_LOCK:
        ds = Dataset("sat.nc", mode="r", memory=data)
        try:
            p = ds.variables["goes_imager_projection"]
            h = float(p.getncattr("perspective_point_height"))
            req = float(p.getncattr("semi_major_axis"))
            rpol = float(p.getncattr("semi_minor_axis"))
            lon0 = float(p.getncattr("longitude_of_projection_origin"))
            xs = np.ma.filled(ds.variables["x"][:].astype("float64"), np.nan)
            ys = np.ma.filled(ds.variables["y"][:].astype("float64"), np.nan)

            lon2d, lat2d = sat_grid()
            x, y, vis = geos_xy(lat2d, lon2d, lon0, h, req, rpol)
            ci = np.rint((x - xs[0]) / (xs[1] - xs[0])).astype(np.int64)
            rj = np.rint((y - ys[0]) / (ys[1] - ys[0])).astype(np.int64)
            ok = vis & np.isfinite(x) & np.isfinite(y) \
                & (ci >= 0) & (ci < xs.size) & (rj >= 0) & (rj < ys.size)

            t = np.full(lat2d.shape, np.nan, dtype=np.float32)
            if ok.any():
                j0, j1 = rj[ok].min(), rj[ok].max() + 1   # lê só o bloco necessário
                i0, i1 = ci[ok].min(), ci[ok].max() + 1
                sub = np.ma.filled(ds.variables["CMI"][j0:j1, i0:i1].astype("float32"), np.nan)
                t[ok] = sub[rj[ok] - j0, ci[ok] - i0]
        finally:
            ds.close()
    return png_bytes(colorize(t))


def refresh_sat():
    now = datetime.now(timezone.utc)
    keys = []
    for back in (0, 1):
        t = now - timedelta(hours=back)
        prefix = f"ABI-L2-CMIPF/{t.year}/{t.timetuple().tm_yday:03d}/{t.hour:02d}/"
        keys += [k for k in list_keys(prefix) if SAT_BAND_RE.search(k)]
    if not keys:
        return
    key = max(keys, key=lambda k: key_start_ms(k) or 0)
    if key == SAT["key"]:
        return
    data = http_get(f"https://{BUCKET}.s3.amazonaws.com/{urllib.parse.quote(key)}", timeout=180)
    png = render_sat(data)
    with LOCK:
        SAT.update(png=png, key=key, time_ms=key_start_ms(key), error=None)
    print(f"[{now:%H:%M:%S}] nuvens (banda 13) atualizadas: {key.split('/')[-1][:60]}", flush=True)


def sat_updater():
    while True:
        try:
            refresh_sat()
        except Exception as e:
            with LOCK:
                SAT["error"] = str(e)
            print("erro na camada de nuvens:", e, flush=True)
        time.sleep(60)

def iso(ms):
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


# ------------------------------------------------------------
# HTTP
# ------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/flashes":
            q = urllib.parse.parse_qs(url.query)
            try:
                minutes = max(1, min(KEEP_MIN, int(q.get("minutes", ["30"])[0])))
            except ValueError:
                minutes = 30
            limit = int(time.time() * 1000) - minutes * 60000
            with LOCK:
                flashes = [[la, lo, t] for v in STORE.values()
                           for la, lo, t in v if t >= limit]
                body = {
                    "satellite": SATELLITE,
                    "loaded": STATE["loaded"],
                    "error": STATE["error"],
                    "latest_ms": STATE["latest_ms"],
                    "updated_ms": STATE["updated_ms"],
                    "count": len(flashes),
                    "oldest": iso(min((f[2] for f in flashes), default=None)),
                    "newest": iso(max((f[2] for f in flashes), default=None)),
                    "flashes": flashes,
                }
            raw = json.dumps(body, separators=(",", ":")).encode()
            gz = len(raw) > 1024 and "gzip" in self.headers.get("Accept-Encoding", "")
            if gz:
                raw = gzip.compress(raw, 5)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            if gz:
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Vary", "Accept-Encoding")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return
        if url.path in ("/api/sat.png", "/api/sat.json"):
            with LOCK:
                png, tms, err = SAT["png"], SAT["time_ms"], SAT["error"]
            if url.path == "/api/sat.png":
                if png is None:
                    self.send_error(404, "camada de nuvens ainda nao disponivel")
                    return
                body, ctype, cache = png, "image/png", "max-age=120"
            else:
                body = json.dumps({
                    "available": png is not None,
                    "time_ms": tms,
                    "error": err,
                    "bounds": [[SAT_BOUNDS[0], SAT_BOUNDS[1]], [SAT_BOUNDS[2], SAT_BOUNDS[3]]],
                }).encode()
                ctype, cache = "application/json", "no-store"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if "/api/" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    threading.Thread(target=updater, daemon=True).start()
    threading.Thread(target=sat_updater, daemon=True).start()
    print(f"GLM Raios em http://localhost:{port}  (dados reais {SATELLITE})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
