package faults

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestCorruptBody(t *testing.T) {
	original := []byte(`{"id":1,"name":"garden","tags":["a","b"]}`)
	if !json.Valid(original) {
		t.Fatal("fixture should be valid JSON")
	}
	got := CorruptBody(original)
	if json.Valid(got) || bytes.Equal(got, original) {
		t.Error("corrupted body should no longer parse")
	}
	if !bytes.HasPrefix(CorruptBody([]byte("abcdefgh")), []byte("abcd")) {
		t.Error("the start of the body is kept")
	}
	if len(CorruptBody([]byte("a"))) <= 1 {
		t.Error("a one-byte body still gets junk appended")
	}
	if string(CorruptBody(nil)) != `{"chaos":` {
		t.Error("an empty body becomes a broken JSON fragment")
	}
}
