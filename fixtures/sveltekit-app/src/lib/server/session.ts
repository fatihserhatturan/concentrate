export function login(email: string) {
  return { email };
}

export function logout(token: string) {
  return token.length > 0;
}
