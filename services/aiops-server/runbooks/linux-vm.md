# InfraPulse Linux VM Operational Runbook

Applies to Linux VMs onboarded via AWS SSM Agent (`3.3.5828.0`) and Grafana Alloy (`v1.22.0`), pushing metrics via AWS SigV4 (`service="aps"`, `ap-southeast-1`) to Amazon Managed Prometheus (AMP). Always filter metrics by `server_id`, `managed_node_id`, `enrollment_id`, and `platform="linux"` (never legacy `host` or `instance` labels).

## Linux CPU Saturation and PSI Pressure Triage

- **Domain:** `vm` | **OS:** `linux` | **Recommended Action:** `restart-approved-service`
- **Signals:** `LinuxCPUHigh`, `node_cpu_seconds_total`, `node_load1`, `node_load5`, `node_load15`, `node_pressure_cpu_waiting_seconds_total`, `node_procs_running`, `node_procs_blocked`
- **Procedures:**
  1. Query AMP (`linux_cpu_usage_pct`: `100 - avg by (server_id) (rate(node_cpu_seconds_total{mode="idle",server_id="<id>"}[5m])) * 100`) and check `node_load1`, `node_load5`, and `node_pressure_cpu_waiting_seconds_total`.
  2. Call `get_server_context` to inspect `managed_node_id`, `monitoring_health`, server groups, and `last_observed_sample_at`.
  3. Distinguish legitimate traffic spikes (`node_network_receive_bytes_total`, `node_sockstat_TCP_inuse`) from runaway worker threads (`node_procs_running`, `node_context_switches_total`).
  4. For MEDIUM severity (>85% sustained CPU), request administrator HITL approval before executing `restart-approved-service`.
  5. Post-check: Confirm CPU utilization drops below 70% and `node_pressure_cpu_waiting_seconds_total` rate stabilizes within 5 minutes.

## Linux Memory and Swap Pressure Triage

- **Domain:** `vm` | **OS:** `linux` | **Recommended Action:** `restart-approved-service`
- **Signals:** `LinuxMemoryHigh`, `LinuxMemoryCritical`, `node_memory_MemAvailable_bytes`, `node_memory_MemTotal_bytes`, `node_memory_SwapFree_bytes`, `node_memory_SwapTotal_bytes`, `node_pressure_memory_waiting_seconds_total`
- **Procedures:**
  1. Query AMP (`linux_memory_usage_pct`: `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100`) and `linux_swap_usage_pct` over the last 15 minutes.
  2. Inspect `node_pressure_memory_waiting_seconds_total` (PSI memory stall) and `node_memory_Slab_bytes` / `node_memory_SReclaimable_bytes` to detect kernel cache vs process RSS exhaustion.
  3. For MEDIUM severity (85%-95% RAM), do NOT auto-restart; propose `restart-approved-service` via Telegram HITL with graceful connection-drain impact.
  4. For CRITICAL severity (>95% RAM or OOM), autonomous execution is STRICTLY FORBIDDEN: perform read-only RCA and escalate immediately to the administrator.

## Linux Filesystem Disk Space and I/O Triage

- **Domain:** `vm` | **OS:** `linux` | **Recommended Action:** `cleanup-temp-directory`
- **Signals:** `LinuxDiskLow`, `node_filesystem_avail_bytes`, `node_filesystem_size_bytes`, `node_disk_io_time_seconds_total`, `node_pressure_io_waiting_seconds_total`, `temp_cleanup`, `log_rotate`
- **Procedures:**
  1. Query AMP (`linux_disk_usage_pct` using `node_filesystem_avail_bytes` and `node_filesystem_size_bytes`; virtual filesystems and `/(dev|proc|run|sys|snap|boot)` are already filtered out by Grafana Alloy).
  2. Check I/O contention via `node_disk_read_bytes_total`, `node_disk_written_bytes_total`, `node_disk_io_time_seconds_total`, and `node_pressure_io_waiting_seconds_total`.
  3. For LOW severity growth confined to `/tmp` or non-critical log directories, allowlisted actions `cleanup-temp-directory` or `rotate-noncritical-logs` are permitted.
  4. For root volume or persistent data mount exhaustion (<10% free or `DiskFull`), escalate immediately without deleting application data.

## Linux Host Down and Grafana Alloy / SSM Unreachable

- **Domain:** `vm` | **OS:** `linux` | **Recommended Action:** `manual-review`
- **Signals:** `VMHostDown`, `HostDown`, `alloy_down`, `up`, `node_boot_time_seconds`, `node_time_seconds`
- **Procedures:**
  1. CRITICAL POLICY: Automated remediation is strictly forbidden when `up{platform="linux"} == 0` or `alloy_down` fires.
  2. Call `get_server_context` to verify `managed_node_id`, `monitoring_health`, and `last_observed_sample_at` from `management-backend`.
  3. Check whether the host recently rebooted (`node_boot_time_seconds`) or lost outbound HTTPS (TCP 443) to AWS SSM / AMP (`ap-southeast-1`).
  4. Operator verification via AWS Systems Manager Session Manager: inspect `systemctl status amazon-ssm-agent alloy` and `/var/lib/infrapulse-agent/textfile/` permissions.
