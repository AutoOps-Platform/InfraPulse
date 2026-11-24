# InfraPulse Windows VM Operational Runbook

Applies to Windows VMs onboarded via AWS SSM Agent (`3.3.5828.0`) and Grafana Alloy (`v1.22.0`), shipping `windows_*` metrics to Amazon Managed Prometheus (AMP) via SigV4 (`service="aps"`, `ap-southeast-1`) tagged with `server_id`, `managed_node_id`, `enrollment_id`, and `platform="windows"`.

## Windows CPU Utilization and Processor Queue Saturation

- **Domain:** `vm` | **OS:** `windows` | **Recommended Action:** `restart-approved-service`
- **Signals:** `WindowsCPUHigh`, `windows_cpu_time_total`, `windows_cs_logical_processors`, `windows_system_processor_queue_length`, `windows_system_processes`, `windows_system_threads`
- **Procedures:**
  1. Query AMP (`windows_cpu_usage_pct` from `windows_cpu_time_total{mode="idle"}`) and `windows_processor_queue_length` (`windows_system_processor_queue_length`) alongside `windows_cs_logical_processors`.
  2. Sustained `windows_system_processor_queue_length > 2 * windows_cs_logical_processors` confirms CPU scheduling saturation rather than brief bursts.
  3. Inspect `windows_system_processes` and `windows_system_threads` plus `get_server_context` to identify impacted workload groups.
  4. Request administrator HITL approval before executing `restart-approved-service` on a Windows application service.

## Windows Memory Commit and Pagefile Pressure

- **Domain:** `vm` | **OS:** `windows` | **Recommended Action:** `restart-approved-service`
- **Signals:** `WindowsMemoryHigh`, `windows_memory_available_bytes`, `windows_cs_physical_memory_bytes`, `windows_memory_committed_bytes`, `windows_memory_commit_limit`, `windows_memory_swap_page_operations_total`
- **Procedures:**
  1. Query AMP (`windows_memory_usage_pct` using `windows_memory_available_bytes` and `windows_cs_physical_memory_bytes`) over 15 minutes.
  2. Check commit ratio (`windows_memory_committed_bytes / windows_memory_commit_limit`) and hard paging spikes (`rate(windows_memory_swap_page_operations_total[5m])`).
  3. For MEDIUM pressure (>85% RAM used), generate RCA and request administrator HITL approval before restarting the leaking Windows service.
  4. For CRITICAL exhaustion (>95% RAM or commit limit reached), escalate immediately with read-only RCA; never auto-execute restarts.

## Windows Logical Disk Space and Split I/O Triage

- **Domain:** `vm` | **OS:** `windows` | **Recommended Action:** `cleanup-temp-directory`
- **Signals:** `WindowsDiskLow`, `windows_logical_disk_free_bytes`, `windows_logical_disk_size_bytes`, `windows_logical_disk_read_bytes_total`, `windows_logical_disk_write_bytes_total`, `windows_logical_disk_split_ios_total`
- **Procedures:**
  1. Query AMP (`windows_disk_usage_pct` using `windows_logical_disk_free_bytes` and `windows_logical_disk_size_bytes`; `HarddiskVolume.*` volumes are dropped by Alloy).
  2. Correlate with `windows_logical_disk_read_bytes_total`, `windows_logical_disk_write_bytes_total`, and `windows_logical_disk_split_ios_total` to detect disk fragmentation or log floods.
  3. For LOW severity temporary directory buildup, allowlisted `cleanup-temp-directory` or `rotate-noncritical-logs` may run.
  4. For system drive `C:` critical low space, escalate to administrator via HITL without deleting unknown files.

## Windows Host Down and Grafana Alloy / SSM Health

- **Domain:** `vm` | **OS:** `windows` | **Recommended Action:** `manual-review`
- **Signals:** `VMHostDown`, `HostDown`, `alloy_down`, `up`, `windows_system_system_up_time`, `windows_system_boot_time_timestamp`, `windows_time_computed_time_offset_seconds`
- **Procedures:**
  1. CRITICAL POLICY: Automated remediation is forbidden when `up{platform="windows"} == 0` or `alloy_down` triggers.
  2. Call `get_server_context` to inspect `managed_node_id`, `monitoring_health`, and `last_observed_sample_at`.
  3. Check `windows_time_computed_time_offset_seconds` if metrics stopped due to AWS SigV4 clock skew (>5 minutes rejects AMP remote_write).
  4. Operator verification via AWS SSM / RDP: check `Get-Service AmazonSSMAgent, Alloy` and Scheduled Tasks `InfraPulse-DockerState` / `InfraPulse-SslCerts`.
