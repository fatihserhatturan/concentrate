package sample

import (
	"fmt"
	"strings"
)

type Service struct {
	Name string
}

func NewService(name string) *Service {
	return &Service{Name: strings.TrimSpace(name)}
}

func (s *Service) Run() {
	fmt.Println(s.Name)
}
