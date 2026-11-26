// Comando erp-agent: agente local outbound-only que lee el ERP y empuja
// los cambios por HTTPS a la API. En esta fase solo imprime su versión.
package main

import (
	"fmt"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/version"
)

func main() {
	fmt.Println(version.String())
}
