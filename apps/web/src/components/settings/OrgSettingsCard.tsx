import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { settingsApi } from '@/lib/api'
import { DATE_FORMAT_OPTIONS } from '@/lib/dateFormat'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CollapsibleCard } from './CollapsibleCard'

const orgSchema = z.object({
  name: z.string().min(1, 'Organisation name is required'),
  defaultBookingDurationHours: z.coerce.number().int().min(1).max(24),
  maxAdvanceBookingDays: z.coerce.number().int().min(1).max(365),
  maxBookingsPerUser: z.coerce.number().int().min(1).max(100),
  queueClaimWindowHours: z.coerce.number().int().min(1).max(48),
  dateFormat: z.string().min(1),
  noShowReleaseEnabled: z.boolean(),
  checkInGraceMinutes: z.coerce.number().int().min(5).max(240),
})
type OrgForm = z.infer<typeof orgSchema>

export function OrgSettingsCard() {
  const qc = useQueryClient()
  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isDirty } } = useForm<OrgForm>({
    resolver: zodResolver(orgSchema) as Resolver<OrgForm>,
    defaultValues: {
      name: 'Roomer',
      defaultBookingDurationHours: 8,
      maxAdvanceBookingDays: 14,
      maxBookingsPerUser: 5,
      queueClaimWindowHours: 4,
      dateFormat: 'dd/MM/yyyy',
      noShowReleaseEnabled: false,
      checkInGraceMinutes: 30,
    },
  })

  const { data: orgData } = useQuery({
    queryKey: ['settings', 'organisation'],
    queryFn: () => settingsApi.getOrg(),
    select: (r) => r.data,
  })

  useEffect(() => {
    if (orgData) {
      reset({
        name: orgData.name,
        defaultBookingDurationHours: orgData.defaultBookingDurationHours,
        maxAdvanceBookingDays: orgData.maxAdvanceBookingDays,
        maxBookingsPerUser: orgData.maxBookingsPerUser,
        queueClaimWindowHours: orgData.queueClaimWindowHours ?? 4,
        dateFormat: orgData.dateFormat ?? 'dd/MM/yyyy',
        noShowReleaseEnabled: orgData.noShowReleaseEnabled ?? false,
        checkInGraceMinutes: orgData.checkInGraceMinutes ?? 30,
      })
    }
  }, [orgData, reset])

  const save = useMutation({
    mutationFn: (data: OrgForm) => settingsApi.updateOrg(data),
    onSuccess: (res) => {
      toast.success('Settings saved')
      reset({ name: res.data.name, defaultBookingDurationHours: res.data.defaultBookingDurationHours, maxAdvanceBookingDays: res.data.maxAdvanceBookingDays, maxBookingsPerUser: res.data.maxBookingsPerUser, queueClaimWindowHours: res.data.queueClaimWindowHours ?? 4, dateFormat: res.data.dateFormat ?? 'dd/MM/yyyy', noShowReleaseEnabled: res.data.noShowReleaseEnabled ?? false, checkInGraceMinutes: res.data.checkInGraceMinutes ?? 30 })
      qc.invalidateQueries({ queryKey: ['settings', 'organisation'] })
      qc.invalidateQueries({ queryKey: ['settings', 'public'] })
    },
    onError: () => toast.error('Failed to save settings'),
  })

  return (
    <CollapsibleCard title="Organisation" description="General settings for your Roomer workspace">
      <form onSubmit={handleSubmit((d: OrgForm) => save.mutate(d))} className="space-y-4">
        <div>
          <Label htmlFor="orgName">Organisation name *</Label>
          <Input id="orgName" {...register('name')} className="mt-1.5 max-w-sm" />
          {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <Label htmlFor="defaultDuration">Default booking (hours)</Label>
            <Input id="defaultDuration" type="number" min={1} max={24} {...register('defaultBookingDurationHours')} className="mt-1.5" />
            {errors.defaultBookingDurationHours && (
              <p className="text-xs text-destructive mt-1">{errors.defaultBookingDurationHours.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="advanceDays">Max advance booking (days)</Label>
            <Input id="advanceDays" type="number" min={1} max={365} {...register('maxAdvanceBookingDays')} className="mt-1.5" />
            {errors.maxAdvanceBookingDays && (
              <p className="text-xs text-destructive mt-1">{errors.maxAdvanceBookingDays.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="maxBookings">Max bookings per user</Label>
            <Input id="maxBookings" type="number" min={1} max={100} {...register('maxBookingsPerUser')} className="mt-1.5" />
            {errors.maxBookingsPerUser && (
              <p className="text-xs text-destructive mt-1">{errors.maxBookingsPerUser.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="queueClaimWindow">Queue claim window (hours)</Label>
            <Input id="queueClaimWindow" type="number" min={1} max={48} {...register('queueClaimWindowHours')} className="mt-1.5" />
            <p className="text-xs text-muted-foreground mt-1">How long an assigned user's queue promotion stays open before passing to the next person.</p>
            {errors.queueClaimWindowHours && (
              <p className="text-xs text-destructive mt-1">{errors.queueClaimWindowHours.message}</p>
            )}
          </div>
        </div>
        <div className="rounded-md border p-3 space-y-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={watch('noShowReleaseEnabled')}
              onChange={(e) => setValue('noShowReleaseEnabled', e.target.checked, { shouldDirty: true })}
            />
            <span>
              <span className="text-sm font-medium">Release no-show bookings</span>
              <span className="block text-xs text-muted-foreground">
                Auto-cancel a booking if the user hasn't checked in within the grace period, freeing the desk and promoting the queue. Permanently-assigned desks are exempt. Buildings and floors can override this default.
              </span>
            </span>
          </label>
          <div className="max-w-[200px]">
            <Label htmlFor="grace" className="text-xs">Check-in grace (minutes)</Label>
            <Input id="grace" type="number" min={5} max={240} {...register('checkInGraceMinutes')} className="mt-1.5" disabled={!watch('noShowReleaseEnabled')} />
            {errors.checkInGraceMinutes && (
              <p className="text-xs text-destructive mt-1">{errors.checkInGraceMinutes.message}</p>
            )}
          </div>
        </div>
        <div>
          <Label htmlFor="dateFormat">Date format</Label>
          <Select value={watch('dateFormat')} onValueChange={(v) => setValue('dateFormat', v, { shouldDirty: true })}>
            <SelectTrigger id="dateFormat" className="mt-1.5 max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_FORMAT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">Controls how dates are displayed across the platform.</p>
        </div>
        <Button type="submit" size="sm" disabled={!isDirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </CollapsibleCard>
  )
}
