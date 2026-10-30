const Fastify = require('fastify');

function loadUser(id) {
  return { id };
}

function audit(event) {
  return event;
}

// Inline handlers of routes declared inside a plugin get their own Function
// node, so the route links to them and their calls are theirs.
async function accounts(fastify, opts) {
  fastify.get('/accounts/:id', async (request) => loadUser(request.params.id));
  fastify.post('/accounts', async (request, reply) => {
    audit('create');
    reply.code(201).send(request.body);
  });
  // Not a route: callbacks of other calls stay part of the plugin.
  await Promise.resolve().then(() => audit('ready'));
}

function build() {
  const app = Fastify();
  app.register(accounts, { prefix: '/v2' });
  return app;
}

module.exports = build;
