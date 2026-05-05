import { z } from 'zod'

export const createDepartmentSchema = z.object({
  name: z.string().min(1, 'Department name is required').max(255),
  parentId: z.string().optional(),
})

export const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parentId: z.string().nullable().optional(),
})

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>
