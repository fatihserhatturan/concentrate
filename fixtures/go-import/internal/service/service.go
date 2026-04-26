package service

type Service struct {
	Name string
}

func New(name string) *Service {
	return &Service{Name: name}
}
