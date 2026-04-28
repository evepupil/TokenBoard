import { z } from 'zod'

export const usageSourceSchema = z.enum(['claude-code', 'codex'])

