import { PrismaClient as Client } from '@prisma/client'
import { model as defineModel } from 'mongoose'

const app = express()
const prisma = createPrismaClient()
const aliasedPrisma = new Client()
const usersRepository = createRepository()
const AuditModel = defineModel('Audit')
const Job = createSequelizeModel()
const knex = createKnex()
const plainObject = Object.create(null)

async function listUsers(req, res) {
  const users = await prisma.user.findMany()
  const aliasedUsers = await aliasedPrisma.user.findFirst()
  const audit = await AuditModel.findOne({ type: 'list-users' })
  res.json({ users, aliasedUsers, audit })
}

async function createUser(req, res) {
  const user = await usersRepository.save(req.body)
  await prisma.user.update({ where: { id: user.id }, data: req.body })
  res.status(201).json(user)
}

async function handleJob(job) {
  await Job.destroy({ where: { id: job.id } })
}

class PrismaBackedRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findUsers() {
    return this.prisma.user.findMany()
  }
}

class TypeOrmBackedRepository {
  constructor(private readonly usersRepository: Repository<User>) {}

  async createUser(input) {
    return this.usersRepository.save(input)
  }
}

class MongooseBackedRepository {
  constructor(private readonly AuditModel: Model<Audit>) {}

  async readAudit() {
    return this.AuditModel.findOne({ type: 'nested' })
  }
}

class KnexBackedRepository {
  async listUsers() {
    return knex('users').select()
  }
}

class UserService {
  constructor(private readonly repository: PrismaBackedRepository) {}

  async listViaRepository() {
    return this.repository.findUsers()
  }
}

async function bootstrap() {
  await NestFactory.create(AppModule)
  return plainObject
}

app.get('/users', listUsers)
app.post('/users', createUser)
queue.process('cleanup', handleJob)
