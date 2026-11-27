package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/agent"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/config"
	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/winsvc"
)

const serviceUsage = `uso: erp-agent service <acción> [opciones]

acciones:
  install     instala el servicio (arranque automático, reinicio ante fallo)
  uninstall   detiene y elimina el servicio (no borra configuración, base ni logs)
  start       arranca el servicio y espera a que esté en marcha
  stop        detiene el servicio y espera a que se detenga
  status      muestra el estado

opciones comunes:
  -name <nombre>     nombre del servicio (por defecto ` + winsvc.DefaultName + `)

opciones de install:
  -config <ruta>     archivo agent.yaml (obligatorio; se valida y se protege con permisos)
  -account <cuenta>  LocalService (por defecto), NetworkService o DOMINIO\usuario
  -password-env <VAR>  variable de entorno con la contraseña de una cuenta de usuario

Los secretos (api_key y dsn) van en agent.yaml, nunca en la línea de comandos.
Instalar y desinstalar exigen una consola de administrador.
`

// serviceCmd atiende "erp-agent service <acción>". Devuelve el código de salida.
func serviceCmd(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "-help" || args[0] == "--help" {
		fmt.Fprint(stderr, serviceUsage)
		return 2
	}
	action := args[0]
	fs := flag.NewFlagSet("service "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	name := fs.String("name", winsvc.DefaultName, "nombre del servicio")
	var cfgPath, account, passwordEnv *string
	if action == "install" {
		cfgPath = fs.String("config", "", "archivo agent.yaml")
		account = fs.String("account", "LocalService", "cuenta del servicio")
		passwordEnv = fs.String("password-env", "", "variable de entorno con la contraseña")
	}
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}

	var err error
	switch action {
	case "install":
		var opts winsvc.InstallOptions
		opts, err = installOptions(*name, *cfgPath, *account, getenv(*passwordEnv))
		if err == nil {
			if err = winsvc.Install(opts); err == nil {
				fmt.Fprintf(stdout, "servicio %q instalado (cuenta %s). Arráncalo con: erp-agent service start -name %s\n", *name, *account, *name)
			}
		}
	case "uninstall":
		if err = winsvc.Uninstall(*name); err == nil {
			fmt.Fprintf(stdout, "servicio %q desinstalado\n", *name)
		}
	case "start":
		if err = winsvc.Start(*name); err == nil {
			fmt.Fprintf(stdout, "servicio %q en marcha\n", *name)
		}
	case "stop":
		if err = winsvc.Stop(*name); err == nil {
			fmt.Fprintf(stdout, "servicio %q detenido\n", *name)
		}
	case "status":
		var info winsvc.Info
		if info, err = winsvc.Status(*name); err == nil {
			printStatus(stdout, info)
		}
	default:
		fmt.Fprintf(stderr, "acción desconocida: %q\n\n%s", action, serviceUsage)
		return 2
	}
	if err != nil {
		if errors.Is(err, winsvc.ErrUnsupported) {
			fmt.Fprintln(stderr, "error:", err)
			return 3
		}
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	return 0
}

// installOptions valida la configuración ANTES de tocar el sistema y calcula
// las carpetas donde el servicio escribirá.
func installOptions(name, cfgPath, account, password string) (winsvc.InstallOptions, error) {
	if strings.TrimSpace(cfgPath) == "" {
		return winsvc.InstallOptions{}, errors.New("falta -config <ruta de agent.yaml>")
	}
	abs, err := filepath.Abs(cfgPath)
	if err != nil {
		return winsvc.InstallOptions{}, err
	}
	cfg, err := config.Load(abs)
	if err != nil {
		return winsvc.InstallOptions{}, fmt.Errorf("la configuración no es válida, no se instala nada:\n%w", err)
	}
	return winsvc.InstallOptions{
		Name:       name,
		ConfigPath: abs,
		Account:    account,
		Password:   password,
		DataDirs:   dataDirs(cfg),
	}, nil
}

// serviceLogFile es el archivo de log del servicio: el configurado o, si falta,
// erp-agent.log junto a la base local (un servicio no tiene stderr).
func serviceLogFile(cfg *config.Config) string {
	if cfg.Log.File != "" {
		return cfg.Log.File
	}
	return filepath.Join(filepath.Dir(cfg.Store.Path), "erp-agent.log")
}

// dataDirs son las carpetas donde el servicio necesita escribir.
func dataDirs(cfg *config.Config) []string {
	dirs := []string{filepath.Dir(cfg.Store.Path)}
	if l := filepath.Dir(serviceLogFile(cfg)); l != dirs[0] {
		dirs = append(dirs, l)
	}
	return dirs
}

func printStatus(w io.Writer, i winsvc.Info) {
	fmt.Fprintf(w, "servicio:   %s\nestado:     %s\n", i.Name, i.State)
	if i.PID != 0 {
		fmt.Fprintf(w, "PID:        %d\n", i.PID)
	}
	fmt.Fprintf(w, "cuenta:     %s\narranque:   %s\nrecuperación: %s (reinicio del contador tras %ds)\ncomando:    %s\n",
		i.Account, map[bool]string{true: "automático", false: "manual"}[i.Automatic],
		strings.Join(i.Restarts, ", "), i.ResetAfter, i.Command)
}

// runAsService es el punto de entrada cuando el proceso lo arranca el SCM.
func runAsService(name, cfgPath string) error {
	return winsvc.RunService(name, func(ctx context.Context, ready func()) error {
		cfg, err := config.Load(cfgPath)
		if err != nil {
			return fmt.Errorf("error de configuración: %w", err)
		}
		cfg.Log.File = serviceLogFile(cfg)
		w, closer, err := agent.OpenLog(cfg.Log, nil)
		if err != nil {
			return fmt.Errorf("abrir el log: %w", err)
		}
		defer closer.Close()
		log := agent.NewLogger(w, cfg.Log)
		log.Info("servicio iniciando", "config", cfgPath, "log", cfg.Log.File)
		err = agent.Run(ctx, cfg, log, agent.Options{Ready: ready})
		if err != nil && !errors.Is(err, context.Canceled) {
			log.Error("el agente terminó con error", "error", err.Error())
			return err
		}
		log.Info("servicio detenido")
		return nil
	})
}
