import { NextResponse, type NextRequest } from 'next/server';

// No matcher: runs for every request.
export default function auth(request: NextRequest) {
  return request.nextUrl.pathname.startsWith('/admin') ? NextResponse.redirect(new URL('/', request.url)) : NextResponse.next();
}
