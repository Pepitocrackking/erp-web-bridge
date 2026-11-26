package saint

import (
	"strings"
	"testing"
)

func TestMapeoRealDefineElBorradorDePedidos(t *testing.T) {
	d := loadReal(t).OrderDraft
	if d == nil {
		t.Fatal("el mapeo del sandbox debe definir order_draft")
	}
	if d.Header.Table != "SAPEDIDO" || d.Items.Table != "SAITEMPED" {
		t.Fatalf("tablas = %q / %q", d.Header.Table, d.Items.Table)
	}
	if got := d.WriteTables(); len(got) != 2 || got[0] != "SAPEDIDO" || got[1] != "SAITEMPED" {
		t.Fatalf("WriteTables = %v", got)
	}
	if v := d.Header.Fields["status"].Value; v == nil || *v != "B" {
		t.Fatalf("status.value = %v, quiero B (borrador)", v)
	}
}

func TestInsertDeCabeceraSaleDelMapeo(t *testing.T) {
	m := loadReal(t)
	want := "INSERT INTO [SAPEDIDO] ([NumeroD], [NumeroWeb], [CodClie], [Monto], [Tasa], [Estado]) OUTPUT INSERTED.[NumeroD] " +
		"VALUES ('PW' + RIGHT(REPLICATE('0', 7) + CAST(NEXT VALUE FOR [SQ_SAPEDIDO_WEB] AS VARCHAR(20)), 7), @p1, @p2, @p3, @p4, @p5)"
	if got := m.insertHeaderSQL(false); got != want {
		t.Fatalf("SQL =\n%s\nquiero\n%s", got, want)
	}
	if got := m.insertHeaderSQL(true); !strings.Contains(got, "[Notas]") || !strings.HasSuffix(got, "@p5, @p6)") {
		t.Fatalf("con notas debe añadir [Notas] y @p6: %s", got)
	}
	wantItem := "INSERT INTO [SAITEMPED] ([NumeroD], [NroLinea], [CodProd], [Cantidad], [Precio], [TotalItem]) VALUES (@p1, @p2, @p3, @p4, @p5, @p6)"
	if got := m.insertItemSQL(); got != wantItem {
		t.Fatalf("SQL =\n%s\nquiero\n%s", got, wantItem)
	}
}

func TestMapeoSinOrderDraftSigueCargando(t *testing.T) {
	// Un mapeo anterior a la Fase 7 (sin order_draft) debe seguir funcionando: el agente solo lee.
	m := loadReal(t)
	m.OrderDraft = nil
	a := New(nil, m, nil)
	if _, err := a.CreateOrderDraft(t.Context(), orderFor("C00001")); err == nil || !strings.Contains(err.Error(), "order_draft") {
		t.Fatalf("sin order_draft debe fallar con un mensaje claro, err=%v", err)
	}
}

func TestMapeoRechazaOrderDraftMalformado(t *testing.T) {
	base, err := readFile(mappingPath)
	if err != nil {
		t.Fatal(err)
	}
	casos := []struct{ nombre, de, a, esperado string }{
		{"misma tabla", "table: SAITEMPED", "table: SAPEDIDO", "misma tabla"},
		{"identificador peligroso", "table: SAPEDIDO", "table: \"SAPEDIDO; DROP TABLE SAPROD\"", "inválida"},
		{"secuencia peligrosa", "name: SQ_SAPEDIDO_WEB", "name: \"X]; DROP\"", "number_sequence.name"},
		{"ancho absurdo", "width: 7", "width: 99", "width"},
		{"falta web_id", "      web_id:        { column: NumeroWeb }\n", "", "web_id"},
		{"estado sin valor", "{ column: Estado, value: B }", "{ column: Estado }", "status"},
		{"columna peligrosa", "{ column: Cantidad }", "{ column: \"Cantidad]--\" }", "quantity"},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			if !strings.Contains(base, c.de) {
				t.Fatalf("el caso no aplica: no encuentro %q en el mapeo", c.de)
			}
			_, err := ParseMapping([]byte(strings.Replace(base, c.de, c.a, 1)))
			if err == nil || !strings.Contains(err.Error(), c.esperado) {
				t.Fatalf("err = %v, esperaba que mencionara %q", err, c.esperado)
			}
		})
	}
}
