package saint

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

// Garantía de "cero riesgo contable" contra el sandbox real. Necesita DOS conexiones:
//
//	SAINT_TEST_DSN        sa: prepara datos, limpia y toma las huellas (nunca la usa el agente)
//	SAINT_AGENT_TEST_DSN  erp_agent: el login restringido con el que debe correr el agente
//	  sqlserver://erp_agent:Agent_Demo_2026%21@localhost:14330?database=SAINT_DEMO&encrypt=disable
//
// Sin la segunda, estas pruebas se omiten.

// tablasQueNoSeTocan: todo lo fiscal y los datos maestros. Su huella no puede cambiar nunca por
// culpa de un pedido web.
var tablasQueNoSeTocan = []string{"SAFACT", "SAITEMFAC", "SAACXC", "SACLIE", "SAPROD", "SAEXIS", "SADEPO", "SAINSTA"}

func agentSandbox(t *testing.T) (admin, agent *sql.DB, a *Adapter) {
	t.Helper()
	admin, _ = sandbox(t)
	dsn := os.Getenv("SAINT_AGENT_TEST_DSN")
	if dsn == "" {
		t.Skip("SAINT_AGENT_TEST_DSN no definido: se omite la prueba con el login restringido")
	}
	agent, err := sql.Open("sqlserver", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { agent.Close() })
	return admin, agent, New(agent, loadReal(t), nil)
}

// huellas devuelve filas y checksum de cada tabla protegida, leídos como administrador.
func huellas(t *testing.T, admin *sql.DB) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, tb := range tablasQueNoSeTocan {
		out[tb] = scalar(t, admin, "SELECT CAST(COUNT(*) AS VARCHAR(20)) + '/' + CAST(CHECKSUM_AGG(BINARY_CHECKSUM(*)) AS VARCHAR(30)) FROM dbo."+tb)
	}
	return out
}

// exigeIguales falla si alguna tabla protegida cambió: es el corazón de la garantía.
func exigeIguales(t *testing.T, antes, despues map[string]string) {
	t.Helper()
	for _, tb := range tablasQueNoSeTocan {
		if antes[tb] != despues[tb] {
			t.Errorf("¡LA TABLA %s CAMBIÓ! antes %s, después %s: el agente escribió donde no debe", tb, antes[tb], despues[tb])
		}
	}
}

func TestLaHuellaDetectaUnaEscrituraFiscalDeContrabando(t *testing.T) {
	// Prueba de la prueba: si alguien escribiera una fila en una tabla fiscal, la comparación DEBE verlo.
	admin, _ := sandbox(t)
	antes := huellas(t, admin)
	if _, err := admin.Exec("INSERT INTO SAFACT (NumeroD, CodClie, FechaE, Monto, Impuesto) SELECT 'ZZ-CONTRABANDO', MIN(CodClie), '2026-01-01', 1, 0 FROM SACLIE"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec("DELETE FROM SAFACT WHERE NumeroD = 'ZZ-CONTRABANDO'") })
	despues := huellas(t, admin)
	if antes["SAFACT"] == despues["SAFACT"] {
		t.Fatal("la huella de SAFACT no cambió tras insertar una factura: la prueba de no escritura fiscal no serviría")
	}
}

func TestProcesarPedidosNoCambiaNingunaTablaFiscalNiMaestra(t *testing.T) {
	admin, agent, a := agentSandbox(t)
	cust, skus := pick(t, admin, 3)
	ctx := context.Background()
	antes := huellas(t, admin)
	borradoresAntes := scalar(t, admin, "SELECT COUNT(*) FROM SAPEDIDO")

	var buenos []erp.OrderDraft
	for i := 0; i < 5; i++ { // varios pedidos válidos...
		o := orderFor(cust, skus...)
		o.WebOrderID += "-" + string(rune('a'+i))
		limpiar(t, admin, o.WebOrderID)
		buenos = append(buenos, o)
	}
	for _, o := range buenos {
		if _, err := a.CreateOrderDraft(ctx, o); err != nil {
			t.Fatal(err)
		}
		if _, err := a.CreateOrderDraft(ctx, o); err != nil { // ...y su reintento
			t.Fatal(err)
		}
	}
	// ...y pedidos que el ERP rechaza.
	for _, o := range []erp.OrderDraft{orderFor("NO-EXISTE", skus...), orderFor(cust, skus[0], "NOEXISTE-1")} {
		if _, err := a.CreateOrderDraft(ctx, o); !erp.IsRejected(err) {
			t.Fatalf("debía rechazarse: %v", err)
		}
	}

	if n := scalar(t, admin, "SELECT COUNT(*) FROM SAPEDIDO"); n == borradoresAntes {
		t.Fatalf("los borradores no se escribieron (siguen en %s): la prueba no probaría nada", n)
	}
	exigeIguales(t, antes, huellas(t, admin))
	_ = agent
}

