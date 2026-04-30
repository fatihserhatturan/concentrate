import express from 'express'

const router = express.Router()

router.get('/users', async (req, res) => {
  res.json([])
})

router.post('/users', (req, res) => {
  res.status(201).json({})
})

router.delete('/users/:id', async (req, res) => {
  res.status(204).end()
})

router.use('/users', authenticate, async (req, res, next) => {
  next()
})

export default router
