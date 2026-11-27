// Package logfile es un io.Writer a archivo con rotación por tamaño. Un
// servicio de Windows no tiene stderr: sin archivo, los logs se pierden.
//
// Rotación: cuando la siguiente escritura haría pasar el archivo del máximo,
// agent.log pasa a agent.log.1, agent.log.1 a .2, etc.; la copia más antigua
// (la número maxBackups) se borra. Con maxBackups = 0 el archivo se trunca.
package logfile

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Writer escribe a un archivo y lo rota. Es seguro para uso concurrente.
type Writer struct {
	mu         sync.Mutex
	path       string
	maxBytes   int64
	maxBackups int
	f          *os.File
	size       int64
}

// Open abre (o crea, con sus carpetas) el archivo en modo anexar. maxBytes <= 0
// desactiva la rotación.
func Open(path string, maxBytes int64, maxBackups int) (*Writer, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("logfile: %w", err)
	}
	w := &Writer{path: path, maxBytes: maxBytes, maxBackups: maxBackups}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *Writer) open() error {
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("logfile: %w", err)
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("logfile: %w", err)
	}
	w.f, w.size = f, st.Size()
	return nil
}

// Write implementa io.Writer. Una escritura nunca se parte entre dos archivos.
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	if w.maxBytes > 0 && w.size > 0 && w.size+int64(len(p)) > w.maxBytes {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *Writer) rotate() error {
	if err := w.f.Close(); err != nil {
		return fmt.Errorf("logfile: %w", err)
	}
	w.f = nil
	if w.maxBackups <= 0 {
		if err := os.Remove(w.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("logfile: %w", err)
		}
		return w.open()
	}
	oldest := fmt.Sprintf("%s.%d", w.path, w.maxBackups)
	if err := os.Remove(oldest); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("logfile: %w", err)
	}
	for i := w.maxBackups - 1; i >= 1; i-- {
		from, to := fmt.Sprintf("%s.%d", w.path, i), fmt.Sprintf("%s.%d", w.path, i+1)
		if err := os.Rename(from, to); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("logfile: %w", err)
		}
	}
	if err := os.Rename(w.path, w.path+".1"); err != nil {
		return fmt.Errorf("logfile: %w", err)
	}
	return w.open()
}

// Close cierra el archivo.
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return nil
	}
	err := w.f.Close()
	w.f = nil
	return err
}
