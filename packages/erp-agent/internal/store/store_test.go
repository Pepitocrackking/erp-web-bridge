package store

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

func open(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestPutYLeer(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "agent.db"))
	defer s.Close()

	got, err := s.Fingerprints(ctx, KindProducts)
	if err != nil || len(got) != 0 {
		t.Fatalf("base vacía: %v %v", got, err)
	}
	if err := s.Put(ctx, KindProducts, map[string]string{"P1": "a", "P2": "b"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, KindProducts, map[string]string{"P2": "b2", "P3": "c"}); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Fingerprints(ctx, KindProducts)
	if want := map[string]string{"P1": "a", "P2": "b2", "P3": "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("huellas = %v, quiero %v", got, want)
	}
}

func TestTiposEstanSeparados(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "agent.db"))
	defer s.Close()
	s.Put(ctx, KindProducts, map[string]string{"X": "p"})
	s.Put(ctx, KindCustomers, map[string]string{"X": "c"})
	p, _ := s.Fingerprints(ctx, KindProducts)
	c, _ := s.Fingerprints(ctx, KindCustomers)
	if p["X"] != "p" || c["X"] != "c" {
		t.Fatalf("mezcla de tipos: %v %v", p, c)
	}
}

func TestReplaceYDelete(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "agent.db"))
	defer s.Close()
	s.Put(ctx, KindProducts, map[string]string{"P1": "a", "P2": "b", "P3": "c"})
	s.Put(ctx, KindCustomers, map[string]string{"C1": "z"})

	if err := s.Delete(ctx, KindProducts, []string{"P1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Replace(ctx, KindProducts, map[string]string{"P9": "n"}); err != nil {
		t.Fatal(err)
	}
	p, _ := s.Fingerprints(ctx, KindProducts)
	if want := map[string]string{"P9": "n"}; !reflect.DeepEqual(p, want) {
		t.Fatalf("tras Replace = %v", p)
	}
	if c, _ := s.Fingerprints(ctx, KindCustomers); len(c) != 1 {
		t.Fatal("Replace de productos no debe tocar clientes")
	}
}

// Lo guardado sobrevive a cerrar y reabrir la base (reinicio del agente / corte de luz).
func TestPersisteEntreAperturas(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	s := open(t, path)
	s.Put(ctx, KindProducts, map[string]string{"P1": "a"})
	s.Close()

	s = open(t, path)
	defer s.Close()
	got, _ := s.Fingerprints(ctx, KindProducts)
	if got["P1"] != "a" {
		t.Fatalf("no persistió: %v", got)
	}
	var v int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&v); err != nil || v != len(migrations) {
		t.Fatalf("user_version = %d (%v), quiero %d", v, err, len(migrations))
	}
}

func TestPutEsAtomico(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "agent.db"))
	defer s.Close()
	s.Put(ctx, KindProducts, map[string]string{"P1": "a"})
	// Contexto cancelado: la escritura falla y no deja nada a medias.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.Put(cctx, KindProducts, map[string]string{"P2": "b"}); err == nil {
		t.Fatal("esperaba error con ctx cancelado")
	}
	got, _ := s.Fingerprints(ctx, KindProducts)
	if len(got) != 1 {
		t.Fatalf("quedó una escritura a medias: %v", got)
	}
}

func TestRechazaBaseDeVersionMasNueva(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	s := open(t, path)
	if _, err := s.db.Exec("PRAGMA user_version = 99"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if _, err := Open(ctx, path); err == nil {
		t.Fatal("debería rechazar una base de versión más nueva")
	}
}
