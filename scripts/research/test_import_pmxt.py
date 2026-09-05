import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
import datetime as dt
import pyarrow as pa
import pyarrow.parquet as pq

spec = importlib.util.spec_from_file_location('import_pmxt', Path(__file__).with_name('import_pmxt.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImportTests(unittest.TestCase):
    def fixture(self, directory, rows):
        now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
        def record(asset, kind, offset, **changes):
            result = {'timestamp_received': now + dt.timedelta(milliseconds=offset + 10), 'timestamp': now + dt.timedelta(milliseconds=offset),
                      'market': b'market', 'asset_id': asset, 'event_type': kind, 'bids': '[["0.4","10"]]', 'asks': '[["0.45","10"]]', 'price': None, 'size': None, 'side': None}
            result.update(changes)
            return result
        table = pa.Table.from_pylist([record(*row[:3], **(row[3] if len(row) > 3 else {})) for row in rows])
        path = Path(directory)
        pq.write_table(table, path / 'sample.parquet')
        mapping = {'schema': 1, 'markets': {'market': {'yesTokenId': 'yes', 'noTokenId': 'no', 'eventId': 'event', 'title': 'test', 'minSize': 5, 'tickSize': .01, 'knownAt': 0, 'binaryVerified': True, 'negRisk': False}}}
        (path / 'mapping.json').write_text(json.dumps(mapping))
        return path

    def test_waits_for_both_books_and_applies_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory, [('yes', 'price_change', 0, {'price': .4, 'size': 4., 'side': 'BUY'}), ('yes', 'book', 10), ('no', 'book', 20), ('yes', 'price_change', 30, {'price': .4, 'size': 0., 'side': 'BUY'})])
            module.import_file(path / 'sample.parquet', path / 'mapping.json', path / 'out.jsonl')
            frames = [json.loads(x) for x in (path / 'out.jsonl').read_text().splitlines()]
            self.assertEqual(len(frames), 2)
            self.assertEqual(frames[-1]['yes']['bids'], [])
            self.assertFalse(frames[-1]['feeVerified'])
            self.assertFalse(frames[-1]['gasVerified'])
            manifest = json.loads((path / 'out.jsonl.manifest.json').read_text())
            self.assertEqual(manifest['sha256'], module.sha(path / 'out.jsonl'))

    def test_rejects_changes_out_of_order(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory, [('yes', 'book', 20), ('no', 'book', 10)])
            with self.assertRaises(ValueError):
                module.import_file(path / 'sample.parquet', path / 'mapping.json', path / 'out.jsonl')


if __name__ == '__main__':
    unittest.main()
