package saint

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent/internal/erp"
)

func readFile(p string) (string, error) {
	b, err := os.ReadFile(p)
	return string(b), err
}

func orderFor(customer string, skus ...string) erp.OrderDraft {
	o := erp.OrderDraft{
		WebOrderID:   fmt.Sprintf("test-%d", time.Now().UnixNano()),
		CustomerCode: customer,
		ExchangeRate: 40.1234,
		Notes:        "pedido de prueba",
	}
	for i, s := range skus {
		l := erp.OrderLine{SKU: s, Quantity: i + 2, UnitPriceUSD: 3.5}
		o.Lines = append(o.Lines, l)
		o.TotalUSD += float64(l.Quantity) * l.UnitPriceUSD
	}
	return o
}

// sandbox abre el sandbox real (SAINT_TEST_DSN) o salta la prueba.
func sandbox(t *testing.T) (*sql.DB, *Adapter) {
	t.Helper()
	dsn := os.Getenv("SAINT_TEST_DSN")
	if dsn == "" {
		t.Skip("SAINT_TEST_DSN no definido: se omite la prueba contra el sandbox")
	}
	db, err := sql.Open("sqlserver", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, New(db, loadReal(t), nil)
}

func scalar(t *testing.T, db *sql.DB, query string, args ...any) string {
	t.Helper()
	var v sql.NullString
	if err := db.QueryRowContext(context.Background(), query, args...).Scan(&v); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return v.String
}

// pick devuelve n SKU activos y un cliente activo del sandbox.
func pick(t *testing.T, db *sql.DB, n int) (string, []string) {
	t.Helper()
	cust := scalar(t, db, "SELECT TOP 1 CodClie FROM SACLIE WHERE Activo = 1 ORDER BY CodClie")
	rows, err := db.Query("SELECT TOP (@p1) CodProd FROM SAPROD WHERE Activo = 1 ORDER BY CodProd", n)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var skus []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		skus = append(skus, s)
	}
	if cust == "" || len(skus) < n {
		t.Fatalf("el sandbox no tiene datos suficientes (cliente %q, %d productos)", cust, len(skus))
	}
	return cust, skus
}

// limpiar borra el borrador de prueba al terminar (lo único que estas pruebas escriben).
func limpiar(t *testing.T, db *sql.DB, webID string) {
	t.Cleanup(func() {
		db.Exec("DELETE FROM SAITEMPED WHERE NumeroD IN (SELECT NumeroD FROM SAPEDIDO WHERE NumeroWeb = @p1)", webID)
		db.Exec("DELETE FROM SAPEDIDO WHERE NumeroWeb = @p1", webID)
	})
}

