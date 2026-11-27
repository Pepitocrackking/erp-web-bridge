//go:build windows

package winsvc

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	waitTimeout = 30 * time.Second
	pollEvery   = 250 * time.Millisecond
)

// Recuperación ante fallo: reintenta pronto y se va espaciando; el contador de
// fallos se reinicia tras un día sin caídas.
var recovery = []mgr.RecoveryAction{
	{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
	{Type: mgr.ServiceRestart, Delay: 15 * time.Second},
	{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
}

const recoveryResetSeconds = 24 * 60 * 60

// account resuelve la cuenta del servicio: su nombre para el SCM y su
// identificador para icacls (un SID, para no depender del idioma de Windows).
type account struct {
	startName string
	sid       string
	password  string
}

func resolveAccount(name, password string) (account, error) {
	switch strings.ToLower(strings.TrimPrefix(strings.ToLower(name), `nt authority\`)) {
	case "", "localservice", "local service":
		return account{startName: `NT AUTHORITY\LocalService`, sid: "*S-1-5-19"}, nil
	case "networkservice", "network service":
		return account{startName: `NT AUTHORITY\NetworkService`, sid: "*S-1-5-20"}, nil
	case "localsystem", "system":
		return account{}, errors.New("LocalSystem no se admite: el agente no necesita ese poder; usa LocalService o una cuenta dedicada")
	}
	if password == "" {
		return account{}, fmt.Errorf("la cuenta %q necesita contraseña", name)
	}
	return account{startName: name, sid: name, password: password}, nil
}

// wrap traduce "acceso denegado" a una instrucción útil.
func wrap(what string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return fmt.Errorf("%s: acceso denegado; abre PowerShell o CMD como administrador", what)
	}
	return fmt.Errorf("%s: %w", what, err)
}

// Install registra el servicio con arranque automático (retrasado), reinicio
// ante fallo y registro de eventos, y protege el archivo de configuración (que
// tiene secretos) para que solo lo lean SYSTEM, los administradores y la cuenta
// del servicio.
func Install(o InstallOptions) error {
	name := orDefault(o.Name, DefaultName)
	if o.ConfigPath == "" {
		return errors.New("falta la ruta del archivo de configuración")
	}
	cfgPath, err := filepath.Abs(o.ConfigPath)
	if err != nil {
		return err
	}
	if _, err := os.Stat(cfgPath); err != nil {
		return fmt.Errorf("configuración: %w", err)
	}
	exe := o.ExePath
	if exe == "" {
		if exe, err = os.Executable(); err != nil {
			return err
		}
	}
	if exe, err = filepath.Abs(exe); err != nil {
		return err
	}
	if _, err := os.Stat(exe); err != nil {
		return fmt.Errorf("ejecutable: %w", err)
	}
	acct, err := resolveAccount(o.Account, o.Password)
	if err != nil {
		return err
	}

	m, err := mgr.Connect()
	if err != nil {
		return wrap("conectar con el administrador de servicios", err)
	}
	defer m.Disconnect()
	if existing, err := m.OpenService(name); err == nil {
		existing.Close()
		return fmt.Errorf("el servicio %q ya está instalado (desinstálalo antes: erp-agent service uninstall)", name)
	}

	// Permisos de archivos antes de crear el servicio: si fallan, no queda nada a medias.
	for _, d := range o.DataDirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("crear %s: %w", d, err)
		}
		if err := icacls(d, "/grant", acct.sid+":(OI)(CI)M"); err != nil {
			return err
		}
	}
	if err := icacls(cfgPath, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F", acct.sid+":R"); err != nil {
		return err
	}

	display := orDefault(o.DisplayName, "ERP Web Bridge - Agente local")
	s, err := m.CreateService(name, exe, mgr.Config{
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
		DisplayName:      display,
		Description:      "Lee el ERP local y sincroniza el catálogo con la nube (solo conexiones salientes).",
		ServiceStartName: acct.startName,
		Password:         acct.password,
	}, "-config", cfgPath, "-service-name", name)
	if err != nil {
		return wrap("crear el servicio", err)
	}
	defer s.Close()

	ok := false
	defer func() {
		if !ok { // revertir: no dejar un servicio a medio configurar
			s.Delete()
			eventlog.Remove(name)
		}
	}()
	if err := s.SetRecoveryActions(recovery, recoveryResetSeconds); err != nil {
		return wrap("configurar la recuperación", err)
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return wrap("configurar la recuperación ante salidas con error", err)
	}
	if err := eventlog.InstallAsEventCreate(name, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil &&
		!strings.Contains(err.Error(), "exists") {
		return wrap("registrar el origen de eventos", err)
	}
	ok = true
	return nil
}

// Uninstall detiene el servicio si está en marcha y lo elimina. No toca la
// configuración, la base local ni los logs.
func Uninstall(name string) error {
	name = orDefault(name, DefaultName)
	m, err := mgr.Connect()
	if err != nil {
		return wrap("conectar con el administrador de servicios", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("el servicio %q no está instalado", name)
	}
	defer s.Close()
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		if _, err := s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return wrap("detener el servicio", err)
		}
		if err := waitFor(s, svc.Stopped); err != nil {
			return err
		}
	}
	if err := s.Delete(); err != nil {
		return wrap("eliminar el servicio", err)
	}
	eventlog.Remove(name) // si no estaba registrado, no importa
	return nil
}

// Start arranca el servicio y espera a que quede en marcha.
func Start(name string) error {
	name = orDefault(name, DefaultName)
	s, closeFn, err := open(name)
	if err != nil {
		return err
	}
	defer closeFn()
	if err := s.Start(); err != nil {
		return wrap("arrancar el servicio", err)
	}
	return waitFor(s, svc.Running)
}

// Stop detiene el servicio y espera a que quede detenido.
func Stop(name string) error {
	name = orDefault(name, DefaultName)
	s, closeFn, err := open(name)
	if err != nil {
		return err
	}
	defer closeFn()
	if _, err := s.Control(svc.Stop); err != nil {
		return wrap("detener el servicio", err)
	}
	return waitFor(s, svc.Stopped)
}

// Status describe el servicio instalado.
func Status(name string) (Info, error) {
	name = orDefault(name, DefaultName)
	s, closeFn, err := open(name)
	if err != nil {
		return Info{}, err
	}
	defer closeFn()
	st, err := s.Query()
	if err != nil {
		return Info{}, wrap("consultar el servicio", err)
	}
	cfg, err := s.Config()
	if err != nil {
		return Info{}, wrap("leer la configuración del servicio", err)
	}
	info := Info{
		Name:      name,
		State:     stateName(st.State),
		PID:       st.ProcessId,
		Account:   cfg.ServiceStartName,
		Automatic: cfg.StartType == mgr.StartAutomatic,
		Command:   cfg.BinaryPathName,
	}
	if acts, err := s.RecoveryActions(); err == nil {
		for _, a := range acts {
			info.Restarts = append(info.Restarts, fmt.Sprintf("%s@%s", actionName(a.Type), a.Delay))
		}
	}
	if r, err := s.ResetPeriod(); err == nil {
		info.ResetAfter = r
	}
	return info, nil
}

func open(name string) (*mgr.Service, func(), error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, nil, wrap("conectar con el administrador de servicios", err)
	}
	s, err := m.OpenService(name)
	if err != nil {
		m.Disconnect()
		return nil, nil, fmt.Errorf("el servicio %q no está instalado", name)
	}
	return s, func() { s.Close(); m.Disconnect() }, nil
}

// waitFor espera hasta que el servicio llegue al estado pedido. Si queríamos
// "en marcha" y se detuvo, falla enseguida en vez de esperar al tiempo límite.
func waitFor(s *mgr.Service, want svc.State) error {
	deadline := time.Now().Add(waitTimeout)
	for {
		st, err := s.Query()
		if err != nil {
			return wrap("consultar el servicio", err)
		}
		if st.State == want {
			return nil
		}
		if want == svc.Running && st.State == svc.Stopped {
			return errors.New("el servicio se detuvo al arrancar; revisa el archivo de log y el Visor de eventos (origen " + DefaultName + ")")
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("tiempo agotado esperando el estado %q (está en %q)", stateName(want), stateName(st.State))
		}
		time.Sleep(pollEvery)
	}
}

func stateName(s svc.State) string {
	switch s {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start_pending"
	case svc.StopPending:
		return "stop_pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue_pending"
	case svc.PausePending:
		return "pause_pending"
	case svc.Paused:
		return "paused"
	}
	return fmt.Sprintf("unknown(%d)", uint32(s))
}

func actionName(t int) string {
	switch t {
	case mgr.ServiceRestart:
		return "restart"
	case mgr.ComputerReboot:
		return "reboot"
	case mgr.RunCommand:
		return "run_command"
	}
	return "none"
}

func orDefault(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}

// icacls cambia permisos con la herramienta del sistema.
func icacls(path string, args ...string) error {
	out, err := exec.Command("icacls", append([]string{path}, args...)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls %s: %w: %s", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}
