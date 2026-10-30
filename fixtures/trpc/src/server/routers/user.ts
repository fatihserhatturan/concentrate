import { publicProcedure, createTRPCRouter } from '../trpc';

const userRouter = createTRPCRouter({
  me: publicProcedure.query(() => null),
});

export default userRouter;
