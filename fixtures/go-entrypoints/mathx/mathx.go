package mathx

func Add(a, b int) int {
	return clamp(a + b)
}

func Subtract(a, b int) int {
	return a - b
}

func clamp(value int) int {
	return value
}

func forgotten() int {
	return 0
}
