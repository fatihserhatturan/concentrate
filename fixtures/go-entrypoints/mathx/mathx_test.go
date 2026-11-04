package mathx

import "testing"

func TestAdd(t *testing.T) {
	if Add(1, 2) != 3 {
		t.Fatal("add")
	}
}

func BenchmarkAdd(b *testing.B) {
	Add(1, 2)
}

func Testable() {}

func ExampleAdd() {}
