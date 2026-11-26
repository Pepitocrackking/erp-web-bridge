package saint

import (
	"strings"
	"testing"
)

var draftTables = []string{"SAPEDIDO", "SAITEMPED"}

func TestLaListaBlancaSoloAdmiteSelectEInsertEnElBorrador(t *testing.T) {
	buenas := []string{
		"SELECT [NumeroD] FROM [SAPEDIDO] WHERE [NumeroWeb] = @p1",
		"  select p.[CodProd] from [SAPROD] p where p.[CodProd] in (@p1,@p2)  ",
		"INSERT INTO [SAPEDIDO] ([NumeroD]) OUTPUT INSERTED.[NumeroD] VALUES ('PW' + RIGHT(REPLICATE('0', 7) + CAST(NEXT VALUE FOR [SQ_SAPEDIDO_WEB] AS VARCHAR(20)), 7))",
		"insert into [saitemped] ([NumeroD]) values (@p1)", // sin distinguir mayúsculas
	}
	for _, s := range buenas {
		if err := checkStatement(draftTables, s); err != nil {
			t.Errorf("debería pasar: %q: %v", s, err)
		}
	}

	malas := []struct{ sql, motivo string }{
		{"INSERT INTO [SAFACT] ([NumeroD]) VALUES ('X')", "no es una tabla de borrador"},
		{"INSERT INTO [SAITEMFAC] ([NumeroD]) VALUES ('X')", "no es una tabla de borrador"},
		{"INSERT INTO [SAACXC] ([NroUnico]) VALUES (1)", "no es una tabla de borrador"},
		{"INSERT INTO [SACLIE] ([CodClie]) VALUES ('X')", "no es una tabla de borrador"},
		{"INSERT INTO [SAPEDIDO_COPIA] ([NumeroD]) VALUES ('X')", "no es una tabla de borrador"},
		{"INSERT INTO SAFACT (NumeroD) VALUES ('X')", "INSERT INTO [tabla]"},           // sin corchetes: no se interpreta
		{"INSERT INTO [dbo].[SAFACT] ([NumeroD]) VALUES ('X')", "INSERT INTO [tabla]"}, // con esquema: no se interpreta
		{"UPDATE [SAFACT] SET [Monto] = 0", "UPDATE rechazada"},
		{"UPDATE [SAPEDIDO] SET [Monto] = 0", "UPDATE rechazada"}, // ni siquiera los borradores se editan
		{"DELETE FROM [SAFACT]", "DELETE rechazada"},
		{"DELETE FROM [SAPEDIDO]", "DELETE rechazada"},
		{"TRUNCATE TABLE [SAACXC]", "TRUNCATE rechazada"},
		{"MERGE [SAFACT] AS t USING (SELECT 1) AS s ON 1=0 WHEN NOT MATCHED THEN INSERT (NumeroD) VALUES ('X');", "una sola sentencia"},
		{"EXEC xp_cmdshell 'dir'", "EXEC rechazada"},
		{"DROP TABLE [SAFACT]", "DROP rechazada"},
		{"ALTER TABLE [SAFACT] ADD x INT", "ALTER rechazada"},
		{"SELECT * INTO [SAFACT_COPIA] FROM [SAFACT]", "SELECT ... INTO"},
		{"SELECT 1; DELETE FROM [SAFACT]", "una sola sentencia"},
		{"SELECT 1 -- ; DELETE FROM SAFACT", "sin comentarios"},
		{"SELECT 1 /* x */", "sin comentarios"},
		{"INSERT INTO [SAPEDIDO] ([NumeroD]) VALUES ('X'); DELETE FROM [SAFACT]", "una sola sentencia"},
		{"", "vacía"},
		{"   ", "vacía"},
	}
	for _, c := range malas {
		err := checkStatement(draftTables, c.sql)
		if err == nil {
			t.Errorf("DEBE rechazarse: %q", c.sql)
			continue
		}
		if !strings.Contains(err.Error(), c.motivo) {
			t.Errorf("%q: error %q, esperaba que mencionara %q", c.sql, err, c.motivo)
		}
	}
}

func TestTodasLasSentenciasDelEscritorPasanLaListaBlanca(t *testing.T) {
	// Si alguien cambia el SQL del escritor y lo desvía a otra tabla o a un UPDATE, esto falla.
	m := loadReal(t)
	allowed := m.OrderDraft.WriteTables()
	stmts := map[string]string{
		"cabecera":       m.insertHeaderSQL(false),
		"cabecera+notas": m.insertHeaderSQL(true),
		"renglón":        m.insertItemSQL(),
		"clientes":       m.customerQuery(),
		"productos":      m.productQuery(),
	}
	for name, s := range stmts {
		if err := checkStatement(allowed, s); err != nil {
			t.Errorf("%s: %v\n%s", name, err, s)
		}
	}
}

func TestElMapeoNoPuedeApuntarElBorradorAUnaTablaFiscalNiMaestra(t *testing.T) {
	base, err := readFile(mappingPath)
	if err != nil {
		t.Fatal(err)
	}
	casos := []struct{ nombre, de, a string }{
		{"cabecera en SAFACT", "table: SAPEDIDO", "table: SAFACT"},
		{"renglones en SAITEMFAC", "table: SAITEMPED", "table: SAITEMFAC"},
		{"renglones en SAACXC", "table: SAITEMPED", "table: SAACXC"},
		{"sin distinguir mayúsculas", "table: SAPEDIDO", "table: safact"},
		{"cabecera en clientes", "table: SAPEDIDO", "table: SACLIE"},
		{"renglones en productos", "table: SAITEMPED", "table: SAPROD"},
		{"renglones en existencias", "table: SAITEMPED", "table: SAEXIS"},
		{"cabecera en categorías", "table: SAPEDIDO", "table: SAINSTA"},
		{"tabla protegida declarada en el mapeo", "protected_tables: [SAFACT, SAITEMFAC, SAACXC]", "protected_tables: [SAFACT, SAITEMFAC, SAACXC, SAPEDIDO]"},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			if !strings.Contains(base, c.de) {
				t.Fatalf("el caso no aplica: no encuentro %q en el mapeo", c.de)
			}
			_, err := ParseMapping([]byte(strings.Replace(base, c.de, c.a, 1)))
			if err == nil || !strings.Contains(err.Error(), "no puede escribir") {
				t.Fatalf("err = %v, esperaba el rechazo «no puede escribir»", err)
			}
		})
	}
}

func TestElConjuntoProtegidoIncluyeLoFiscalYLosDatosMaestros(t *testing.T) {
	got := strings.Join(loadReal(t).ProtectedSet(), ",")
	for _, want := range []string{"SAFACT", "SAITEMFAC", "SAACXC", "SAPROD", "SACLIE", "SAINSTA", "SAEXIS", "SADEPO"} {
		if !strings.Contains(got, want) {
			t.Errorf("ProtectedSet = %s: falta %s", got, want)
		}
	}
	for _, no := range []string{"SAPEDIDO", "SAITEMPED"} {
		if strings.Contains(got, no) {
			t.Errorf("ProtectedSet = %s: %s es del borrador y se puede escribir", got, no)
		}
	}
}
