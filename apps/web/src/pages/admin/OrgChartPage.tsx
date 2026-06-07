import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Network, Info } from 'lucide-react'
import { orgApi } from '@/lib/api'
import { OrgChartCanvas, type OrgNode } from '@/components/org/OrgChartCanvas'
import { Skeleton } from '@/components/ui/skeleton'

export default function OrgChartPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['org', 'hierarchy'],
    queryFn: () => orgApi.hierarchy(),
    select: (r) => r.data,
  })

  const [selectedPerson, setSelectedPerson] = useState<string | null>(null)
  const [selectedDept, setSelectedDept] = useState<string | null>(null)

  const deptName = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of data?.departments ?? []) m.set(d.id, d.name)
    return m
  }, [data])

  const peopleNodes: OrgNode[] = useMemo(
    () => (data?.people ?? []).map((p) => ({
      id: p.id,
      label: p.displayName,
      sublabel: p.departmentId ? deptName.get(p.departmentId) : undefined,
      parentId: p.managerId,
    })),
    [data, deptName],
  )

  const deptNodes: OrgNode[] = useMemo(
    () => (data?.departments ?? []).map((d) => ({
      id: d.id,
      label: d.name,
      sublabel: `${d.memberCount} ${d.memberCount === 1 ? 'person' : 'people'}`,
      parentId: d.inferredParentId,
    })),
    [data],
  )

  const totalPeople = data?.people.length ?? 0
  const resolved = totalPeople - (data?.unresolvedManagers ?? 0)

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <Network className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Org chart</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Hierarchy inferred from each user's manager (synced from your identity provider). Departments on the right are derived from where their people report.
      </p>

      {data && data.unresolvedManagers > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            {resolved} of {totalPeople} users have a resolved manager. The rest appear as top-level nodes — configure the manager attribute/claim for your provider and run a sync to link them.
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-[560px] w-full" />
          <Skeleton className="h-[560px] w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <p className="text-sm font-medium mb-1.5">People</p>
            <OrgChartCanvas nodes={peopleNodes} highlightId={selectedPerson} onSelect={setSelectedPerson} accent="#6366f1" />
          </div>
          <div>
            <p className="text-sm font-medium mb-1.5">Departments</p>
            <OrgChartCanvas nodes={deptNodes} highlightId={selectedDept} onSelect={setSelectedDept} accent="#0ea5e9" />
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground mt-2">Scroll to zoom · drag to pan · click a node to highlight.</p>
    </div>
  )
}
