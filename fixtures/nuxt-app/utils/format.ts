export function formatName(user: { first: string; last: string }) {
  return `${user.first} ${user.last}`;
}
