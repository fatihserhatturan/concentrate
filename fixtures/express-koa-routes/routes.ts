import express from 'express'

const app = express()
const router = express.Router()
const adminRouter = express.Router()
const cache = new Map()

function listUsers(req, res) {
  res.json([])
}

function createUser(req, res) {
  res.status(201).json({})
}

function authenticate(req, res, next) {
  next()
}

router.get('/users', listUsers)
router.post('/users', authenticate, createUser)
router.delete('/users/:id', async (req, res) => {
  res.status(204).end()
})
router.use('/admin', authenticate, adminRouter)
router.use(authenticate)
adminRouter.get('/dashboard', (ctx) => {
  ctx.body = 'ok'
})

cache.get('not-a-route')
app.use('/api', router)
app.listen(3000)
