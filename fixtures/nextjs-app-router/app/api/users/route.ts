const users = [{ id: 1, name: 'Ada' }];

function authorize(request: Request) {
  return request.headers.get('authorization') === `Bearer ${process.env.API_TOKEN}`;
}

export async function GET() {
  return Response.json(users.slice(0, Number(process.env.PAGE_SIZE ?? 20)));
}

export async function POST(request: Request) {
  if (!authorize(request)) return new Response(null, { status: 401 });
  return Response.json(await request.json(), { status: 201 });
}
