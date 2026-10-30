import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

// Wrapped middleware: handled by the function passed inline.
export default withAuth(
  async function middleware(req) {
    return req.nextUrl.pathname.startsWith('/login') ? NextResponse.next() : null;
  },
  { callbacks: { authorized: () => true } },
);

export const config = {
  matcher: ['/dashboard/:path*', '/login'],
};
