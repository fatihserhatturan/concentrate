package service

import (
	"fmt"
	"strings"
)

type UserService struct {
	Name string
}

func NewUserService(name string) *UserService {
	return &UserService{Name: strings.TrimSpace(name)}
}

func (s *UserService) GetName() string {
	return s.Name
}

func (s *UserService) Print() {
	fmt.Println(s.Name)
}

func internalHelper(s string) string {
	return strings.ToLower(s)
}
