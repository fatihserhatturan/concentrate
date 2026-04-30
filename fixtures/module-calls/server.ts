import { createServer } from 'http'

const server = createServer()

server.listen(8080)
server.on('error', console.error)

await server.close()
