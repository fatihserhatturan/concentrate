import type { User } from './types'
import type { Request, Response } from 'express'
import { createServer } from 'http'
import { readFile } from 'fs/promises'

export type { User } from './types'

export function handler(req: Request, res: Response) {
  return createServer()
}
