import { resolve } from 'path'
import { rm } from 'fs/promises'
import { createRepo } from '../../src'

export const removeFiles = (path: string, options: any) => {
  return rm(path, options)
}
