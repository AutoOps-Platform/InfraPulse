package main

import (
	"github.com/AutoOps-Platform/InfraPulse/apps/grafana-app/pkg/plugin"
	"github.com/grafana/grafana-plugin-sdk-go/backend/app"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"os"
)

func main() {
	// Grafana's official process/RPC lifecycle only. No public HTTP signer/listener.
	if err := app.Manage(plugin.PluginID, plugin.NewApp, app.ManageOpts{}); err != nil {
		log.DefaultLogger.Error("infrapulse_plugin_start_failed")
		os.Exit(1)
	}
}
