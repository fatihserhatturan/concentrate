const { PORT, DATABASE_URL: databaseUrl = 'postgres://localhost', 'REDIS-URL': redis, ...rest } = process.env;

export function start() {
  const { NODE_ENV, LOG_LEVEL = 'info' } = process.env;
  return { PORT, databaseUrl, redis, rest, NODE_ENV, LOG_LEVEL };
}

// Not env: destructuring another object.
const { HOST } = { HOST: 'localhost' };
export { HOST };
