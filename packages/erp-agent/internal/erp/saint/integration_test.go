package saint

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/microsoft/go-mssqldb"
)

// Prueba contra el sandbox real de Saint. Se omite si no hay SAINT_TEST_DSN.
//
//	SAINT_TEST_DSN='sqlserver://sa:<MSSQL_SA_PASSWORD>@localhost:14330?database=SAINT_DEMO&encrypt=disable'
func TestSandboxReal(t *testing.T) {
	dsn := os.Getenv("SAINT_TEST_DSN")
	if dsn == "" {
		t.Skip("SAINT_TEST_DSN no definido: se omite la prueba contra el sandbox")
	}
	db, err := sql.Open("sqlserver", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	a := New(db, loadReal(t), nil)

	var nProd, nCli int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM SAPROD").Scan(&nProd); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM SACLIE").Scan(&nCli); err != nil {
		t.Fatal(err)
	}

	ps, err := a.Products(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != nProd || len(ps) < 300 {
		t.Fatalf("productos leídos = %d, SAPROD tiene %d (se esperan >= 300)", len(ps), nProd)
	}
	cs, err := a.Customers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cs) != nCli || len(cs) == 0 {
		t.Fatalf("clientes leídos = %d, SACLIE tiene %d", len(cs), nCli)
	}

	// Cotejo de un producto contra la base.
	first := ps[0]
	var desc string
	var precio, existen float64
	if err := db.QueryRowContext(ctx, "SELECT Descrip, CAST(Precio1 AS FLOAT), CAST(Existen AS FLOAT) FROM SAPROD WHERE CodProd = @p1", first.SKU).
		Scan(&desc, &precio, &existen); err != nil {
		t.Fatal(err)
	}
	if first.Name != desc || first.PriceUSD != precio {
		t.Fatalf("producto %s: agente %+v, base (%q, %v, %v)", first.SKU, first, desc, precio, existen)
	}
	if first.Category == nil || *first.Category == "" {
		t.Fatalf("la categoría debería venir de SAINSTA: %+v", first)
	}
	t.Logf("sandbox: %d productos, %d clientes; primero %+v", len(ps), len(cs), first)
}
