"""Actual runtime key-parse and HTTPX socket/timeout fault probes, no mock transport."""
import asyncio
import json
from pathlib import Path
import httpx
from app.service_auth import ServiceSigner
from app.management_client import SignedManagementClient
from app.errors import GatewayError


def signer(path):
    return ServiceSigner(path, issuer='infrapulse-gateway', audience='infrapulse-management-internal', subject='task13-probe', kid='task13-gateway')


async def main():
    spec = json.loads(Path('/run/test/fault-input').read_text(encoding='utf-8'))
    try:
        signer('/run/test/malformed-key')
        raise AssertionError('Malformed key unexpectedly accepted')
    except GatewayError as error:
        print(str(error), flush=True)
    actual = signer('/run/test/signing-key')
    async with httpx.AsyncClient(trust_env=False, transport=httpx.AsyncHTTPTransport(retries=0)) as client:
        rpc = SignedManagementClient(client, actual, 'http://127.0.0.1:1', timeout_seconds=.1)
        try:
            await rpc.request('POST', '/unavailable/' + spec['sentinel'] + '?query=' + spec['sentinel'], spec['sentinel'].encode())
            raise AssertionError('Socket fault unexpectedly succeeded')
        except GatewayError as error:
            print(str(error), flush=True)
        async def slow(reader, writer):
            try:
                await reader.read(1024)
                await asyncio.sleep(.2)
            finally:
                writer.close()
        server = await asyncio.start_server(slow, '127.0.0.1', 0)
        async with server:
            rpc = SignedManagementClient(client, actual, 'http://127.0.0.1:' + str(server.sockets[0].getsockname()[1]), timeout_seconds=.05)
            try:
                await rpc.request('POST', '/timeout/' + spec['sentinel'], spec['sentinel'].encode())
                raise AssertionError('Timeout fault unexpectedly succeeded')
            except GatewayError as error:
                print(str(error), flush=True)
    print('task13_actual_key_socket_timeout_faults_ok', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
