package logfile

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("leer %s: %v", p, err)
	}
	return string(b)
}

func TestWriteCreaDirectorioYArchivo(t *testing.T) {
	p := filepath.Join(t.TempDir(), "logs", "sub", "agent.log")
	w, err := Open(p, 1024, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if _, err := w.Write([]byte("hola\n")); err != nil {
		t.Fatal(err)
	}
	if got := read(t, p); got != "hola\n" {
		t.Fatalf("contenido = %q", got)
	}
}

func TestAnexaAlReabrir(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.log")
	for _, line := range []string{"uno\n", "dos\n"} {
		w, err := Open(p, 1024, 3)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(line))
		w.Close()
	}
	if got := read(t, p); got != "uno\ndos\n" {
		t.Fatalf("contenido = %q", got)
	}
}

func TestRotaAlSuperarElTamano(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "agent.log")
	w, err := Open(p, 10, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	for _, line := range []string{"aaaaaa\n", "bbbbbb\n", "cccccc\n"} { // 7 bytes cada una
		if _, err := w.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	if got := read(t, p); got != "cccccc\n" {
		t.Fatalf("actual = %q", got)
	}
	if got := read(t, p+".1"); got != "bbbbbb\n" {
		t.Fatalf(".1 = %q", got)
	}
	if got := read(t, p+".2"); got != "aaaaaa\n" {
		t.Fatalf(".2 = %q", got)
	}
}

func TestRespetaMaxBackups(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "agent.log")
	w, err := Open(p, 5, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	for i := 0; i < 6; i++ {
		w.Write([]byte(strings.Repeat("x", 6))) // cada escritura supera el máximo
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 { // agent.log, .1 y .2
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("archivos = %v, quería 3", names)
	}
	if _, err := os.Stat(p + ".3"); !os.IsNotExist(err) {
		t.Fatalf("no debe existir .3: %v", err)
	}
}

func TestUnaEscrituraMayorQueElMaximoNoSePierde(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.log")
	w, _ := Open(p, 4, 1)
	defer w.Close()
	big := strings.Repeat("z", 50)
	if n, err := w.Write([]byte(big)); err != nil || n != 50 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if got := read(t, p); got != big {
		t.Fatalf("se perdió contenido: %q", got)
	}
}

func TestSinBackupsTrunca(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "agent.log")
	w, _ := Open(p, 5, 0)
	defer w.Close()
	w.Write([]byte("111111"))
	w.Write([]byte("222222"))
	if got := read(t, p); got != "222222" {
		t.Fatalf("actual = %q", got)
	}
	if _, err := os.Stat(p + ".1"); !os.IsNotExist(err) {
		t.Fatal("con max_backups=0 no debe haber copias")
	}
}

func TestConcurrente(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.log")
	w, _ := Open(p, 1<<20, 1)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				w.Write([]byte("linea\n"))
			}
		}()
	}
	wg.Wait()
	w.Close()
	if got := strings.Count(read(t, p), "linea\n"); got != 1000 {
		t.Fatalf("líneas = %d, quería 1000", got)
	}
}

func TestOpenFallaSiLaRutaEsUnDirectorio(t *testing.T) {
	if _, err := Open(t.TempDir(), 10, 1); err == nil {
		t.Fatal("esperaba error al abrir un directorio como archivo")
	}
}
