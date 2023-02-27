/**
 * Transform the backslash to slash
 *
 * '\\\\src\\\\index.ts' -> '/src/index.ts'
*/
export const slash = (str: string) => {
  return str.replace(/\\/g, '/')
}
