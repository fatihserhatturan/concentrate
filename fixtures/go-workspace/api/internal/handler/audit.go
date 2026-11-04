package handler

func (h *Handler) audit() {
	h.Log(format("audit"))
}

func format(message string) string {
	return "[" + message + "]"
}
