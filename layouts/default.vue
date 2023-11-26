<template>
  <div w-screen h-screen h-100dvh flex="~" of-hidden>
    <SideNav />
    <main p-4 flex-auto>
      <slot />
    </main>
  </div>
</template>
