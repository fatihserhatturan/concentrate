package storage

type Memory struct {
	items map[string]string
}

func NewMemory() *Memory {
	return &Memory{items: map[string]string{}}
}

func (m *Memory) Get(id string) (string, error) {
	return m.items[id], nil
}

func (m *Memory) Put(id, value string) error {
	m.items[id] = value
	return nil
}
