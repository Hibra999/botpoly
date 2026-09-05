"""PMXT v2 Parquet -> canonical Botpoly books. No signing/network dependencies.

Only mapped complementary outcomes are reconstructed. Missing snapshots, fees,
gas, or historical metadata stay explicitly unverified. License: CC BY 4.0 PMXT.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def millis(value):
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            raise ValueError('Timestamp sin zona horaria')
        return int(value.timestamp() * 1000)
    if not isinstance(value, (int, float)) or value < 10**12:
        raise ValueError('Se requieren timestamps UTC en milisegundos')
    return int(value)


def levels(raw):
    values = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(values, list):
        raise ValueError('Snapshot sin niveles completos')
    result = {}
    for value in values:
        p, q = (value['price'], value['size']) if isinstance(value, dict) else value
        p, q = float(p), float(q)
        if not 0 < p < 1 or not q > 0:
            raise ValueError('Nivel inválido')
        result[p] = q
    return result


def import_file(source, mapping, output):
    import pyarrow.parquet as pq
    meta = json.loads(Path(mapping).read_text())
    if meta.get('schema') != 1 or not meta.get('markets'):
        raise ValueError('Se requiere mapping schema=1 con mercados y tokens YES/NO explícitos')
    frames, state, skipped = [], {}, 0
    selected = meta['markets']
    latest_received = 0
    parquet = pq.ParquetFile(source)
    required = ['timestamp_received', 'timestamp', 'market', 'event_type', 'asset_id', 'bids', 'asks', 'price', 'size', 'side']
    if any(c not in parquet.schema_arrow.names for c in required):
        raise ValueError('Esquema PMXT v2 incompatible: no se importan series de precios como libros')
    for batch in parquet.iter_batches(batch_size=16384, columns=required):
        # Input archives can contain different markets interleaved. Ordering is
        # checked per selected market; out-of-order changes cannot be guessed.
        for row in batch.to_pylist():
            market = row['market'].decode() if isinstance(row['market'], bytes) else row['market']
            if market not in selected:
                continue
            cfg = selected[market]
            token = row['asset_id']
            if token not in [cfg['yesTokenId'], cfg['noTokenId']]:
                continue
            received, timestamp = millis(row['timestamp_received']), millis(row['timestamp'])
            if timestamp > received or cfg.get('knownAt', received + 1) > received:
                skipped += 1
                continue
            books = state.setdefault(market, {})
            if received < books.get('_received', 0):
                raise ValueError('Cambios fuera de orden en un mercado; ordenar el archivo antes de importarlo')
            books['_received'] = received
            kind = row['event_type']
            if kind == 'book':
                books[token] = {'timestamp': timestamp, 'bids': levels(row['bids']), 'asks': levels(row['asks'])}
            elif kind == 'price_change' and token in books:
                if row['side'] not in ('BUY', 'SELL') or row['price'] is None or row['size'] is None:
                    raise ValueError('Cambio de libro inválido')
                side = 'bids' if row['side'] == 'BUY' else 'asks'
                price, size = float(row['price']), float(row['size'])
                if not 0 < price < 1 or size < 0:
                    raise ValueError('Cambio de nivel inválido')
                if size == 0:
                    books[token][side].pop(price, None)
                else:
                    books[token][side][price] = size
                books[token]['timestamp'] = timestamp
            else:
                skipped += 1
                continue
            if cfg['yesTokenId'] not in books or cfg['noTokenId'] not in books:
                continue
            def book(token_id):
                b = books[token_id]
                return {'tokenId': token_id, 'timestamp': b['timestamp'], 'minSize': cfg['minSize'], 'tickSize': cfg['tickSize'],
                        'bids': [{'price': p, 'size': q} for p, q in sorted(b['bids'].items(), reverse=True)],
                        'asks': [{'price': p, 'size': q} for p, q in sorted(b['asks'].items())]}
            # Metadata is valid only inside its historical validity window.
            fees = next((x for x in cfg.get('fees', []) if x['from'] <= timestamp < x['to'] and x['knownAt'] <= received), None)
            gas = next((x for x in cfg.get('gas', []) if x['from'] <= timestamp < x['to'] and x['knownAt'] <= received), None)
            frames.append({'id': f'pmxt:{market}:{received}:{len(frames)}', 'timestamp': received, 'marketId': market,
                           'eventId': cfg['eventId'], 'underlying': cfg.get('underlying') or cfg['eventId'], 'title': cfg['title'],
                           'binary': cfg.get('binaryVerified') is True, 'negRisk': cfg.get('negRisk', True),
                           'yes': book(cfg['yesTokenId']), 'no': book(cfg['noTokenId']), 'feeRate': fees['rate'] if fees else 0,
                           'feeVerified': bool(fees and fees.get('verified') and fees.get('exponent') == 1),
                           'mergeGasUsd': gas['mergeGasUsd'] if gas else 0, 'recoveryGasUsd': gas['recoveryGasUsd'] if gas else 0,
                           'gasVerified': bool(gas and gas.get('verified')), 'source': meta.get('source', 'https://archive.pmxt.dev/'), 'depth': True})
            latest_received = max(latest_received, received)
    if not frames:
        raise ValueError('No se encontraron ambos snapshots completos para los mercados mapeados')
    frames.sort(key=lambda f: (f['timestamp'], f['id']))
    out = Path(output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('x', encoding='utf8') as f:
        for frame in frames:
            f.write(json.dumps(frame, separators=(',', ':'), ensure_ascii=False) + '\n')
    from_ts = lambda t: dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).isoformat().replace('+00:00', 'Z')
    gaps, last = [], {}
    for frame in frames:
        if frame['marketId'] in last:
            gaps.append(frame['timestamp'] - last[frame['marketId']])
        last[frame['marketId']] = frame['timestamp']
    manifest = {'schema': 1, 'source': meta.get('source', 'https://archive.pmxt.dev/'), 'license': 'CC BY 4.0 — atribución: PMXT (https://pmxt.dev)',
                'collectedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'sha256': sha(out), 'sourceChecksum': sha(source), 'mappingChecksum': sha(mapping),
                'kind': 'events', 'coverage': {'from': from_ts(frames[0]['timestamp']), 'to': from_ts(frames[-1]['timestamp']), 'markets': list(last), 'frames': len(frames), 'maxGapMs': max(gaps, default=0)},
                'limitations': [f'{skipped} filas no reconstruibles o sin snapshot inicial omitidas.',
                                'Reconstrucción de eventos PMXT; no demuestra prioridad de cola ni ejecución real.',
                                'La ausencia de un evento no prueba continuidad de la captura; revisar cobertura antes de usar live.',
                                'Los costes y metadatos históricos requieren fuentes con fecha; si faltan, se bloquean entradas.']}
    Path(str(out) + '.manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'frames': len(frames), 'sha256': manifest['sha256'], 'skipped': skipped}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--mapping', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    import_file(args.input, args.mapping, args.out)
