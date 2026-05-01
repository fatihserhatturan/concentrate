import Fastify from 'fastify'

const fastify = Fastify()

function listUsers(request, reply) {
  reply.send([])
}

function createUser(request, reply) {
  reply.code(201).send({})
}

function health(request, reply) {
  reply.send({ ok: true })
}

function usersPlugin(instance, options, done) {
  done()
}

function auth(request, reply, done) {
  done()
}

fastify.get('/users', listUsers)
fastify.post('/users', { preHandler: auth }, createUser)
fastify.get('/inline', async (request, reply) => {
  reply.send({ inline: true })
})
fastify.route({ method: 'GET', url: '/health', handler: health })
fastify.route({ method: ['GET', 'HEAD'], url: '/status', handler: health })
fastify.route({
  method: 'GET',
  url: '/object-inline',
  preHandler: async (request, reply) => {
    request.log.info('pre')
  },
  handler: async (request, reply) => {
    reply.send({ object: true })
  },
})
fastify.register(usersPlugin, { prefix: '/api' })
