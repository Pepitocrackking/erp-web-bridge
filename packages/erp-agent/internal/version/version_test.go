package version

import "testing"

func TestStringIncluyeNombreYVersion(t *testing.T) {
	got := String()
	want := "erp-agent " + Version
	if got != want {
		t.Fatalf("String() = %q, quiero %q", got, want)
	}
}