func TestBorradorSeEscribeUnaSolaVezContraElSandbox(t *testing.T) {
	db, a := sandbox(t)
	cust, skus := pick(t, db, 3)
	o := orderFor(cust, skus...)
	limpiar(t, db, o.WebOrderID)
	ctx := context.Background()

	r1, err := a.CreateOrderDraft(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	if !r1.Created || !strings.HasPrefix(r1.Reference, "PW") || len(r1.Reference) != 9 {
		t.Fatalf("primer intento = %+v, quiero Created y referencia PW + 7 dígitos", r1)
	}

	// Cabecera: borrador ('B'), con el id web, el cliente, el monto y la tasa del pedido.
	var estado, web, cli, monto, tasa, notas string
	err = db.QueryRow("SELECT Estado, NumeroWeb, CodClie, CAST(Monto AS VARCHAR(30)), CAST(Tasa AS VARCHAR(30)), Notas FROM SAPEDIDO WHERE NumeroD = @p1", r1.Reference).
		Scan(&estado, &web, &cli, &monto, &tasa, &notas)
	if err != nil {
		t.Fatal(err)
	}
	if estado != "B" || web != o.WebOrderID || cli != cust || monto != "31.50" || tasa != "40.1234" || notas != "pedido de prueba" {
		t.Fatalf("cabecera = estado %q web %q cliente %q monto %q tasa %q notas %q", estado, web, cli, monto, tasa, notas)
	}
	// Renglones: cantidades 2, 3 y 4 a 3.5 = 7 + 10.5 + 14 = 31.5.
	if n := scalar(t, db, "SELECT COUNT(*) FROM SAITEMPED WHERE NumeroD = @p1", r1.Reference); n != "3" {
		t.Fatalf("renglones = %s, quiero 3", n)
	}
	if s := scalar(t, db, "SELECT CAST(SUM(TotalItem) AS VARCHAR(30)) FROM SAITEMPED WHERE NumeroD = @p1", r1.Reference); s != "31.50" {
		t.Fatalf("suma de renglones = %s, quiero 31.50", s)
	}

	// Reintento: misma referencia, nada nuevo.
	r2, err := a.CreateOrderDraft(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	if r2.Created || r2.Reference != r1.Reference {
		t.Fatalf("reintento = %+v, quiero la misma referencia %s sin crear", r2, r1.Reference)
	}
	if n := scalar(t, db, "SELECT COUNT(*) FROM SAPEDIDO WHERE NumeroWeb = @p1", o.WebOrderID); n != "1" {
		t.Fatalf("borradores del pedido = %s, quiero 1", n)
	}
	if n := scalar(t, db, "SELECT COUNT(*) FROM SAITEMPED WHERE NumeroD = @p1", r1.Reference); n != "3" {
		t.Fatalf("renglones tras el reintento = %s, quiero 3", n)
	}
}

func TestPedidoRechazadoNoDejaNadaEscrito(t *testing.T) {
	db, a := sandbox(t)
	cust, skus := pick(t, db, 2)
	ctx := context.Background()

	casos := []struct {
		nombre string
		o      erp.OrderDraft
		dice   string
	}{
		{"cliente inexistente", orderFor("NO-EXISTE", skus...), "no existe"},
		{"SKU inexistente", orderFor(cust, skus[0], "NOEXISTE-1"), "NOEXISTE-1"},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			limpiar(t, db, c.o.WebOrderID)
			before := scalar(t, db, "SELECT COUNT(*) FROM SAPEDIDO")
			_, err := a.CreateOrderDraft(ctx, c.o)
			var rej *erp.RejectedError
			if !errors.As(err, &rej) || !strings.Contains(rej.Reason, c.dice) {
				t.Fatalf("err = %v, quiero RejectedError que mencione %q", err, c.dice)
			}
			if after := scalar(t, db, "SELECT COUNT(*) FROM SAPEDIDO"); after != before {
				t.Fatalf("SAPEDIDO cambió: %s -> %s", before, after)
			}
			if n := scalar(t, db, "SELECT COUNT(*) FROM SAPEDIDO WHERE NumeroWeb = @p1", c.o.WebOrderID); n != "0" {
				t.Fatalf("quedó un borrador del pedido rechazado")
			}
		})
	}
}

func TestClienteOProductoInactivoSeRechaza(t *testing.T) {
	db, a := sandbox(t)
	ctx := context.Background()
	cust, skus := pick(t, db, 1)
	inactivoC := scalar(t, db, "SELECT TOP 1 CodClie FROM SACLIE WHERE Activo = 0 ORDER BY CodClie")
	inactivoP := scalar(t, db, "SELECT TOP 1 CodProd FROM SAPROD WHERE Activo = 0 ORDER BY CodProd")
	if inactivoC != "" {
		o := orderFor(inactivoC, skus...)
		limpiar(t, db, o.WebOrderID)
		if _, err := a.CreateOrderDraft(ctx, o); !erp.IsRejected(err) || !strings.Contains(err.Error(), "inactivo") {
			t.Fatalf("cliente inactivo: err = %v", err)
		}
	}
	if inactivoP != "" {
		o := orderFor(cust, skus[0], inactivoP)
		limpiar(t, db, o.WebOrderID)
		if _, err := a.CreateOrderDraft(ctx, o); !erp.IsRejected(err) || !strings.Contains(err.Error(), "inactivos") {
			t.Fatalf("producto inactivo: err = %v", err)
		}
	}
	if inactivoC == "" && inactivoP == "" {
		t.Skip("el sandbox no tiene clientes ni productos inactivos")
	}
}
