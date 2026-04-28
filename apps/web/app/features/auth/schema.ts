import { z } from 'zod'

export const uploadTokenHeaderSchema = z
  .string()
  .regex(/^Bearer\s+\S+$/, 'Authorization must use Bearer token')

