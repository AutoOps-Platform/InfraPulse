"""Auth failures remain finite and secret-free at runtime HTTP/log/metric boundaries."""
import httpx
import pytest

from app.main import create_app
from tests.integration.test_observability import records, samples, scrape, value

PATH = '/api/v1/ingest/remote-write'


@pytest.mark.parametrize('outcome,status,reason', [
    ('mismatch', 403, 'identity_mismatch'),
    ('inactive', 401, 'invalid_authorization'),
    ('malformed', 503, 'credential_verification_unavailable'),
    ('exception', 503, 'credential_verification_unavailable'),
])
async def test_auth_status_metrics_and_logs_are_allowlisted(app_client, headers, active_proof,
        api_key, make_write, pack_write, capsys, outcome, status, reason):
    assertions = []
    def management(request):
        assertions.append(request.headers['authorization'])
        if outcome == 'exception':
            raise RuntimeError('private-auth-exception-SENTINEL')
        if outcome == 'malformed':
            return httpx.Response(200, content=b'private-proof-body-SENTINEL')
        return httpx.Response(200, json=active_proof if outcome == 'mismatch' else {'active': False})
    claimed = [(k, b'private-claimed-ID-SENTINEL' if k == b'x-agent-id' and outcome == 'mismatch' else v)
               for k, v in headers]
    async with app_client(management_transport=httpx.MockTransport(management),
            upstream_transport=httpx.MockTransport(lambda request: pytest.fail('auth failure must not forward'))) as (app, client):
        response = await client.post(PATH + '?private-query-SENTINEL', headers=claimed, content=pack_write(make_write()))
        assert response.status_code == status
        assert response.json()['code'] == reason
        text = await scrape(client)
        assert value(text, 'requests_total', status=str(status)) == 1
        assert value(text, 'rejections_total', reason=reason) == 1
        assert value(text, 'inflight_requests') == app.state.pipeline.admission.inflight == 0
        assert sum(s.value for s in samples(text) if s.name.endswith('forward_attempts_total')) == 0
    captured = capsys.readouterr()
    combined = captured.out + captured.err + text + response.text + str(response.headers)
    for secret in [api_key, *assertions, active_proof['credential_id'], active_proof['server_id'],
                   active_proof['agent_id'], 'SENTINEL', 'Traceback']:
        assert secret not in combined
    parsed = records(captured)
    completions = [r for r in parsed if r.get('request_id') == response.headers['x-request-id']]
    assert len(completions) == 1
    assert completions[0]['status'] == status and completions[0]['error_code'] == reason
    assert 'series_count' not in completions[0]
    assert not any(r['event'] == 'identity_unverified' for r in parsed)
    assert any(r['event'] == 'lab_only' and r['level'] == 'WARNING' for r in parsed)


@pytest.mark.parametrize('failure', ['missing', 'unreadable', 'malformed', 'oversized', 'wrong-kind'])
async def test_cold_signing_config_failure_is_sanitized(tmp_path, monkeypatch, capsys, failure):
    path = tmp_path / 'private-path-SENTINEL.pem'
    if failure == 'unreadable':
        path.mkdir()
    elif failure == 'malformed':
        path.write_text('private-key-SENTINEL', encoding='utf-8')
    elif failure == 'oversized':
        path.write_bytes(b'private-key-SENTINEL' * 1000)
    elif failure == 'wrong-kind':
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives import serialization
        path.write_bytes(rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    monkeypatch.setenv('INGEST_SERVICE_SIGNING_KEY_FILE', str(path))
    app = create_app()
    with pytest.raises(RuntimeError) as caught:
        async with app.router.lifespan_context(app):
            pytest.fail('bad signing configuration must fail cold')
    assert str(caught.value) == 'Invalid ingestion gateway configuration.'
    assert caught.value.__suppress_context__
    assert not app.state.initialized
    captured = capsys.readouterr()
    assert 'SENTINEL' not in str(caught.value) + captured.out + captured.err


async def test_missing_runtime_auth_config_has_no_anonymous_fallback(monkeypatch, capsys):
    for name in ['MANAGEMENT_BASE_URL', 'GATEWAY_ID', 'SERVICE_KEY_ID', 'SERVICE_SIGNING_KEY_FILE']:
        monkeypatch.delenv('INGEST_' + name)
    monkeypatch.setenv('INGEST_ANONYMOUS_MODE', 'true')
    app = create_app()
    with pytest.raises(RuntimeError, match='^Invalid ingestion gateway configuration\\.$'):
        async with app.router.lifespan_context(app):
            pytest.fail('anonymous environment must not bypass required authentication')
    assert not app.state.initialized
    assert 'Traceback' not in capsys.readouterr().err
