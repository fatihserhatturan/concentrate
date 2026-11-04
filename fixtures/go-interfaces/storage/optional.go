package storage

type Optional[T any] struct {
	Set   bool
	Value T
}

func (o Optional[T]) IsSet() bool {
	return o.Set
}

func (o *Optional[T]) Clear() {
	o.Set = false
}
