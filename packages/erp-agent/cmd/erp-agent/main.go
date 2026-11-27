// Comando erp-agent: agente local outbound-only que lee el ERP y empuja
// los cambios por HTTPS a la API.
//
// Uso:
//
//	erp-agent -config agent.yaml            # corre hasta Ctrl+C
//	erp-agent -config agent.yaml -once      # un ciclo, vacía la cola y sale
//	erp-agent -config agent.yaml -reconcile # fuerza una reconciliación completa al arrancar
//	erp-agent -version
//	erp-agent service install -config agent.yaml   # servicio de Windows (ver "erp-agent service")
//
// Cuando lo arranca el Service Control Manager de Windows, el mismo ejecutable
// detecta que es un servicio y corre sin consola, con el log en archivo.
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
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/winsvc"
)

func main() { os.Exit(run()) }

func run() int {
	if len(os.Args) > 1 && os.Args[1] == "service" {
		return serviceCmd(os.Args[2:], os.Getenv, os.Stdout, os.Stderr)
	}

	var (
		cfgPath     = flag.String("config", "agent.yaml", "ruta del archivo de configuración YAML")
		once        = flag.Bool("once", false, "hacer un solo ciclo, vaciar la cola y salir")
		reconcile   = flag.Bool("reconcile", false, "forzar una reconciliación completa al arrancar")
		showVer     = flag.Bool("version", false, "imprimir la versión y salir")
		serviceName = flag.String("service-name", winsvc.DefaultName, "nombre del servicio (lo pone la instalación; no se usa a mano)")
	)
	flag.Parse()

	if *showVer {
		fmt.Println(version.String())
		return 0
	}
	if winsvc.IsService() {
		if err := runAsService(*serviceName, *cfgPath); err != nil {
			return 1
		}
		return 0
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error de configuración:", err)
		return 2
	}
	w, closer, err := agent.OpenLog(cfg.Log, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error al abrir el log:", err)
		return 2
	}
	defer closer.Close()
	log := agent.NewLogger(w, cfg.Log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := agent.Run(ctx, cfg, log, agent.Options{Once: *once, Reconcile: *reconcile}); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("el agente terminó con error", "error", err.Error())
		return 1
	}
	return 0
}
