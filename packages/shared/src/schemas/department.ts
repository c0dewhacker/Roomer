import { z } from 'zod'

// .trim() must run BEFORE .min(1) — zod applies string checks in chain order,
// so min(1) against the raw untrimmed input let a whitespace-only name like
// " " (length 1) pass validation and then get silently trimmed to "",
// creating a blank-named department with no error ever surfaced.
export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1, 'Department name is required').max(255),
})

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
})

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>
