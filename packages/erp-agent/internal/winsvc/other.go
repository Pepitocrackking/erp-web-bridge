//go:build !windows

package winsvc

// En sistemas que no son Windows no hay servicios de Windows.

func IsService() bool                  { return false }
func RunService(string, RunFunc) error { return ErrUnsupported }
func Install(InstallOptions) error     { return ErrUnsupported }
func Uninstall(string) error           { return ErrUnsupported }
func Start(string) error               { return ErrUnsupported }
func Stop(string) error                { return ErrUnsupported }
func Status(string) (Info, error)      { return Info{}, ErrUnsupported }
