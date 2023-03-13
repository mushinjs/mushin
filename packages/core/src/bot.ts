export interface Bot {
  platform: string
  selfId: string
}

export interface Event {

}
export interface Action {

}
export interface Message {
  segments: Segment[]
  from: string
  to: string
}
export interface SegmentType {

}
export interface Segment {
  type: string
  text?: string
  file?: string
}

export function createBot(selfIds: string[]): Bot[]
export function createBot(selfId: string): Bot
export function createBot(query: any): Bot | Bot[] {
  if (typeof query === 'string') {
    return {
      platform: 'onebot',
      selfId: 'selfId',
    }
  }
  return query.map((selfId: string) => createBot(selfId))
}
