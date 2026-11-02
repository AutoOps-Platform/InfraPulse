"""Private-FD input; real HTTPX -> Gateway only. No lifecycle or I/O on import."""
from asyncio import run, timeout
import hashlib
import json
import os
from pathlib import Path
import sys

import cramjam
import httpx

from app.proto.remote_write_pb2 import WriteRequest


def scalar_payload(spec):
    # Independent hand-derived fixture (not the production decoder as oracle).
    fixture = Path(__file__).resolve().parents[4] / 'ingestion-gateway/tests/fixtures/remote_write_scalar.hex'
    message = WriteRequest.FromString(bytes.fromhex(fixture.read_text(encoding='utf-8')))
    series = message.timeseries[0]
    if [(x.name, x.value) for x in series.labels] != [('__name__', 'up')] or [(x.value, x.timestamp) for x in series.samples] != [(1.0, 1000)]:
        raise RuntimeError('Independent scalar fixture changed')
    series.ClearField('labels')
    labels = [('__name__', 'infrapulse_e2e_value'), ('run_id', spec['run_id'])]
    if spec['labels'] != 'missing':
        labels += [('server_id', str(__import__('uuid').uuid4()) if spec['labels'] == 'conflict' else spec['server_id']), ('agent_id', spec['agent_id'])]
    for name, value in sorted(labels):
        series.labels.add(name=name, value=value)
    series.samples[0].value = spec['value']
    series.samples[0].timestamp = spec['timestamp_ms']
    return bytes(cramjam.snappy.compress_raw(message.SerializeToString()))


async def send(spec):
    body = scalar_payload(spec)
    headers = {'Authorization': 'Bearer ' + spec['api_key'], 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0'}
    if spec['claim'] != 'missing':
        headers['X-Server-ID'] = str(__import__('uuid').uuid4()) if spec['claim'] == 'conflict' else spec['server_id']
        headers['X-Agent-ID'] = spec['agent_id']
    async with timeout(20), httpx.AsyncClient(base_url=spec['gateway_url'], trust_env=False, follow_redirects=False) as client:
        response = await client.post('/api/v1/ingest/remote-write', headers=headers, content=body, timeout=15)
        # Response body is captured privately for the sentinel scanner; never a
        # key-bearing assertion diff. Payload/headers/exception repr never printed.
        return {'status': response.status_code, 'response_body': response.text, 'payload_sha256': hashlib.sha256(body).hexdigest()}


if __name__ == '__main__':
    try:
        spec = json.loads(Path(os.environ['TASK13_REQUEST_FILE']).read_text(encoding='utf-8'))
        print(json.dumps(run(send(spec))), flush=True)
    except Exception as error:
        print(json.dumps({'sender_failure_class': type(error).__name__}), flush=True)
        sys.exit(1)
