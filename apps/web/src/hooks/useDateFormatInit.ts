import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { settingsApi } from '@/lib/api'
import { setDateFormat } from '@/lib/dateFormat'

export function useDateFormatInit(): void {
  const { data } = useQuery({
    queryKey: ['settings', 'public'],
    queryFn: () => settingsApi.getPublic(),
    select: (r) => r.data,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (data?.dateFormat) {
      setDateFormat(data.dateFormat)
    }
  }, [data?.dateFormat])
}
