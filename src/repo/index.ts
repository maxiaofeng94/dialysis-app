import { localRepository } from './localRepository'
import type { Repository } from './repository'

export const repository: Repository = localRepository
export type { Repository }
