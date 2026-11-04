package repo

type Clock interface {
	Now() int64
}

type SystemClock struct{}

func (SystemClock) Now() int64 { return 0 }

// FakeClock also implements Clock: only wire.Bind picks one.
type FakeClock struct{}

func (FakeClock) Now() int64 { return 1 }

type Orders struct {
	clock Clock
}

func NewOrders(clock Clock) *Orders { return &Orders{clock: clock} }
