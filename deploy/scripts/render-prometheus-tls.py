#!/usr/bin/env python3
"""Render a new operator-owned Prometheus config for the direct-TLS overlay.

Stdlib only. JSON is deliberately used as an unambiguous YAML subset. This does
not connect to a service, generate credentials, or replace an existing file.
"""
import argparse
import json
import os
from pathlib import Path
import re


def render(server_name: str) -> dict:
    # This is a certificate name, not a URL, shell fragment, or YAML expression.
    if (not 1 <= len(server_name) <= 253 or not server_name.isascii()
            or any(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', part) is None
                   for part in server_name.split('.'))):
        raise ValueError('invalid_certificate_server_name')
    return {
        'global': {'scrape_interval': '30s', 'evaluation_interval': '30s'},
        'scrape_configs': [
            {'job_name': 'prometheus', 'static_configs': [{'targets': ['prometheus:9090']}]},
            {'job_name': 'ingestion-gateway', 'metrics_path': '/metrics', 'scheme': 'https',
             'tls_config': {'ca_file': '/etc/prometheus/ingestion-ca.pem', 'server_name': server_name},
             'static_configs': [{'targets': ['ingest:8000']}]},
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-name', required=True, help='actual DNS SAN in the Gateway certificate')
    parser.add_argument('--output', type=Path, required=True, help='new file in an operator-owned directory')
    args = parser.parse_args()
    try:
        data = json.dumps(render(args.server_name), indent=2) + '\n'
        # Exclusive creation refuses files and symlinks rather than adopting a
        # live operator configuration. The config contains no secret material.
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            if os.name == 'posix':
                # Operator secret preparation commonly uses umask077. This file
                # is PUBLIC configuration and the non-root Prometheus UID must
                # read its bind mount; never relax the private parent directory.
                os.fchmod(stream.fileno(), 0o644)
            stream.write(data)
        print('prometheus_tls_config_created')
        return 0
    except (ValueError, OSError):
        parser.exit(1, 'prometheus_tls_config_not_created: invalid name or unavailable/new output required\n')


if __name__ == '__main__':
    raise SystemExit(main())
