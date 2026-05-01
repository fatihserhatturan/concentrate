import express from 'express'
import { ADMIN_PATH, USERS_PATH } from './paths'

const API_PREFIX = '/api'
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

function validateUser(req, res, next) {
  next()
}

router.get(USERS_PATH, listUsers)
router.post(USERS_PATH, authenticate, validateUser, createUser)
router.put('/users/:id', [authenticate, validateUser], createUser)
router.delete('/users/:id', async (req, res) => {
  res.status(204).end()
})
router.use(ADMIN_PATH, authenticate, adminRouter)
router.use(authenticate)
adminRouter.get('/dashboard', (ctx) => {
  ctx.body = 'ok'
})

cache.get('not-a-route')
app.use(API_PREFIX, router)
app.listen(3000)
