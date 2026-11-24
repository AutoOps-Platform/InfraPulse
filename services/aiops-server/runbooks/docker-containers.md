# InfraPulse Docker Container Operational Runbook

Applies to Docker containers monitored across Linux VMs (Alloy `prometheus.exporter.cadvisor "ctr"` on `unix:///var/run/docker.sock` + `infrapulse-docker-state.timer` writing `/var/lib/infrapulse-agent/textfile/containers.prom`) and Windows VMs (Scheduled Task `InfraPulse-DockerState` querying `\\.\pipe\docker_engine` into `C:\ProgramData\InfraPulse\textfile\containers.prom`). Filter by `server_id` and `container`.

## Container OOMKilled and Stopped or Dead Incident Triage

- **Domain:** `container` | **OS:** `any` | **Recommended Action:** `manual-review`
- **Signals:** `ContainerOOMKilled`, `ContainerStopped`, `ContainerDown`, `oom_killed`, `infrapulse_container_oom_killed`, `infrapulse_container_running`, `infrapulse_container_state_code`, `infrapulse_container_exit_code`, `container_oom_events_total`
- **Procedures:**
  1. CRITICAL POLICY: Autonomous restarts are STRICTLY FORBIDDEN for `infrapulse_container_oom_killed == 1`, `infrapulse_container_running == 0`, or `infrapulse_container_state_code == 4` (`dead`).
  2. Query AMP container telemetry: `container_oom_killed`, `container_running`, `container_state_code` (`1=running, 2=restarting, 3=paused, 4=dead, 5=created`), `container_memory_working_set_pct` (`container_memory_working_set_bytes / container_spec_memory_limit_bytes`), and `infrapulse_container_exit_code` (exit code `137` confirms SIGKILL/OOM).
  3. Inspect `infrapulse_container_info` labels (`image`, `compose_project`, `ports`, `state`, `health`) and `get_server_context`.
  4. Escalate immediately to the administrator with read-only RCA recommending memory limit tuning (`container_spec_memory_limit_bytes`) or heap dump investigation before restarting.

## Container Unhealthy and Restart Loop Remediation

- **Domain:** `container` | **OS:** `any` | **Recommended Action:** `restart-approved-container`
- **Signals:** `ContainerUnhealthy`, `ContainerRestartLoop`, `unhealthy`, `restarting`, `exited`, `infrapulse_container_health_code`, `infrapulse_container_restarts_total`, `infrapulse_container_state_code`
- **Procedures:**
  1. Query AMP container metrics: `infrapulse_container_health_code == 2` (`1=healthy, 2=unhealthy, 3=starting, 0=none`), `increase(infrapulse_container_restarts_total[15m]) >= 3`, and `infrapulse_container_state_code == 2` (`restarting`).
  2. Run read-only diagnostics (`collect-container-diagnostics`) and `get_server_context` to determine whether upstream dependencies or host memory pressure caused health probe failures.
  3. MEDIUM POLICY: `restart-approved-container` is NEVER allowlisted for auto-execution. Generate RCA understanding, proposed resolution, and brief traffic-interruption impact, then request Telegram HITL approval.
  4. Post-check after approved AWS SSM container restart: verify `infrapulse_container_running == 1` and `infrapulse_container_health_code == 1` for 5 consecutive minutes.

## Container CPU Throttling and High Memory Working Set

- **Domain:** `container` | **OS:** `any` | **Recommended Action:** `restart-approved-container`
- **Signals:** `ContainerHighMemory`, `ContainerHighCPU`, `throttled`, `container_cpu_usage_seconds_total`, `container_cpu_cfs_throttled_periods_total`, `container_cpu_cfs_periods_total`, `container_memory_working_set_bytes`, `container_memory_rss`
- **Procedures:**
  1. Query AMP for `container_cpu_usage_rate` (`rate(container_cpu_usage_seconds_total[5m])`), `container_cpu_throttled_pct` (`rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m]) * 100`), and `container_memory_working_set_pct`.
  2. Distinguish CFS CPU quota throttling (>25% throttled periods) from host-wide CPU exhaustion.
  3. Recommend raising container CPU/memory limits or propose `restart-approved-container` via HITL if a single container exhibits runaway memory working set growth.

## Safe Read-Only Container Diagnostics Collection

- **Domain:** `container` | **OS:** `any` | **Recommended Action:** `collect-container-diagnostics`
- **Signals:** `container_diagnostics`, `collect_container_diagnostics`, `infrapulse_docker_present`, `infrapulse_container_info`
- **Procedures:**
  1. LOW POLICY: `collect-container-diagnostics` is allowlisted as a safe read-only diagnostic action.
  2. Gather container inspect metadata, health probe output, recent exit codes, and `containers.prom` freshness via AWS SSM without mutating container runtime state.
  3. Verify `infrapulse_docker_present == 1` on the target host and confirm `infrapulse-docker-state.timer` (Linux) or `InfraPulse-DockerState` (Windows) is active.
