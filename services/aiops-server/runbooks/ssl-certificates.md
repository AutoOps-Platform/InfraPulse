# InfraPulse SSL Certificate Monitoring and Renewal Runbook

Covers both External HTTPS TLS targets probed every 60s by `management-ssl-prober` (`source="external"`, `media="external_https"`, labels `endpoint`, `target_name`, `target_group`, `subject_CN`, `issuer_CN`) and Local VM x509 certificate files/stores scanned every 5m (`source="local"`, `media="linux_file"` | `"windows_store"`, labels `server_id`, `managed_node_id`, `filepath`, `subject_CN`, `issuer_CN`) pushing `x509_cert_not_after`, `x509_cert_not_before`, and `x509_read_errors` to AMP.

## SSL Certificate Expired or Critical (<7 Days Remaining)

- **Domain:** `ssl` | **OS:** `any` | **Recommended Action:** `reprobe-ssl-target`
- **Signals:** `SSLCertExpired`, `SSLCertExpiringCritical`, `ssl_expired`, `cert_expired`, `sslcritical`, `x509_cert_not_after`, `days_remaining`
- **Procedures:**
  1. CRITICAL POLICY: Autonomous certificate modification or service reloads are strictly forbidden when `(x509_cert_not_after - time()) / 86400 < 7` (Critical) or `< 0` (Expired).
  2. Call `get_ssl_target_context` and query AMP `ssl_cert_days_remaining` to confirm `subject_CN`, `issuer_CN`, `not_after`, `authorized`, and whether `source` is `external` (`endpoint`) or `local` (`server_id` + `filepath`).
  3. Escalate immediately to the administrator with read-only RCA and exact certificate path or endpoint details.
  4. After the administrator renews and reloads the certificate, trigger `reprobe-ssl-target` (`POST /api/v1/ssl-targets/{id}/probe`) to verify the new expiry date in AMP.

## SSL Certificate Expiring Warning (7-28 Days Remaining) and Renewal Procedures

- **Domain:** `ssl` | **OS:** `any` | **Recommended Action:** `renew-ssl-certificate`
- **Signals:** `SSLCertExpiringWarning`, `sslwarning`, `expiring`, `7-28d`, `x509_cert_not_after`, `x509_cert_not_before`
- **Procedures:**
  1. MEDIUM POLICY: Generate RCA with target metadata (`get_ssl_target_context`) and await administrator HITL confirmation for renewal workflow.
  2. **Linux Local Certs (`media="linux_file"`):** Scanned from `/etc/letsencrypt/live/*/fullchain.pem`, `/etc/nginx/ssl/*.{crt,pem}`, `/etc/apache2/ssl/*.{crt,pem}`, and `/etc/infrapulse/certs/*.{crt,pem}` by `infrapulse-ssl-certs.timer` into `textfile/x509.prom`. Renew via `certbot renew --dry-run` followed by `certbot renew` and `systemctl reload nginx` (or `apache2`).
  3. **Windows Local Certs (`media="windows_store"`):** Scanned from `Cert:\LocalMachine\My` and `WebHosting` by Scheduled Task `InfraPulse-SslCerts` into `textfile/x509.prom`. Renew/import via `Import-PfxCertificate` or MMC, update IIS/service TLS binding, and verify the next 5-minute scrape.
  4. **External HTTPS Targets (`media="external_https"`):** Renew at the edge load balancer, CDN, or origin reverse proxy, then execute `reprobe-ssl-target` to confirm `days_remaining >= 28`.

## External HTTPS Prober and Local x509 Read Errors

- **Domain:** `ssl` | **OS:** `any` | **Recommended Action:** `reprobe-ssl-target`
- **Signals:** `SSLProbeOrReadError`, `x509_read_errors`, `DNS_TIMEOUT`, `TLS_TIMEOUT`, `PRIVATE_ADDRESS_BLOCKED`, `TLS_PROBE_FAILED`, `NO_PEER_CERTIFICATE`, `INVALID_CERTIFICATE_DATES`, `INVALID_TARGET`
- **Procedures:**
  1. Query AMP `ssl_read_errors` (`x509_read_errors > 0`) and call `get_ssl_target_context` to inspect `last_error` and `last_probed_at`.
  2. **SSRF Protection (`PRIVATE_ADDRESS_BLOCKED`):** `management-ssl-prober` intentionally blocks RFC1918/private/CGNAT/`169.254`/loopback/IP literals/`.local`/`.internal` addresses. Do not bypass SSRF protection; monitor private certificates using the local VM `x509.prom` scanner instead.
  3. **Transient Probe Errors (`DNS_TIMEOUT`, `TLS_TIMEOUT`, `TLS_PROBE_FAILED`):** For LOW severity probe verification, allowlisted `reprobe-ssl-target` (`POST /api/v1/ssl-targets/{id}/probe`) safely re-checks reachability (3s timeout).
  4. **Persistent Errors (`MEDIUM`):** Inspect DNS resolution, firewall egress (TCP 443), TLS SNI configuration, or local file read permissions (`x509_read_errors` on `linux_file`/`windows_store`), and present RCA for administrator HITL review.
