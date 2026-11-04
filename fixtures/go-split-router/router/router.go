package router

import "github.com/labstack/echo/v4"

// New builds the echo instance main registers on.
func New() *echo.Echo {
	e := echo.New()
	return e
}
