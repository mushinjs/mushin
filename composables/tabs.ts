interface SideNav {
  name: string
  path: string
  icon: string
  title?: string
}
export function useAllTabs() {
  const router = useRouter()
  const tabs = router.getRoutes()
    .filter(route => route.path.startsWith('/modules/') && !!route.meta.title)
    .map((nav): SideNav => {
      return {
        name: nav.name as string,
        path: nav.path,
        ...nav.meta,
        icon: nav.meta.icon as string || 'i-carbon:assembly-reference',
      }
    })
  return computed(() => tabs)
}
