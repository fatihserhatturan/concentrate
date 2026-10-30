import { queryOptions, useQuery } from '@tanstack/react-query';
import { useQuery as useLegacyQuery } from 'react-query';

// The default query function fetches the key.
export function Todos() {
  return useQuery({ queryKey: ['/api/todos'] });
}

export function Todo({ id }: { id: string }) {
  return useLegacyQuery(`/api/todos/${id}`);
}

export const userQuery = queryOptions({ queryKey: ['/api/user'], staleTime: 1000 });

// Its own queryFn: the fetch inside it is the request.
export function OwnFn() {
  return useQuery({ queryKey: ['todos'], queryFn: () => fetch('/api/todos').then((res) => res.json()) });
}

// A key that is not a URL: no request.
export function Named() {
  return useQuery({ queryKey: ['todos', 'done'] });
}
