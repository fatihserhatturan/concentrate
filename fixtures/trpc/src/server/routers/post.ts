import { z } from 'zod';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '~/server/trpc';

export const postRouter = createTRPCRouter({
  all: publicProcedure.query(() => []),
  byId: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => input.id),
  create: protectedProcedure.input(z.string()).mutation(({ input }) => input),
  comments: createTRPCRouter({
    list: publicProcedure.query(() => []),
  }),
  onAdd: publicProcedure.subscription(() => null),
});
