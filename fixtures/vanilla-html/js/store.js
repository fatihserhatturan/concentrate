function loadTodos() {
  return JSON.parse(localStorage.getItem('todos') || '[]');
}
