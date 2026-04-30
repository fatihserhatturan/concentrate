import express, { Router } from 'express'
import { PrismaClient } from '@prisma/client'

const app = express()
const db = new PrismaClient()
const router = Router()
let worker = new Worker('worker.js')
const port = 3000

function configure() {
  const local = express()
  return local
}
