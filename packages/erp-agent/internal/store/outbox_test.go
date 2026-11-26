package store

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

func entry(id, kind string, fps map[string]string) Entry {
	return Entry{BatchID: id, Kind: kind, Records: len(fps), Body: []byte(`{"batch_id":"` + id + `"}`), Commit: Commit{Fingerprints: fps}}
}

func TestColaEsFIFOYNoQuitaHastaCompletar(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "a.db"))
	defer s.Close()

	if e, err := s.Next(ctx); e != nil || err != nil {
		t.Fatalf("cola vacía: %v %v", e, err)
	}
	if err := s.Enqueue(ctx, []Entry{entry("b1", KindProducts, map[string]string{"P1": "a"}), entry("b2", KindProducts, map[string]string{"P2": "b"})}); err != nil {
		t.Fatal(err)
	}
	e, _ := s.Next(ctx)
	if e.BatchID != "b1" {
		t.Fatalf("primero = %s", e.BatchID)
	}
	if again, _ := s.Next(ctx); again.BatchID != "b1" {
		t.Fatal("Next no debe quitar el lote")
	}
	if n, _ := s.Depth(ctx); n != 2 {
		t.Fatalf("depth = %d", n)
	}
	if err := s.Complete(ctx, *e); err != nil {
		t.Fatal(err)
	}
	if e2, _ := s.Next(ctx); e2.BatchID != "b2" {
		t.Fatalf("tras completar b1 toca b2, got %s", e2.BatchID)
	}
	fps, _ := s.Fingerprints(ctx, KindProducts)
	if !reflect.DeepEqual(fps, map[string]string{"P1": "a"}) {
		t.Fatalf("Complete debe guardar las huellas de b1 y solo de b1: %v", fps)
	}
}

func TestEnqueueEsAtomicoYIgnoraRepetidos(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "a.db"))
	defer s.Close()
	s.Enqueue(ctx, []Entry{entry("b1", KindProducts, nil)})
	s.Enqueue(ctx, []Entry{entry("b1", KindProducts, nil)}) // mismo batch_id
	if n, _ := s.Depth(ctx); n != 1 {
		t.Fatalf("depth = %d, un batch_id repetido no debe duplicarse", n)
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.Enqueue(cctx, []Entry{entry("b2", KindProducts, nil), entry("b3", KindProducts, nil)}); err == nil {
		t.Fatal("esperaba error")
	}
	if n, _ := s.Depth(ctx); n != 1 {
		t.Fatalf("depth = %d: no debe quedar nada a medias", n)
	}
}

// La cola sobrevive a un corte de luz: se cierra y se reabre y todo sigue ahí, intacto.
func TestColaSobreviveAReabrir(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "a.db")
	s := open(t, path)
	e := entry("b1", KindProducts, map[string]string{"P1": "a"})
	e.ReconciliationID, e.Final = "r1", true
	e.Commit.Replace = true
	s.Enqueue(ctx, []Entry{e})
	s.Fail(ctx, "b1", "sin red")
	s.Close()

	s = open(t, path)
	defer s.Close()
	got, _ := s.Next(ctx)
	if got == nil || got.BatchID != "b1" || string(got.Body) != string(e.Body) || got.ReconciliationID != "r1" || !got.Final || !got.Commit.Replace ||
		got.Attempts != 1 || got.LastError != "sin red" || got.Commit.Fingerprints["P1"] != "a" {
		t.Fatalf("lote tras reabrir = %+v", got)
	}
}

func TestFailAcumulaIntentos(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "a.db"))
	defer s.Close()
	s.Enqueue(ctx, []Entry{entry("b1", KindProducts, nil)})
	s.Fail(ctx, "b1", "uno")
	s.Fail(ctx, "b1", "dos")
	e, _ := s.Next(ctx)
	if e.Attempts != 2 || e.LastError != "dos" {
		t.Fatalf("%+v", e)
	}
}

func TestDiscardDeReconciliacionQuitaTodosSusLotesYLaMarca(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "a.db"))
	defer s.Close()
	mk := func(id, rec string) Entry {
		e := entry(id, KindProducts, nil)
		e.ReconciliationID = rec
		return e
	}
	s.Enqueue(ctx, []Entry{mk("r1a", "R1"), mk("r1b", "R1"), mk("r1c", "R1"), entry("otro", KindProducts, nil)})
	s.SetMeta(ctx, MetaLastReconcile(KindProducts), "2026-01-01T00:00:00Z")

	first, _ := s.Next(ctx)
	n, err := s.Discard(ctx, *first)
	if err != nil || n != 3 {
		t.Fatalf("descartados = %d (%v), quiero 3", n, err)
	}
	if left, _ := s.Next(ctx); left == nil || left.BatchID != "otro" {
		t.Fatalf("debe quedar solo el lote ajeno: %+v", left)
	}
	if v, _ := s.Meta(ctx, MetaLastReconcile(KindProducts)); v != "" {
		t.Fatal("debe borrarse la marca para replanificar")
	}
	// Descartar un lote normal quita solo ese.
	one, _ := s.Next(ctx)
	if n, _ := s.Discard(ctx, *one); n != 1 {
		t.Fatalf("n = %d", n)
	}
}

func TestKnownSuperponeLoPendiente(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "a.db"))
	defer s.Close()
	s.Put(ctx, KindProducts, map[string]string{"P1": "viejo", "P2": "b"})
	s.Put(ctx, KindCustomers, map[string]string{"C1": "x"})

	s.Enqueue(ctx, []Entry{entry("b1", KindProducts, map[string]string{"P1": "nuevo", "P3": "c"})})
	got, _ := s.Known(ctx, KindProducts)
	if want := map[string]string{"P1": "nuevo", "P2": "b", "P3": "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("known = %v, quiero %v", got, want)
	}
	if c, _ := s.Known(ctx, KindCustomers); !reflect.DeepEqual(c, map[string]string{"C1": "x"}) {
		t.Fatalf("clientes = %v", c)
	}

	// Una reconciliación pendiente (Replace) sustituye al conjunto confirmado.
	rec := entry("b2", KindProducts, map[string]string{"P9": "z"})
	rec.Commit.Replace = true
	s.Enqueue(ctx, []Entry{rec})
	got, _ = s.Known(ctx, KindProducts)
	if !reflect.DeepEqual(got, map[string]string{"P9": "z"}) {
		t.Fatalf("tras Replace pendiente: %v", got)
	}
	// Lo confirmado en disco no se tocó.
	if base, _ := s.Fingerprints(ctx, KindProducts); len(base) != 2 {
		t.Fatalf("Known no debe modificar lo confirmado: %v", base)
	}
}

func TestCompleteConReplaceSustituyeTodo(t *testing.T) {
	ctx := context.Background()
	s := open(t, filepath.Join(t.TempDir(), "a.db"))
	defer s.Close()
	s.Put(ctx, KindProducts, map[string]string{"P1": "a", "P2": "b"})
	e := entry("b1", KindProducts, map[string]string{"P2": "b", "P3": "c"})
	e.Commit.Replace = true
	s.Enqueue(ctx, []Entry{e})
	next, _ := s.Next(ctx)
	if err := s.Complete(ctx, *next); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Fingerprints(ctx, KindProducts)
	if !reflect.DeepEqual(got, map[string]string{"P2": "b", "P3": "c"}) {
		t.Fatalf("huellas = %v", got)
	}
	if n, _ := s.Depth(ctx); n != 0 {
		t.Fatal("el lote debió salir de la cola")
	}
}
