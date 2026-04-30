import { EventEmitter } from 'events'

async function initialize() {
  const emitter = new EventEmitter()
  const db = new PrismaClient()
  const router = new express.Router()
  emitter.on('data', handler)
}

new Worker('./worker.js')
