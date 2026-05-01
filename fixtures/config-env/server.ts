import { FEATURE_FLAG, RETRY_LIMIT } from './config'

const app = express()
const token = process.env.API_TOKEN

function listUsers(req, res) {
  const databaseUrl = process.env['DATABASE_URL']
  if (process.env.NODE_ENV === 'production') {
    res.set('x-feature', FEATURE_FLAG)
  }
  res.json({ retries: RETRY_LIMIT, databaseUrl, token })
}

app.get('/users', listUsers)
