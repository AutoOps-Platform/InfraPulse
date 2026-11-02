# Generated from a validated immutable InfraPulse profile; do not edit in place.
[global_tags]
  server_id = @SERVER_ID@
  agent_id = @AGENT_ID@
  os = @OS@

[agent]
  interval = "@INTERVAL@s"
  round_interval = true
  collection_jitter = "1s"
  flush_interval = "@INTERVAL@s"
  flush_jitter = "2s"
  # Batch counts Telegraf metrics, not protobuf series. Size is deliberately small.
  metric_batch_size = 100
  metric_buffer_limit = 1000
  precision = "1ms"
  debug = false
  quiet = false
  logfile = @LOGFILE@
  logfile_rotation_max_size = "10MB"
  logfile_rotation_max_archives = 3
  omit_hostname = false
