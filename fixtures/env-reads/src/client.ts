export const apiUrl = import.meta.env.VITE_API_URL;

export function mode() {
  if (import.meta.env.DEV) return import.meta.env['VITE_DEBUG_FLAG'];
  const { VITE_SENTRY_DSN, MODE } = import.meta.env;
  return [VITE_SENTRY_DSN, MODE, process.env.NEXT_PUBLIC_SITE_URL];
}
