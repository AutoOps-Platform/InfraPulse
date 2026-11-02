# SECRET FILE: Authorization contains the one-time issued Agent API key.
[[outputs.http]]
  url = @URL@
  method = "POST"
  timeout = "15s"
  use_batch_format = true
  # prometheusremotewrite serializes protobuf AND Snappy raw block itself.
  # Do not apply gzip or add a second compression layer.
  data_format = "prometheusremotewrite"
  content_encoding = "identity"
  prometheus_sort_metrics = true
  prometheus_string_as_label = false
  insecure_skip_verify = false
  tls_min_version = "TLS12"
  # Disable environment-derived HTTP(S)_PROXY in upstream Telegraf.
  use_system_proxy = false
@CA_OPTION@
  [outputs.http.headers]
    "Authorization" = @AUTHORIZATION@
    "Content-Type" = "application/x-protobuf"
    "Content-Encoding" = "snappy"
    "X-Prometheus-Remote-Write-Version" = "0.1.0"
    "User-Agent" = "InfraPulse-Telegraf/1.0.0"
    "X-Server-ID" = @SERVER_ID@
    "X-Agent-ID" = @AGENT_ID@