func TestElLoginDelAgenteNoPuedeEscribirNiLeerLoFiscalAunqueQuisiera(t *testing.T) {
	admin, agent, _ := agentSandbox(t)
	antes := huellas(t, admin)
	ctx := context.Background()

	// Cada sentencia es una escritura (o lectura) vedada. SQL Server debe rechazarlas TODAS, con
	// independencia de lo que haga el código del agente.
	vedadas := []string{
		"INSERT INTO SAFACT (NumeroD, CodClie, FechaE, Monto) SELECT 'ZZ-1', MIN(CodClie), '2026-01-01', 1 FROM SACLIE",
		"UPDATE SAFACT SET Monto = 0",
		"DELETE FROM SAFACT",
		"INSERT INTO SAITEMFAC (NumeroD, NroLinea, CodProd, Cantidad, Precio, TotalItem) VALUES ('F0000001', 99, 'P00001', 1, 1, 1)",
		"UPDATE SAITEMFAC SET Cantidad = 0",
		"DELETE FROM SAITEMFAC",
		"INSERT INTO SAACXC (NroUnico, CodClie, NumeroD, FechaV, Saldo) VALUES (99, 'C00001', 'F0000001', '2026-01-01', 1)",
		"UPDATE SAACXC SET Saldo = 0",
		"DELETE FROM SAACXC",
		"SELECT * FROM SAFACT",
		"SELECT * FROM SAACXC",
		"UPDATE SACLIE SET Saldo = 0",
		"UPDATE SACLIE SET LimiteCred = 999999",
		"UPDATE SAPROD SET Precio1 = 0",
		"UPDATE SAEXIS SET Existen = 0",
		"DELETE FROM SAPROD",
		"INSERT INTO SAINSTA (CodInst, Descrip) VALUES ('ZZ', 'x')",
		"UPDATE SAPEDIDO SET Monto = 0",
		"DELETE FROM SAPEDIDO",
		"DELETE FROM SAITEMPED",
		"TRUNCATE TABLE SAFACT",
		"DROP TABLE SAFACT",
		"ALTER TABLE SAFACT ADD x INT",
		"CREATE TABLE ZZ_NUEVA (x INT)",
	}
	for _, s := range vedadas {
		_, err := agent.ExecContext(ctx, s)
		if err == nil {
			t.Errorf("SQL Server ACEPTÓ una sentencia vedada para erp_agent: %s", s)
			continue
		}
		if m := strings.ToLower(err.Error()); !strings.Contains(m, "permission") && !strings.Contains(m, "denied") && !strings.Contains(m, "denegado") {
			t.Errorf("%s: falló, pero no por permisos: %v", s, err)
		}
	}
	exigeIguales(t, antes, huellas(t, admin))
}

func TestElLoginRestringidoPuedeLoQueDebe(t *testing.T) {
	// Lo contrario: el login no puede ser tan restrictivo que rompa el trabajo del agente.
	_, agent, a := agentSandbox(t)
	ctx := context.Background()
	for _, s := range []string{"SELECT COUNT(*) FROM SAPROD", "SELECT COUNT(*) FROM SAEXIS", "SELECT COUNT(*) FROM SACLIE", "SELECT COUNT(*) FROM SAPEDIDO", "SELECT COUNT(*) FROM SAITEMPED"} {
		if _, err := agent.ExecContext(ctx, s); err != nil {
			t.Errorf("el agente debe poder leer: %s: %v", s, err)
		}
	}
	if _, err := a.Products(ctx); err != nil {
		t.Errorf("Products con el login restringido: %v", err)
	}
	if _, err := a.Customers(ctx); err != nil {
		t.Errorf("Customers con el login restringido: %v", err)
	}
}

func TestVerifyWriteIsolationAceptaElLoginRestringidoYRechazaA_sa(t *testing.T) {
	admin, _, restringido := agentSandbox(t)
	ctx := context.Background()
	if err := restringido.VerifyWriteIsolation(ctx); err != nil {
		t.Fatalf("el login erp_agent debe pasar la verificación: %v", err)
	}

	privilegiado := New(admin, loadReal(t), nil) // sa: sysadmin, puede escribir en todo
	err := privilegiado.VerifyWriteIsolation(ctx)
	var unsafe *erp.UnsafeLoginError
	if !errors.As(err, &unsafe) {
		t.Fatalf("sa debe ser rechazado con UnsafeLoginError, err = %v", err)
	}
	msg := err.Error()
	for _, want := range []string{"sysadmin", "SAFACT", "SAACXC", "SACLIE", "orders.enabled"} {
		if !strings.Contains(msg, want) {
			t.Errorf("el mensaje debe mencionar %q: %s", want, msg)
		}
	}
	if !erp.IsUnsafeLogin(err) {
		t.Error("IsUnsafeLogin debe reconocerlo")
	}
}

func TestVerifyWriteIsolationSinOrderDraftNoEscribeNadaAsiQueNoExigeNada(t *testing.T) {
	admin, _ := sandbox(t)
	m := loadReal(t)
	m.OrderDraft = nil
	if err := New(admin, m, nil).VerifyWriteIsolation(context.Background()); err != nil {
		t.Fatalf("sin order_draft el agente es de solo lectura: %v", err)
	}
}
