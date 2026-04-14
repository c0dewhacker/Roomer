import { z } from 'zod'

// Accept any non-empty string for 'email' — LDAP configs may use sAMAccountName
// or other non-email identifiers as the search filter placeholder.
export const loginSchema = z.object({
  email: z.string().min(1, 'Username or email is required'),
  password: z.string().min(1, 'Password is required'),
})

export type LoginInput = z.infer<typeof loginSchema>
