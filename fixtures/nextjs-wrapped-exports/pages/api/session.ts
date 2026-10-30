import NextAuth from 'next-auth';

// Held in a variable built by a library call: a route without a handler.
const handler = NextAuth({ providers: [] });

export default handler;
