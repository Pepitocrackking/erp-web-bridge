// Package version expone la versión del agente. Se puede sobrescribir en
// compilación con -ldflags "-X .../internal/version.Version=1.2.3".
package version

// Version es la versión del agente.
var Version = "0.0.0-dev"

// String devuelve el nombre y la versión del agente.
func String() string {
	return "erp-agent " + Version
}
