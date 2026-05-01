const app = express()
const prisma = createPrismaClient()
const usersRepository = createRepository()
const AuditModel = createModel()
const Job = createSequelizeModel()
const plainObject = Object.create(null)

async function listUsers(req, res) {
  const users = await prisma.user.findMany()
  const audit = await AuditModel.findOne({ type: 'list-users' })
  res.json({ users, audit })
}

async function createUser(req, res) {
  const user = await usersRepository.save(req.body)
  await prisma.user.update({ where: { id: user.id }, data: req.body })
  res.status(201).json(user)
}

async function handleJob(job) {
  await Job.destroy({ where: { id: job.id } })
}

async function bootstrap() {
  await NestFactory.create(AppModule)
  return plainObject
}

app.get('/users', listUsers)
app.post('/users', createUser)
queue.process('cleanup', handleJob)
