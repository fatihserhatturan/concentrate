export async function saveTodo(title: string) {
  return { title };
}

export function track(event: string) {
  console.log(event);
}
