import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('import_evidence', HERE / 'import_evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImportEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = (HERE.parent / 'validation/latest.json').read_bytes()
        cls.evidence = json.loads(raw)
        cls.digest = hashlib.sha256(raw).hexdigest()
        cls.payload = module.build_import(cls.evidence, cls.digest)

    def test_counts_and_unique_ids(self):
        counts = {kind: sum(e['type'] == kind for e in self.payload['events']) for kind in ['trace-create', 'agent-create', 'generation-create', 'tool-create', 'score-create']}
        self.assertEqual(counts['trace-create'], 5)
        self.assertEqual(counts['generation-create'], sum(len(a['api_turns']) for a in self.evidence['arms']))
        self.assertEqual(counts['tool-create'], sum(len(a['tool_calls']) for a in self.evidence['arms']))
        self.assertEqual(counts['score-create'], 25)
        self.assertEqual(len(set(e['id'] for e in self.payload['events'])), len(self.payload['events']))

    def test_ids_are_idempotent(self):
        second = module.build_import(self.evidence, self.digest)
        self.assertEqual([e['id'] for e in self.payload['events']], [e['id'] for e in second['events']])

    def test_parents_are_existing_observations(self):
        ids = {e['body']['id'] for e in self.payload['events'] if e['type'] in ['agent-create', 'generation-create', 'tool-create']}
        for e in self.payload['events']:
            if e['body'].get('parentObservationId'):
                self.assertIn(e['body']['parentObservationId'], ids)

    def test_hidden_tool_results_are_preserved_but_marked_invisible(self):
        trace_id = next(t['trace_id'] for t in self.payload['traces'] if t['mode'] == 'no_tool_results')
        for e in self.payload['events']:
            if e['type'] == 'tool-create' and e['body']['traceId'] == trace_id:
                self.assertFalse(e['body']['metadata']['visible_to_model'])
                self.assertTrue(e['body']['output']['local_execution_result'])

    def test_total_token_usage_reconciles(self):
        total = sum(e['body']['usage']['input'] + e['body']['usage']['output'] for e in self.payload['events'] if e['type'] == 'generation-create')
        self.assertEqual(total, self.evidence['analysis']['usage']['total_tokens'])

    def test_missing_latencies_are_explicit(self):
        for e in self.payload['events']:
            if e['type'] in ['generation-create', 'tool-create']:
                self.assertFalse(e['body']['metadata']['measured_latency_available'])
                self.assertEqual(e['body']['startTime'], e['body']['endTime'])

    def test_otlp_propagates_experiment_context_to_every_span(self):
        body = module.otlp_body(self.payload, 'dataset-id', 'item-id', {'annual_total_usd': 9602895.73})
        spans = body['resourceSpans'][0]['scopeSpans'][0]['spans']
        self.assertEqual(len(spans), sum(t['observations'] for t in self.payload['traces']))
        for span in spans:
            attrs = {a['key']: a['value'] for a in span['attributes']}
            self.assertEqual(attrs['langfuse.experiment.dataset.id']['stringValue'], 'dataset-id')
            self.assertEqual(attrs['langfuse.experiment.item.id']['stringValue'], 'item-id')
            self.assertIn('langfuse.experiment.item.root_observation_id', attrs)
            self.assertEqual(len(span['traceId']), 32)
            self.assertEqual(len(span['spanId']), 16)

    def test_experiment_scores_attach_to_item_roots(self):
        roots = {t['trace_id']: t['root_id'] for t in self.payload['traces']}
        for e in self.payload['events']:
            if e['type'] == 'score-create':
                self.assertEqual(e['body']['observationId'], roots[e['body']['traceId']])
                self.assertIn('timestamp', e['body'])


if __name__ == '__main__':
    unittest.main()
