import { rm } from 'fs/promises'

export const removeFiles = (path: string, options: any) => {
  return rm(path, options)
}

/**
 * Transform the backslash to slash
 *
 * '\\src\\index.ts' -> '/src/index.ts'
*/
export const slash = (str: string) => {
  return str.replace(/\\/g, '/')
}
