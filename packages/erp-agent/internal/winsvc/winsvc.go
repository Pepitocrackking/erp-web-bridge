// Package winsvc ejecuta y administra el agente como servicio de Windows.
//
// En Windows usa el Service Control Manager (golang.org/x/sys/windows/svc);
// en otros sistemas todas las operaciones devuelven ErrUnsupported, de modo que
// el binario compila igual en Linux y macOS.
package winsvc

import (
	"context"
	"errors"
)

// DefaultName es el nombre del servicio si no se indica otro.
const DefaultName = "ErpAgent"

// ErrUnsupported: la operación solo existe en Windows.
var ErrUnsupported = errors.New("los servicios de Windows solo existen en Windows")

// RunFunc es el trabajo del servicio. Debe llamar a ready() cuando ya arrancó
// (configuración cargada, log abierto) y terminar cuando ctx se cancele. Si
// devuelve un error antes de ready, el servicio falla al iniciar; si devuelve
// cualquier cosa sin que se haya pedido detenerlo, el SCM lo cuenta como fallo
// y aplica las acciones de recuperación (reiniciarlo).
type RunFunc func(ctx context.Context, ready func()) error

// InstallOptions describe cómo se instala el servicio.
type InstallOptions struct {
	Name        string // por defecto DefaultName
	ExePath     string // ruta del erp-agent.exe; por defecto, el ejecutable actual
	ConfigPath  string // agent.yaml (obligatorio); se valida y se protege con ACL
	Account     string // "LocalService" (por defecto), "NetworkService" o "DOMINIO\usuario"
	Password    string // solo para una cuenta de usuario; nunca por la línea de comandos del servicio
	DisplayName string
	// DataDirs son carpetas donde el servicio escribe (base local, logs): se
	// crean si faltan y la cuenta recibe permiso de modificación sobre ellas.
	DataDirs []string
}

// Info es el estado de un servicio instalado.
type Info struct {
	Name       string
	State      string // stopped | start_pending | stop_pending | running | ...
	PID        uint32
	Account    string
	Automatic  bool
	Command    string
	Restarts   []string // acciones de recuperación, p. ej. "restart@5s"
	ResetAfter uint32   // segundos tras los que se reinicia el contador de fallos
}
