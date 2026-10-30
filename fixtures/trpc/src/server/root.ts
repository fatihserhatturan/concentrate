import { createTRPCRouter, publicProcedure } from './trpc';
import { postRouter } from './routers/post';
import user from './routers/user';

export const appRouter = createTRPCRouter({
  post: postRouter,
  user,
  health: publicProcedure.query(() => 'ok'),
});

export type AppRouter = typeof appRouter;

// Not a tRPC router: a value that is not a procedure or a router.
export const settings = createTRPCRouter({ retries: 3 });
