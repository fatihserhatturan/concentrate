package config

import "github.com/kelseyhightower/envconfig"

type Limits struct {
	Burst int
}

type Spec struct {
	MaxWorkers  int    `split_words:"true"`
	QueueName   string `envconfig:"QUEUE"`
	Secret      string `ignored:"true"`
	Limits      Limits
	internal    string
}

func LoadSpec() (Spec, error) {
	var spec Spec
	err := envconfig.Process("worker", &spec)
	return spec, err
}
