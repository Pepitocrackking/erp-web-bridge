// Comando erp-agent: agente local outbound-only que lee el ERP y empuja
// los cambios por HTTPS a la API.
//
// Uso:
//
//	erp-agent -config agent.yaml            # corre hasta Ctrl+C
//	erp-agent -config agent.yaml -once      # un ciclo, vacía la cola y sale
//	erp-agent -config agent.yaml -reconcile # fuerza una reconciliación completa al arrancar
//	erp-agent -version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/agent"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/config"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/version"
)

func main() { os.Exit(run()) }

func run() int {
	var (
		cfgPath   = flag.String("config", "agent.yaml", "ruta del archivo de configuración YAML")
		once      = flag.Bool("once", false, "hacer un solo ciclo, vaciar la cola y salir")
		reconcile = flag.Bool("reconcile", false, "forzar una reconciliación completa al arrancar")
		showVer   = flag.Bool("version", false, "imprimir la versión y salir")
	)
	flag.Parse()

	if *showVer {
		fmt.Println(version.String())
		return 0
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error de configuración:", err)
		return 2
	}
	log := agent.NewLogger(os.Stderr, cfg.Log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := agent.Run(ctx, cfg, log, agent.Options{Once: *once, Reconcile: *reconcile}); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("el agente terminó con error", "error", err.Error())
		return 1
	}
	return 0
}
