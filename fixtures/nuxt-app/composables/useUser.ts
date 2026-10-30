export function useUser(id: string) {
  const name = formatName({ first: 'Ada', last: id });
  return { name };
}
