import type { Context, Plugin } from 'package-1'
export * from 'package-2'
export const name = 'plugin-1'

export const install = (ctx: Context) => {

}

// import { definePlugin } from 'package-1'
// definePlugin(<Plugin>{
//   name: 'plugin-1',
// })
