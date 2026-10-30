import useSWR from 'swr';
import useSWRImmutable from 'swr/immutable';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function Profile({ token }: { token: string | null }) {
  const { data: user } = useSWR('/api/user', fetcher);
  const { data: todos } = useSWRImmutable(['/api/todos', token], fetcher);
  // Conditional fetching: the key or null.
  const { data: todo } = useSWR(token ? `/api/todos/${token}` : null, fetcher);
  // Not a URL key: no request.
  const { data: theme } = useSWR('theme', () => localStorage.getItem('theme'));
  return [user, todos, todo, theme];
}
