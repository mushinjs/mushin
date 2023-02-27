export const hello = () => console.log('Hello, package-1!')

export type Foo<T> = T extends string ? string : T
