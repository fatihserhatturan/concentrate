package config

import "github.com/caarlos0/env/v11"

type Database struct {
	URL      string `env:"URL,required"`
	MaxConns int    `env:"MAX_CONNS" envDefault:"10"`
}

type Config struct {
	Port     int      `env:"PORT" envDefault:"8080"`
	Database Database `envPrefix:"DATABASE_"`
	Name     string
}

func Load() (Config, error) {
	var cfg Config
	err := env.Parse(&cfg)
	return cfg, err
}
