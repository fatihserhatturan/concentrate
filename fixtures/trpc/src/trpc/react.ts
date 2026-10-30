import { createTRPCReact } from '@trpc/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import type { AppRouter } from '~/server/root';

export const api = createTRPCReact<AppRouter>();
export const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: '/api/trpc' })] });
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();
