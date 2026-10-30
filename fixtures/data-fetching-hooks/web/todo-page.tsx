import useSWR from 'swr';
import { Route, Routes } from 'react-router-dom';

function TodoList() {
  const { data } = useSWR('/api/todos');
  return <ul>{String(data)}</ul>;
}

export function TodoPage() {
  return <TodoList />;
}

export function App() {
  return (
    <Routes>
      <Route path="/todos" element={<TodoPage />} />
    </Routes>
  );
}
