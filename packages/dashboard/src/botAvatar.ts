/**
 * A bot without a picture of its own (not logged in yet, or its platform has none) shows a coloured
 * initial, the same colour every time for a bot, wherever it is shown.
 */
const avatarColors = ['#5B6CE0', '#2F9E77', '#C46A2B', '#B84C8C', '#3B8FC4', '#8A63D2', '#B5962A', '#D0574F']

export function avatarColor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return avatarColors[hash % avatarColors.length]
}

export const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'
