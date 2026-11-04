package storage

type base struct{}

func (base) Get(id string) (string, error) {
	return "", nil
}

// Disk gets Get from base.
type Disk struct {
	base
	path string
}

func (d Disk) Put(id, value string) error {
	return nil
}
