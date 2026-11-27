//go:build windows

package winsvc

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
)

type fakeEvents struct {
	mu   sync.Mutex
	info []string
	errs []string
}

func (f *fakeEvents) Info(_ uint32, m string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.info = append(f.info, m)
	return nil
}
func (f *fakeEvents) Error(_ uint32, m string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs = append(f.errs, m)
	return nil
}
func (f *fakeEvents) errors() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.errs...)
}

// drive ejecuta Execute en una goroutine y devuelve los canales del SCM simulado.
type driver struct {
	req     chan svc.ChangeRequest
	status  chan svc.Status
	done    chan struct{}
	ssec    bool
	errno   uint32
	history []svc.State
}

func drive(h *handler) *driver {
	d := &driver{req: make(chan svc.ChangeRequest), status: make(chan svc.Status, 16), done: make(chan struct{})}
	go func() {
		d.ssec, d.errno = h.Execute(nil, d.req, d.status)
		close(d.done)
	}()
	return d
}

func (d *driver) waitState(t *testing.T, want svc.State) svc.Status {
	t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case s := <-d.status:
			d.history = append(d.history, s.State)
			if s.State == want {
				return s
			}
		case <-timeout:
			t.Fatalf("no llegó el estado %v; historial %v", want, d.history)
		}
	}
}

func (d *driver) waitDone(t *testing.T) {
	t.Helper()
	select {
	case <-d.done:
	case <-time.After(3 * time.Second):
		t.Fatal("Execute no terminó")
	}
}

func TestArrancaYSeDetieneConLimpieza(t *testing.T) {
	ev := &fakeEvents{}
	cleanExit := make(chan struct{})
	h := &handler{events: ev, stopTimeout: time.Second, run: func(ctx context.Context, ready func()) error {
		ready()
		<-ctx.Done()
		close(cleanExit)
		return ctx.Err()
	}}
	d := drive(h)
	st := d.waitState(t, svc.Running)
	if st.Accepts&svc.AcceptStop == 0 || st.Accepts&svc.AcceptShutdown == 0 {
		t.Fatalf("debe aceptar Stop y Shutdown: %v", st.Accepts)
	}
	d.req <- svc.ChangeRequest{Cmd: svc.Stop}
	d.waitState(t, svc.StopPending)
	d.waitDone(t)
	select {
	case <-cleanExit:
	default:
		t.Fatal("la tarea no vio la cancelación antes de que Execute terminara")
	}
	if d.ssec || d.errno != 0 {
		t.Fatalf("una parada pedida es salida limpia, devolvió (%v, %d)", d.ssec, d.errno)
	}
	if len(ev.errors()) != 0 {
		t.Fatalf("no debe registrar errores: %v", ev.errors())
	}
}

func TestShutdownTambienDetiene(t *testing.T) {
	h := &handler{events: &fakeEvents{}, stopTimeout: time.Second, run: func(ctx context.Context, ready func()) error {
		ready()
		<-ctx.Done()
		return nil
	}}
	d := drive(h)
	d.waitState(t, svc.Running)
	d.req <- svc.ChangeRequest{Cmd: svc.Shutdown}
	d.waitDone(t)
	if d.ssec || d.errno != 0 {
		t.Fatalf("(%v, %d)", d.ssec, d.errno)
	}
}

func TestInterrogateDevuelveElEstadoActual(t *testing.T) {
	h := &handler{events: &fakeEvents{}, stopTimeout: time.Second, run: func(ctx context.Context, ready func()) error {
		ready()
		<-ctx.Done()
		return nil
	}}
	d := drive(h)
	d.waitState(t, svc.Running)
	cur := svc.Status{State: svc.Running, Accepts: svc.AcceptStop}
	d.req <- svc.ChangeRequest{Cmd: svc.Interrogate, CurrentStatus: cur}
	select {
	case got := <-d.status:
		if got != cur {
			t.Fatalf("respuesta = %+v, quería %+v", got, cur)
		}
	case <-time.After(time.Second):
		t.Fatal("no respondió a Interrogate")
	}
	d.req <- svc.ChangeRequest{Cmd: svc.Stop}
	d.waitDone(t)
}

func TestFalloAntesDeEstarListoNuncaReportaRunning(t *testing.T) {
	ev := &fakeEvents{}
	h := &handler{events: ev, stopTimeout: time.Second, run: func(ctx context.Context, ready func()) error {
		return errors.New("config: api.url es obligatoria")
	}}
	d := drive(h)
	d.waitDone(t)
	if !d.ssec || d.errno != 1 {
		t.Fatalf("debe terminar con error de servicio 1, devolvió (%v, %d)", d.ssec, d.errno)
	}
	close(d.status)
	for s := range d.status {
		if s.State == svc.Running {
			t.Fatal("no debe reportar Running si falló al arrancar")
		}
	}
	if e := ev.errors(); len(e) != 1 || e[0] == "" {
		t.Fatalf("el motivo debe quedar en el registro de eventos: %v", e)
	}
}

func TestCaidaInesperadaTerminaConErrorParaQueElSCMReinicie(t *testing.T) {
	ev := &fakeEvents{}
	boom := make(chan struct{})
	h := &handler{events: ev, stopTimeout: time.Second, run: func(ctx context.Context, ready func()) error {
		ready()
		<-boom
		return errors.New("se cayó la base")
	}}
	d := drive(h)
	d.waitState(t, svc.Running)
	close(boom)
	d.waitDone(t)
	if !d.ssec || d.errno != 1 {
		t.Fatalf("(%v, %d), quería (true, 1)", d.ssec, d.errno)
	}
	if len(ev.errors()) != 1 {
		t.Fatalf("errores = %v", ev.errors())
	}
}

func TestSalidaLimpiaSinPeticionTambienEsFallo(t *testing.T) {
	h := &handler{events: &fakeEvents{}, stopTimeout: time.Second, run: func(ctx context.Context, ready func()) error {
		ready()
		return nil // terminó sola: el servicio no debe quedar "detenido bien"
	}}
	d := drive(h)
	d.waitDone(t)
	if !d.ssec || d.errno != 1 {
		t.Fatalf("(%v, %d), quería (true, 1)", d.ssec, d.errno)
	}
}

func TestParadaQueNoTerminaVencePorTiempo(t *testing.T) {
	ev := &fakeEvents{}
	release := make(chan struct{})
	defer close(release)
	h := &handler{events: ev, stopTimeout: 100 * time.Millisecond, run: func(ctx context.Context, ready func()) error {
		ready()
		<-release // ignora la cancelación
		return nil
	}}
	d := drive(h)
	d.waitState(t, svc.Running)
	d.req <- svc.ChangeRequest{Cmd: svc.Stop}
	d.waitDone(t)
	if !d.ssec || d.errno != 2 {
		t.Fatalf("(%v, %d), quería (true, 2)", d.ssec, d.errno)
	}
	if len(ev.errors()) != 1 {
		t.Fatalf("errores = %v", ev.errors())
	}
}
