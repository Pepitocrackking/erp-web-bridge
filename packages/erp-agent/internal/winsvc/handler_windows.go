//go:build windows

package winsvc

import (
	"context"
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
)

// Códigos de salida específicos del servicio (los ve `sc query` y el Visor de eventos).
const (
	exitFailed      = 1 // la tarea falló, o terminó sin que se pidiera
	exitStopTimeout = 2 // pidieron detener y la tarea no terminó a tiempo
)

// Identificadores de eventos en el registro de eventos de Windows.
const (
	evStarted uint32 = 1
	evStopped uint32 = 2
	evFailed  uint32 = 3
)

const defaultStopTimeout = 30 * time.Second

// events es lo que se usa del registro de eventos (eventlog.Log lo cumple).
type events interface {
	Info(eid uint32, msg string) error
	Error(eid uint32, msg string) error
}

type nopEvents struct{}

func (nopEvents) Info(uint32, string) error  { return nil }
func (nopEvents) Error(uint32, string) error { return nil }

// handler implementa svc.Handler: traduce las órdenes del Service Control
// Manager a arrancar y cancelar la tarea.
type handler struct {
	run         RunFunc
	events      events
	stopTimeout time.Duration
}

// Execute lo invoca svc.Run en la goroutine del servicio.
func (h *handler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	timeout := h.stopTimeout
	if timeout <= 0 {
		timeout = defaultStopTimeout
	}

	status <- svc.Status{State: svc.StartPending, WaitHint: uint32(timeout / time.Millisecond)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		var once bool
		err := h.run(ctx, func() {
			if !once {
				once = true
				close(ready)
			}
		})
		done <- err
	}()

	// Arranque: hasta que la tarea avise que está lista o falle.
	select {
	case <-ready:
	case err := <-done:
		h.events.Error(evFailed, "el servicio no pudo iniciar: "+errText(err))
		return true, exitFailed
	}

	status <- svc.Status{State: svc.Running, Accepts: accepted}
	h.events.Info(evStarted, "servicio iniciado")

	for {
		select {
		case c := <-requests:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending, WaitHint: uint32(timeout / time.Millisecond)}
				cancel()
				select {
				case err := <-done:
					if err != nil && !errors.Is(err, context.Canceled) {
						h.events.Error(evFailed, "el servicio se detuvo con error: "+err.Error())
					} else {
						h.events.Info(evStopped, "servicio detenido")
					}
					return false, 0
				case <-time.After(timeout):
					h.events.Error(evFailed, fmt.Sprintf("la tarea no terminó en %s tras pedir la detención", timeout))
					return true, exitStopTimeout
				}
			}
		case err := <-done:
			// Terminó sin que nadie lo pidiera: es un fallo, para que el SCM aplique la recuperación.
			h.events.Error(evFailed, "el agente terminó inesperadamente: "+errText(err))
			return true, exitFailed
		}
	}
}

func errText(err error) string {
	if err == nil {
		return "sin error, pero sin que se pidiera detenerlo"
	}
	return err.Error()
}

// IsService informa si el proceso lo arrancó el Service Control Manager.
func IsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// RunService entrega el proceso al SCM y bloquea hasta que el servicio termina.
// Los hitos y fallos se anotan en el registro de eventos de Windows (origen =
// name) si está registrado; si no, se ignoran sin romper nada.
func RunService(name string, run RunFunc) error {
	var ev events = nopEvents{}
	if l, err := eventlog.Open(name); err == nil {
		defer l.Close()
		ev = l
	}
	return svc.Run(name, &handler{run: run, events: ev, stopTimeout: defaultStopTimeout})
}
