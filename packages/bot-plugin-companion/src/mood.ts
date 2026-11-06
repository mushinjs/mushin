/** How the bot feels and whether it is awake: what a person brings to a chat besides the words. */

/** A mood fades back to calm after this long without a new one. */
export const MOOD_FADE = 30 * 60_000
export const CALM = '平静'
/** What a mood the planner names may be: a few characters. */
const MOOD_CHARS = 6
export const SLEEPY = '困，刚被吵醒'

/** The bot's mood in one chat, as the planner last named it. */
export class Mood {
  private value = CALM
  private at = 0

  /** Takes the planner's word for the mood, when it gave a short one. */
  set(mood: string | undefined, now: number) {
    const value = mood?.trim()
    if (!value || value.length > MOOD_CHARS) return
    this.value = value
    this.at = now
  }

  current(now: number) {
    return now - this.at > MOOD_FADE ? CALM : this.value
  }
}

/** Minutes after midnight of `HH:MM`. */
const minutes = (value: string) => {
  const [hours, mins] = value.split(':').map(Number)
  return hours * 60 + mins
}

export const QUIET_HOURS = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/

/** Whether a time falls in `HH:MM-HH:MM` (local time; it may wrap past midnight). */
export function asleep(quietHours: string | undefined, time: number) {
  if (!quietHours || !QUIET_HOURS.test(quietHours)) return false
  const [from, to] = quietHours.split('-').map(minutes)
  const date = new Date(time)
  const now = date.getHours() * 60 + date.getMinutes()
  return from <= to ? now >= from && now < to : now >= from || now < to
}
