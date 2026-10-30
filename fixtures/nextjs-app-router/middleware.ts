import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  if (!request.cookies.has('session')) return NextResponse.redirect(new URL('/', request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', { source: '/api/:path*', missing: [{ type: 'header', key: 'x-skip' }] }],
};
