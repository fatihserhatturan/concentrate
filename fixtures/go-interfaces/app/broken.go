package app

func helper() string {
	return "ok"
}

func broken() {
	x := 1 +
}

func caller() {
	helper()
}
