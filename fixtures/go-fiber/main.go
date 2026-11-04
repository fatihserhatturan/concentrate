package main

import "github.com/gofiber/fiber/v2"

func list(c *fiber.Ctx) error {
	return nil
}

func show(c *fiber.Ctx) error {
	return nil
}

func auth(c *fiber.Ctx) error {
	return c.Next()
}

func main() {
	app := fiber.New()
	app.Use(auth)
	app.Get("/", list)

	api := app.Group("/api", auth)
	api.Get("/items", list)
	api.Post("/items", auth, show)

	app.Route("/v2", func(r fiber.Router) {
		r.Get("/items", show)
	})

	app.Add("PUT", "/items/:id", show)
	app.All("/any", list)
	app.Mount("/sub", subApp())

	app.Listen(":3000")
}

func subApp() *fiber.App {
	sub := fiber.New()
	sub.Get("/ping", list)
	return sub
}
