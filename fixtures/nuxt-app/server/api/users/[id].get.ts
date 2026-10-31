async function getUser(event: { context: { params: { id: string } } }) {
  return { id: event.context.params.id };
}

export default defineEventHandler(getUser);
