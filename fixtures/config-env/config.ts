export const FEATURE_FLAG = 'FEATURE_USERS'
export const RETRY_LIMIT = 3
export const ENABLE_CACHE = true

const INTERNAL_ONLY = 'hidden'

export function readInternal() {
  return INTERNAL_ONLY
}
