export interface Foo {}
export interface Bar {}

export type Dict<T = any, K extends string = string> = { [key in K]: T }
