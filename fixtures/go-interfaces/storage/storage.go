package storage

import "io"

type Reader interface {
	Get(id string) (string, error)
}

type Store interface {
	Reader
	Put(id, value string) error
	io.Closer
}

type Cache interface {
	Reader
}

type Number interface {
	~int | ~float64
}

type ID = string

type Count int

func (c Count) Double() Count {
	return c * 2
}

type Pair[K comparable, V any] struct {
	Key   K
	Value V
}

func Sum[T Number](values []T) T {
	var total T
	return total
}
