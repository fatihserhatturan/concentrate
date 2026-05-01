import { EventEmitter } from 'node:events'
import cron from 'node-cron'
import { Cron } from '@nestjs/schedule'

const emitter = new EventEmitter()
const queue = createQueue()
const io = createSocketServer()

function handleData(payload) {
  return payload.id
}

function handleJob(job) {
  return job.id
}

function handleConnection(socket) {
  socket.emit('ready')
}

emitter.on('data', handleData)
queue.process('email', handleJob)
cron.schedule('*/5 * * * *', async () => {
  handleJob({ id: 'scheduled' })
})
io.on('connection', handleConnection)

class TasksService {
  @Cron('0 * * * *')
  syncUsers() {
    handleJob({ id: 'nestjs' })
  }
}
